'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, buy, accessRequest, accountingRequest, send, parseAttrs, responseAuthOk, SECRET } = require('./helpers');
const { CODE, ATTR, ACCT_STATUS, VENDOR_WISPR, WISPR } = require('../src/radius');

const int = (attrs, type) => { const a = attrs.find((x) => x.type === type); return a ? a.value.readUInt32BE(0) : undefined; };

async function setup(t, overrides) {
  const app = await startApp(overrides);
  t.after(() => app.close());
  const { creds } = await buy(app.base, 'dia');
  return { app, creds, port: app.radius.ports.auth, acct: app.radius.ports.acct };
}

test('acepta credenciales válidas con Session-Timeout, Idle-Timeout, interim y velocidad WISPr', async (t) => {
  const { creds, port } = await setup(t);
  const req = accessRequest({ user: creds.username, pass: creds.password });
  const resp = await send(port, req.buf);
  assert.ok(resp, 'debe haber respuesta');
  assert.equal(resp[0], CODE.ACCESS_ACCEPT);
  assert.equal(resp[1], req.id);
  assert.ok(responseAuthOk(resp, req.ra), 'Response Authenticator inválido');

  const attrs = parseAttrs(resp);
  assert.equal(int(attrs, ATTR.SESSION_TIMEOUT), 86400);       // plan de 1 día
  assert.equal(int(attrs, ATTR.IDLE_TIMEOUT), 900);
  assert.equal(int(attrs, ATTR.ACCT_INTERIM_INTERVAL), 60);

  // Atributos WISPr: vendor 14122, Max-Up (7) y Max-Down (8) en bits por segundo
  const vsa = attrs.filter((a) => a.type === ATTR.VENDOR_SPECIFIC).map((a) => ({ vendor: a.value.readUInt32BE(0), type: a.value[4], value: a.value.readUInt32BE(6) }));
  assert.ok(vsa.every((v) => v.vendor === VENDOR_WISPR));
  assert.equal(vsa.find((v) => v.type === WISPR.MAX_DOWN).value, 5_000_000);
  assert.equal(vsa.find((v) => v.type === WISPR.MAX_UP).value, 2_000_000);
});

test('rechaza contraseña incorrecta, usuario inexistente y descarta secreto equivocado', async (t) => {
  const { creds, port, app } = await setup(t);
  const wrong = accessRequest({ user: creds.username, pass: 'XXXX-XXXX' });
  const r1 = await send(port, wrong.buf);
  assert.equal(r1[0], CODE.ACCESS_REJECT);
  assert.ok(responseAuthOk(r1, wrong.ra));
  assert.match(parseAttrs(r1).find((a) => a.type === ATTR.REPLY_MESSAGE).value.toString(), /incorrectos/);

  const ghost = accessRequest({ user: 'UNOEXISTE', pass: 'AAAA-BBBB' });
  assert.equal((await send(port, ghost.buf))[0], CODE.ACCESS_REJECT);

  // Un cliente con otro secreto produce una contraseña basura: debe rechazar (o ignorar), nunca aceptar
  const bad = accessRequest({ user: creds.username, pass: creds.password, secret: 'otro-secreto-distinto-1234' });
  const r3 = await send(port, bad.buf);
  assert.ok(r3 === null || r3[0] === CODE.ACCESS_REJECT);
  assert.equal(app.store.counters.accepted, 0);
});

test('verifica y responde con Message-Authenticator (RFC 3579)', async (t) => {
  const { creds, port } = await setup(t);
  const req = accessRequest({ user: creds.username, pass: creds.password, messageAuth: true });
  const resp = await send(port, req.buf);
  assert.equal(resp[0], CODE.ACCESS_ACCEPT);
  assert.ok(parseAttrs(resp).some((a) => a.type === ATTR.MESSAGE_AUTHENTICATOR), 'la respuesta debe incluir Message-Authenticator');
  assert.ok(responseAuthOk(resp, req.ra));

  // Message-Authenticator alterado → se descarta en silencio
  const tampered = accessRequest({ user: creds.username, pass: creds.password, messageAuth: true });
  tampered.buf[tampered.buf.length - 1] ^= 0xff;
  assert.equal(await send(port, tampered.buf, 400), null);
});

test('la contabilidad descuenta tiempo y suma tráfico (start, interim, stop)', async (t) => {
  const { app, creds, acct } = await setup(t);
  const u = creds.username;
  const sid = 'sess-0001';

  let r = await send(acct, accountingRequest({ user: u, sessionId: sid, status: ACCT_STATUS.START }).buf);
  assert.equal(r[0], CODE.ACCT_RESPONSE);

  await send(acct, accountingRequest({ user: u, sessionId: sid, status: ACCT_STATUS.INTERIM, time: 600, inOctets: 1_000_000, outOctets: 5_000_000 }).buf);
  let account = app.store.accounts.get(u);
  assert.equal(account.usedSeconds, 600);
  assert.equal(account.inOctets, 1_000_000);

  await send(acct, accountingRequest({ user: u, sessionId: sid, status: ACCT_STATUS.STOP, time: 1500, inOctets: 3_000_000, outOctets: 9_000_000 }).buf);
  account = app.store.accounts.get(u);
  assert.equal(account.usedSeconds, 1500);                 // no se duplica lo ya contado
  assert.equal(app.store.counters.bytesIn, 3_000_000);
  assert.equal(app.store.counters.bytesOut, 9_000_000);
  assert.deepEqual(account.sessions, {});                  // la sesión se cierra

  // Siguiente login: el Session-Timeout refleja lo que queda
  const resp = await send(app.radius.ports.auth, accessRequest({ user: u, pass: creds.password }).buf);
  assert.equal(int(parseAttrs(resp), ATTR.SESSION_TIMEOUT), 86400 - 1500);
});

