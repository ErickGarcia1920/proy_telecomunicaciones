'use strict';
/**
 * Servidor RADIUS (RFC 2865 autenticación, RFC 2866 contabilidad) para el portal
 * cautivo de pfSense. Soporta PAP, Message-Authenticator (RFC 3579) y devuelve
 * Session-Timeout, Idle-Timeout, Acct-Interim-Interval y límites de velocidad WISPr.
 */
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const net = require('node:net');
const { verifyPassword } = require('./credentials');
const { byId } = require('./plans');

const CODE = { ACCESS_REQUEST: 1, ACCESS_ACCEPT: 2, ACCESS_REJECT: 3, ACCT_REQUEST: 4, ACCT_RESPONSE: 5 };
const ATTR = {
  USER_NAME: 1, USER_PASSWORD: 2, FRAMED_IP: 8, REPLY_MESSAGE: 18, VENDOR_SPECIFIC: 26,
  SESSION_TIMEOUT: 27, IDLE_TIMEOUT: 28, CALLING_STATION_ID: 31,
  ACCT_STATUS_TYPE: 40, ACCT_INPUT_OCTETS: 42, ACCT_OUTPUT_OCTETS: 43, ACCT_SESSION_ID: 44,
  ACCT_SESSION_TIME: 46, ACCT_INPUT_GIGAWORDS: 52, ACCT_OUTPUT_GIGAWORDS: 53,
  ACCT_INTERIM_INTERVAL: 85, MESSAGE_AUTHENTICATOR: 80,
};
const ACCT_STATUS = { START: 1, STOP: 2, INTERIM: 3 };
const VENDOR_WISPR = 14122;
const WISPR = { MAX_UP: 7, MAX_DOWN: 8 };

const md5 = (...bufs) => { const h = crypto.createHash('md5'); bufs.forEach((b) => h.update(b)); return h.digest(); };

// ---------- Codificación y decodificación de paquetes ----------

function parsePacket(buf) {
  if (buf.length < 20) throw new Error('paquete demasiado corto');
  const length = buf.readUInt16BE(2);
  if (length < 20 || length > 4096 || length > buf.length) throw new Error('longitud inválida');
  const attrs = [];
  let off = 20;
  while (off < length) {
    if (off + 2 > length) throw new Error('atributo truncado');
    const type = buf[off];
    const len = buf[off + 1];
    if (len < 2 || off + len > length) throw new Error('longitud de atributo inválida');
    attrs.push({ type, value: buf.subarray(off + 2, off + len), offset: off });
    off += len;
  }
  return { code: buf[0], id: buf[1], length, authenticator: buf.subarray(4, 20), attrs, raw: buf.subarray(0, length) };
}

const getAttr = (pkt, type) => pkt.attrs.find((a) => a.type === type);

function attr(type, value) {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  if (v.length > 253) throw new Error('atributo demasiado largo');
  return Buffer.concat([Buffer.from([type, v.length + 2]), v]);
}
const attrInt = (type, n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return attr(type, b); };
function vendorAttrInt(vendorId, vendorType, n) {
  const inner = Buffer.alloc(6);
  inner.writeUInt8(vendorType, 0);
  inner.writeUInt8(6, 1);
  inner.writeUInt32BE(n >>> 0, 2);
  const v = Buffer.alloc(4); v.writeUInt32BE(vendorId);
  return attr(ATTR.VENDOR_SPECIFIC, Buffer.concat([v, inner]));
}

/** Descifra User-Password según RFC 2865 §5.2. */
function decryptPassword(encrypted, requestAuth, secret) {
  if (encrypted.length === 0 || encrypted.length % 16 !== 0 || encrypted.length > 128) throw new Error('User-Password inválido');
  const out = Buffer.alloc(encrypted.length);
  let prev = requestAuth;
  for (let i = 0; i < encrypted.length; i += 16) {
    const block = encrypted.subarray(i, i + 16);
    const b = md5(Buffer.from(secret), prev);
    for (let j = 0; j < 16; j++) out[i + j] = block[j] ^ b[j];
    prev = block;
  }
  let end = out.length;
  while (end > 0 && out[end - 1] === 0) end--;
  return out.subarray(0, end).toString('utf8');
}

function verifyMessageAuthenticator(pkt, secret) {
  const ma = getAttr(pkt, ATTR.MESSAGE_AUTHENTICATOR);
  if (!ma) return true;
  if (ma.value.length !== 16) return false;
  const copy = Buffer.from(pkt.raw);
  copy.fill(0, ma.offset + 2, ma.offset + 18);
  const expected = crypto.createHmac('md5', secret).update(copy).digest();
  return crypto.timingSafeEqual(expected, ma.value);
}

function verifyAccountingAuthenticator(pkt, secret) {
  const copy = Buffer.from(pkt.raw);
  copy.fill(0, 4, 20);
  const expected = md5(copy, Buffer.from(secret));
  return crypto.timingSafeEqual(expected, pkt.authenticator);
}

