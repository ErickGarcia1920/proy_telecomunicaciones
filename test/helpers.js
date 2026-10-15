'use strict';
const http = require('node:http');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { Store } = require('../src/store');
const { Metrics } = require('../src/metrics');
const { createApp } = require('../src/app');
const { startRadius, ATTR, CODE, attr, attrInt } = require('../src/radius');

const SECRET = 'secreto-de-pruebas-0123456789';
const silent = { log() {}, error() {} };

function testConfig(overrides = {}) {
  return {
    http: { host: '127.0.0.1', port: 0, trustProxy: false, bodyLimitBytes: 16 * 1024 },
    portal: { name: 'Portal de pruebas', loginUrl: 'https://10.10.20.1:8003/index.php?zone=prepago', supportEmail: 'soporte@example.test' },
    radius: { enabled: true, host: '127.0.0.1', authPort: 0, acctPort: 0, secret: SECRET, clients: [], interimSeconds: 60, maxSessionSeconds: 86400, idleSeconds: 900, enforceSingleDevice: true, sendBandwidth: true },
    store: { file: '', persist: false },
    rateLimit: { windowMs: 60_000, max: 1000 },
    accountValidityDays: 30,
    metricsToken: '',
    env: 'test',
    ...overrides,
  };
}

async function startApp(overrides = {}) {
  const config = testConfig(overrides);
  const store = new Store(config.store);
  const metrics = new Metrics();
  const { server } = createApp({ config, store, metrics, logger: silent });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let radius = null;
  if (config.radius.enabled) radius = await startRadius({ config, store, metrics, logger: silent });
  return {
    config, store, metrics, server, radius, base,
    close: async () => { server.close(); server.closeAllConnections?.(); if (radius) await radius.close(); },
  };
}

async function request(base, method, path, { body, headers } = {}) {
  const res = await fetch(base + path, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* texto plano */ }
  return { status: res.status, json, text, headers: res.headers };
}

const GOOD_CARD = { number: '4242 4242 4242 4242', holder: 'Ana Pérez', exp: '12/39', cvc: '123' };

/** Compra completa por la API; devuelve credenciales. */
async function buy(base, planId = 'dia', card = GOOD_CARD) {
  const reg = await request(base, 'POST', '/api/register', { body: { name: 'Ana Pérez', email: 'ana@example.com', planId, acceptTerms: true } });
  const pay = await request(base, 'POST', '/api/payments/mock', { body: { sessionId: reg.json.sessionId, card }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
  return { reg, pay, creds: pay.json && pay.json.credentials, sessionId: reg.json.sessionId };
}

// ---------- Cliente RADIUS mínimo para pruebas ----------
const md5 = (...b) => { const h = crypto.createHash('md5'); b.forEach((x) => h.update(x)); return h.digest(); };

function encryptPassword(password, ra, secret) {
  const p = Buffer.from(password, 'utf8');
  const padded = Buffer.concat([p, Buffer.alloc((16 - (p.length % 16 || 16)) % 16 || (p.length === 0 ? 16 : 0))]);
  const out = Buffer.alloc(padded.length);
  let prev = ra;
  for (let i = 0; i < padded.length; i += 16) {
    const b = md5(Buffer.from(secret), prev);
    for (let j = 0; j < 16; j++) out[i + j] = padded[i + j] ^ b[j];
    prev = out.subarray(i, i + 16);
  }
  return out;
}

function packet(code, id, authenticator, attrs) {
  const body = Buffer.concat(attrs);
  const h = Buffer.alloc(20);
  h[0] = code; h[1] = id; h.writeUInt16BE(20 + body.length, 2); authenticator.copy(h, 4);
  return Buffer.concat([h, body]);
}

function accessRequest({ user, pass, id = 7, station = 'aa:bb:cc:dd:ee:01', messageAuth = false, secret = SECRET }) {
  const ra = crypto.randomBytes(16);
  const attrs = [attr(ATTR.USER_NAME, user), attr(ATTR.USER_PASSWORD, encryptPassword(pass, ra, secret)), attr(ATTR.CALLING_STATION_ID, station)];
  let buf;
  if (messageAuth) {
    attrs.push(attr(ATTR.MESSAGE_AUTHENTICATOR, Buffer.alloc(16)));
    buf = packet(CODE.ACCESS_REQUEST, id, ra, attrs);
    crypto.createHmac('md5', secret).update(buf).digest().copy(buf, buf.length - 16);
  } else buf = packet(CODE.ACCESS_REQUEST, id, ra, attrs);
  return { buf, ra, id };
}

function accountingRequest({ user, sessionId, status, time = 0, inOctets = 0, outOctets = 0, station = 'aa:bb:cc:dd:ee:01', id = 9, secret = SECRET }) {
  const attrs = [
    attrInt(ATTR.ACCT_STATUS_TYPE, status), attr(ATTR.USER_NAME, user), attr(ATTR.ACCT_SESSION_ID, sessionId),
    attrInt(ATTR.ACCT_SESSION_TIME, time), attrInt(ATTR.ACCT_INPUT_OCTETS, inOctets), attrInt(ATTR.ACCT_OUTPUT_OCTETS, outOctets),
    attr(ATTR.CALLING_STATION_ID, station),
  ];
  const zero = packet(CODE.ACCT_REQUEST, id, Buffer.alloc(16), attrs);
  const auth = md5(zero, Buffer.from(secret));
  return { buf: packet(CODE.ACCT_REQUEST, id, auth, attrs), id };
}

function send(port, buf, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { sock.close(); resolve(null); }, timeoutMs);
    sock.once('message', (m) => { clearTimeout(timer); sock.close(); resolve(m); });
    sock.send(buf, port, '127.0.0.1');
  });
}

function parseAttrs(buf) {
  const out = []; let off = 20;
  while (off < buf.readUInt16BE(2)) { out.push({ type: buf[off], value: buf.subarray(off + 2, off + buf[off + 1]) }); off += buf[off + 1]; }
  return out;
}

function responseAuthOk(resp, requestAuth, secret = SECRET) {
  const copy = Buffer.from(resp); requestAuth.copy(copy, 4);
  return md5(copy, Buffer.from(secret)).equals(resp.subarray(4, 20));
}

module.exports = { startApp, request, buy, GOOD_CARD, SECRET, accessRequest, accountingRequest, send, parseAttrs, responseAuthOk, silent, testConfig };