test('descarta contabilidad con firma inválida', async (t) => {
  const { app, creds, acct } = await setup(t);
  const bad = accountingRequest({ user: creds.username, sessionId: 'x', status: ACCT_STATUS.INTERIM, time: 999, secret: 'secreto-equivocado-000000' });
  assert.equal(await send(acct, bad.buf, 400), null);
  assert.equal(app.store.accounts.get(creds.username).usedSeconds, 0);
});

test('rechaza cuando se acabó el tiempo del paquete', async (t) => {
  const { app, creds, port } = await setup(t);
  app.store.accounts.get(creds.username).usedSeconds = 86400;
  const resp = await send(port, accessRequest({ user: creds.username, pass: creds.password }).buf);
  assert.equal(resp[0], CODE.ACCESS_REJECT);
  assert.match(parseAttrs(resp).find((a) => a.type === ATTR.REPLY_MESSAGE).value.toString(), /consumiste/);
});

test('rechaza cuentas vencidas o desactivadas', async (t) => {
  const { app, creds, port } = await setup(t);
  const acc = app.store.accounts.get(creds.username);
  acc.expiresAt = Date.now() - 1000;
  assert.match(parseAttrs(await send(port, accessRequest({ user: creds.username, pass: creds.password }).buf)).find((a) => a.type === ATTR.REPLY_MESSAGE).value.toString(), /venció/);
  acc.expiresAt = Date.now() + 1e9; acc.status = 'blocked';
  assert.equal((await send(port, accessRequest({ user: creds.username, pass: creds.password }).buf))[0], CODE.ACCESS_REJECT);
});

test('un segundo dispositivo es rechazado mientras el primero sigue activo, pero el mismo puede reautenticar', async (t) => {
  const { app, creds, port, acct } = await setup(t);
  await send(acct, accountingRequest({ user: creds.username, sessionId: 'a1', status: ACCT_STATUS.START, station: 'aa:aa:aa:aa:aa:01' }).buf);

  const other = await send(port, accessRequest({ user: creds.username, pass: creds.password, station: 'bb:bb:bb:bb:bb:02' }).buf);
  assert.equal(other[0], CODE.ACCESS_REJECT);
  assert.match(parseAttrs(other).find((a) => a.type === ATTR.REPLY_MESSAGE).value.toString(), /otro dispositivo/);

  const same = await send(port, accessRequest({ user: creds.username, pass: creds.password, station: 'aa:aa:aa:aa:aa:01' }).buf);
  assert.equal(same[0], CODE.ACCESS_ACCEPT);

  // Si la sesión queda "colgada" (sin interim por más de 3 intervalos) el usuario no se bloquea para siempre
  app.store.accounts.get(creds.username).sessions.a1.lastSeen = Date.now() - 4 * 60_000;
  const afterStale = await send(port, accessRequest({ user: creds.username, pass: creds.password, station: 'bb:bb:bb:bb:bb:02' }).buf);
  assert.equal(afterStale[0], CODE.ACCESS_ACCEPT);
});

test('solo responde a los clientes autorizados', async (t) => {
  const app = await startApp({ radius: { enabled: true, host: '127.0.0.1', authPort: 0, acctPort: 0, secret: SECRET, clients: ['10.99.99.0/24'], interimSeconds: 60, maxSessionSeconds: 86400, idleSeconds: 900, enforceSingleDevice: true, sendBandwidth: true } });
  t.after(() => app.close());
  const { creds } = await buy(app.base, 'dia');
  assert.equal(await send(app.radius.ports.auth, accessRequest({ user: creds.username, pass: creds.password }).buf, 400), null);
  assert.ok(app.metrics.radius.dropped >= 1);
});

test('paquetes basura no tumban el servidor', async (t) => {
  const { creds, port } = await setup(t);
  assert.equal(await send(port, Buffer.from('hola mundo'), 300), null);
  assert.equal(await send(port, Buffer.alloc(20), 300), null);
  const lie = Buffer.alloc(30); lie[0] = 1; lie.writeUInt16BE(500, 2);
  assert.equal(await send(port, lie, 300), null);
  const ok = await send(port, accessRequest({ user: creds.username, pass: creds.password }).buf);
  assert.equal(ok[0], CODE.ACCESS_ACCEPT);
});

test('los datos persisten en disco y se recuperan al reiniciar', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { Store } = require('../src/store');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'portal-')), 'store.json');
  const a = new Store({ file, persist: true });
  a.accounts.set('U1', { username: 'U1', usedSeconds: 42 });
  a.counters.revenueGTQ = 60;
  a.flush();
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600); // Windows no usa permisos POSIX
  const b = new Store({ file, persist: true });
  assert.equal(b.accounts.get('U1').usedSeconds, 42);
  assert.equal(b.counters.revenueGTQ, 60);
  fs.writeFileSync(file, '{corrupto');
  const c = new Store({ file, persist: true });
  assert.equal(c.accounts.size, 0);
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.includes('corrupto')));
});

test('un servidor de respaldo recarga los datos que escribió el activo (disco compartido)', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { Store } = require('../src/store');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ha-')), 'store.json');
  const active = new Store({ file, persist: true });
  const standby = new Store({ file, persist: true });
  assert.equal(standby.accounts.size, 0);

  active.accounts.set('UACTIVO', { username: 'UACTIVO', usedSeconds: 0 });
  active.flush();
  await new Promise((r) => setTimeout(r, 15)); // la marca de tiempo del archivo debe avanzar
  assert.equal(standby.syncFromDisk(), true);
  assert.ok(standby.accounts.has('UACTIVO'));
  assert.equal(standby.syncFromDisk(), false); // sin cambios nuevos no recarga
});