function buildResponse(code, req, attrBufs, secret, withMessageAuth) {
  let body = Buffer.concat(attrBufs);
  const header = (len, authenticator) => {
    const h = Buffer.alloc(20);
    h[0] = code; h[1] = req.id; h.writeUInt16BE(len, 2);
    authenticator.copy(h, 4);
    return h;
  };
  if (withMessageAuth) {
    const placeholder = attr(ATTR.MESSAGE_AUTHENTICATOR, Buffer.alloc(16));
    body = Buffer.concat([body, placeholder]);
    const len = 20 + body.length;
    const hmac = crypto.createHmac('md5', secret).update(Buffer.concat([header(len, req.authenticator), body])).digest();
    hmac.copy(body, body.length - 16);
  }
  const len = 20 + body.length;
  const respAuth = md5(header(len, req.authenticator), body, Buffer.from(secret));
  return Buffer.concat([header(len, respAuth), body]);
}

// ---------- Control de acceso por dirección de origen ----------

function ipv4ToInt(ip) { return ip.split('.').reduce((a, o) => ((a << 8) + Number(o)) >>> 0, 0); }
function normalizeIp(ip) { return ip.startsWith('::ffff:') ? ip.slice(7) : ip; }

function sourceAllowed(address, rules) {
  if (!rules.length) return true;
  const ip = normalizeIp(address);
  return rules.some((rule) => {
    const [base, bits] = rule.split('/');
    if (net.isIPv4(base) && net.isIPv4(ip)) {
      const mask = bits === undefined ? 0xffffffff : (bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0);
      return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
    }
    if (net.isIPv6(base) && net.isIPv6(ip)) {
      if (bits === undefined || Number(bits) === 128) return ip.toLowerCase() === base.toLowerCase();
      const toBigInt = (a) => BigInt('0x' + expandIPv6(a));
      const mask = (~((1n << BigInt(128 - Number(bits))) - 1n)) & ((1n << 128n) - 1n);
      return (toBigInt(ip) & mask) === (toBigInt(base) & mask);
    }
    return false;
  });
}
function expandIPv6(addr) {
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((x) => x.padStart(4, '0')).join('');
}

// ---------- Servidor ----------

function startRadius({ config, store, metrics, logger = console }) {
  const { radius } = config;
  const secret = radius.secret;
  const sockets = [];

  const now = () => Date.now();
  const staleMs = radius.interimSeconds * 3 * 1000;

  function activeSessionsOf(account) {
    const t = now();
    return Object.entries(account.sessions || {}).filter(([, s]) => t - s.lastSeen <= staleMs);
  }

  function remainingSeconds(account) {
    return Math.max(0, account.totalSeconds - account.usedSeconds);
  }

  function reject(req, rinfo, reason) {
    store.counters.rejected += 1;
    metrics.radiusReject(reason);
    const attrs = [attr(ATTR.REPLY_MESSAGE, reason)];
    return buildResponse(CODE.ACCESS_REJECT, req, attrs, secret, !!getAttr(req, ATTR.MESSAGE_AUTHENTICATOR));
  }

  function handleAccess(pkt, rinfo) {
    if (!verifyMessageAuthenticator(pkt, secret)) return null; // se descarta en silencio
    const userAttr = getAttr(pkt, ATTR.USER_NAME);
    const passAttr = getAttr(pkt, ATTR.USER_PASSWORD);
    if (!userAttr || !passAttr) return reject(pkt, rinfo, 'Solicitud incompleta');

    const username = userAttr.value.toString('utf8');
    let password;
    try { password = decryptPassword(passAttr.value, pkt.authenticator, secret); }
    catch { return null; }

    const account = store.accounts.get(username);
    // Se hace siempre una verificación de hash para no revelar por tiempo si el usuario existe.
    const dummy = '00000000000000000000000000000000:' + '0'.repeat(64);
    const okPass = verifyPassword(password, account ? account.passHash : dummy);
    if (!account || !okPass) return reject(pkt, rinfo, 'Usuario o contraseña incorrectos');
    if (account.status !== 'active') return reject(pkt, rinfo, 'Cuenta desactivada');
    if (now() > account.expiresAt) return reject(pkt, rinfo, 'Tu paquete venció');
    const remaining = remainingSeconds(account);
    if (remaining <= 0) return reject(pkt, rinfo, 'Ya consumiste el tiempo de tu paquete');

    if (radius.enforceSingleDevice) {
      const station = getAttr(pkt, ATTR.CALLING_STATION_ID)?.value.toString('utf8') || '';
      const other = activeSessionsOf(account).find(([, s]) => s.station && station && s.station !== station);
      if (other) return reject(pkt, rinfo, 'Ya hay una sesión activa en otro dispositivo');
    }

    const plan = byId(account.planId);
    const attrs = [
      attrInt(ATTR.SESSION_TIMEOUT, Math.min(remaining, radius.maxSessionSeconds)),
      attrInt(ATTR.IDLE_TIMEOUT, radius.idleSeconds),
      attrInt(ATTR.ACCT_INTERIM_INTERVAL, radius.interimSeconds),
    ];
    if (radius.sendBandwidth && plan) {
      attrs.push(vendorAttrInt(VENDOR_WISPR, WISPR.MAX_DOWN, plan.downKbps * 1000));
      attrs.push(vendorAttrInt(VENDOR_WISPR, WISPR.MAX_UP, plan.upKbps * 1000));
    }
    store.counters.accepted += 1;
    metrics.radiusAccept();
    return buildResponse(CODE.ACCESS_ACCEPT, pkt, attrs, secret, !!getAttr(pkt, ATTR.MESSAGE_AUTHENTICATOR));
  }

  const int32 = (pkt, type) => { const a = getAttr(pkt, type); return a && a.value.length === 4 ? a.value.readUInt32BE(0) : 0; };

  function handleAccounting(pkt) {
    if (!verifyAccountingAuthenticator(pkt, secret)) return null;
    const respond = () => buildResponse(CODE.ACCT_RESPONSE, pkt, [], secret, false);
    const userAttr = getAttr(pkt, ATTR.USER_NAME);
    const sidAttr = getAttr(pkt, ATTR.ACCT_SESSION_ID);
    const status = int32(pkt, ATTR.ACCT_STATUS_TYPE);
    store.counters.acctPackets += 1;
    if (!userAttr || !sidAttr) return respond();

    const account = store.accounts.get(userAttr.value.toString('utf8'));
    if (!account) return respond();
    const sid = sidAttr.value.toString('utf8');
    account.sessions = account.sessions || {};
    const s = account.sessions[sid] || (account.sessions[sid] = {
      startedAt: now(), lastSeen: now(), time: 0, inOctets: 0, outOctets: 0,
      station: getAttr(pkt, ATTR.CALLING_STATION_ID)?.value.toString('utf8') || '',
      ip: getAttr(pkt, ATTR.FRAMED_IP)?.value.length === 4 ? [...getAttr(pkt, ATTR.FRAMED_IP).value].join('.') : '',
    });

    if (status === ACCT_STATUS.INTERIM || status === ACCT_STATUS.STOP) {
      const time = int32(pkt, ATTR.ACCT_SESSION_TIME);
      const inO = int32(pkt, ATTR.ACCT_INPUT_OCTETS) + int32(pkt, ATTR.ACCT_INPUT_GIGAWORDS) * 2 ** 32;
      const outO = int32(pkt, ATTR.ACCT_OUTPUT_OCTETS) + int32(pkt, ATTR.ACCT_OUTPUT_GIGAWORDS) * 2 ** 32;
      account.usedSeconds += Math.max(0, time - s.time);
      account.inOctets = (account.inOctets || 0) + Math.max(0, inO - s.inOctets);
      account.outOctets = (account.outOctets || 0) + Math.max(0, outO - s.outOctets);
      store.counters.bytesIn += Math.max(0, inO - s.inOctets);
      store.counters.bytesOut += Math.max(0, outO - s.outOctets);
      s.time = time; s.inOctets = inO; s.outOctets = outO;
    }
    s.lastSeen = now();
    if (status === ACCT_STATUS.STOP) delete account.sessions[sid];
    store.save();
    return respond();
  }

  function onMessage(kind) {
    return (msg, rinfo) => {
      if (!sourceAllowed(rinfo.address, radius.clients)) { metrics.radiusDropped(); return; }
      let pkt;
      try { pkt = parsePacket(msg); } catch { metrics.radiusDropped(); return; }
      let reply = null;
      store.syncFromDisk();
      try {
        if (kind === 'auth' && pkt.code === CODE.ACCESS_REQUEST) reply = handleAccess(pkt, rinfo);
        else if (kind === 'acct' && pkt.code === CODE.ACCT_REQUEST) reply = handleAccounting(pkt);
      } catch (err) { logger.error(`[radius] error procesando paquete: ${err.message}`); }
      if (!reply) { metrics.radiusDropped(); return; }
      const sock = kind === 'auth' ? sockets[0] : sockets[1];
      sock.send(reply, rinfo.port, rinfo.address);
    };
  }

  function bind(port, kind) {
    return new Promise((resolve, reject) => {
      const type = radius.host.includes(':') ? 'udp6' : 'udp4';
      const sock = dgram.createSocket({ type, reuseAddr: true });
      sock.once('error', reject);
      sock.on('message', onMessage(kind));
      sock.bind(port, radius.host, () => { sock.removeListener('error', reject); resolve(sock); });
    });
  }

  return (async () => {
    sockets.push(await bind(radius.authPort, 'auth'));
    sockets.push(await bind(radius.acctPort, 'acct'));
    logger.log(`[radius] autenticación UDP ${radius.authPort}, contabilidad UDP ${radius.acctPort}`);
    return {
      ports: { auth: sockets[0].address().port, acct: sockets[1].address().port },
      close: () => Promise.all(sockets.map((s) => new Promise((r) => s.close(r)))),
    };
  })();
}

module.exports = {
  startRadius, parsePacket, attr, attrInt, buildResponse, decryptPassword,
  CODE, ATTR, ACCT_STATUS, VENDOR_WISPR, WISPR, sourceAllowed,
};
