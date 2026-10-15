'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startApp, request, buy, GOOD_CARD } = require('./helpers');

test('flujo completo: registro → pago aprobado → credenciales una sola vez', async (t) => {
  const app = await startApp({ radius: { enabled: false } });
  t.after(() => app.close());

  const { reg, pay, creds, sessionId } = await buy(app.base, 'semana');
  assert.equal(reg.status, 201);
  assert.equal(pay.status, 200);
  assert.equal(pay.json.status, 'approved');
  assert.equal(pay.json.last4, '4242');
  assert.match(creds.username, /^U[A-Z2-9]{7}$/);
  assert.match(creds.password, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(pay.json.account.totalSeconds, 7 * 86400);

  // La cuenta existe con hash, jamás en claro
  const account = app.store.accounts.get(creds.username);
  assert.ok(account && !JSON.stringify(account).includes(creds.password));

  // Las credenciales ya se entregaron: el GET no las repite
  const s = await request(app.base, 'GET', `/api/sessions/${sessionId}`);
  assert.equal(s.json.state, 'paid');
  assert.equal(s.json.credentials, null);
  assert.equal(s.json.account.username, creds.username);
  assert.equal(app.store.orders.get(sessionId).pendingPassword, undefined);
});

test('si la respuesta del pago se pierde, las credenciales se recuperan una vez', async (t) => {
  const app = await startApp({ radius: { enabled: false } });
  t.after(() => app.close());
  const reg = await request(app.base, 'POST', '/api/register', { body: { name: 'Luis Gómez', email: 'luis@example.com', planId: 'hora', acceptTerms: true } });
  const key = crypto.randomUUID();
  // Simula pago aprobado cuyo cliente no recibió la respuesta
  const order = app.store.orders.get(reg.json.sessionId);
  const pay = await request(app.base, 'POST', '/api/payments/mock', { body: { sessionId: order.id, card: GOOD_CARD }, headers: { 'Idempotency-Key': key } });
  assert.equal(pay.status, 200);
  // Reintento con la misma clave: no cobra de nuevo
  const again = await request(app.base, 'POST', '/api/payments/mock', { body: { sessionId: order.id, card: GOOD_CARD }, headers: { 'Idempotency-Key': key } });
  assert.equal(again.status, 200);
  assert.equal(again.json.replayed, true);
  assert.equal(app.store.accounts.size, 1);
  assert.equal(app.store.counters.revenueGTQ, 5);
});

test('un pago rechazado no crea cuenta y descuenta intentos', async (t) => {
  const app = await startApp({ radius: { enabled: false } });
  t.after(() => app.close());
  const declined = { ...GOOD_CARD, number: '4000 0000 0000 0002' };
  const { pay, sessionId } = await buy(app.base, 'dia', declined);
  assert.equal(pay.status, 402);
  assert.equal(pay.json.code, 'card_declined');
  assert.equal(pay.json.attemptsLeft, 4);
  assert.equal(app.store.accounts.size, 0);
  assert.equal(app.store.counters.declined, 1);
  // Luego puede reintentar con una tarjeta buena
  const ok = await request(app.base, 'POST', '/api/payments/mock', { body: { sessionId, card: GOOD_CARD }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
  assert.equal(ok.status, 200);
});

test('una tarjeta real (no de prueba) se rechaza sin guardarla', async (t) => {
  const app = await startApp({ radius: { enabled: false } });
  t.after(() => app.close());
  const { pay } = await buy(app.base, 'dia', { ...GOOD_CARD, number: '4111 1111 1111 1111' });
  assert.equal(pay.status, 402);
  assert.equal(pay.json.code, 'not_test_card');
  assert.ok(!JSON.stringify(app.store.snapshot()).includes('4111'));
});

test('después de 5 intentos fallidos la orden se bloquea', async (t) => {
  const app = await startApp({ radius: { enabled: false } });
  t.after(() => app.close());
  const reg = await request(app.base, 'POST', '/api/register', { body: { name: 'Eva Ruiz', email: 'eva@example.com', planId: 'dia', acceptTerms: true } });
  const bad = { ...GOOD_CARD, number: '4000 0000 0000 0002' };
  for (let i = 0; i < 5; i++) await request(app.base, 'POST', '/api/payments/mock', { body: { sessionId: reg.json.sessionId, card: bad } });
  const blocked = await request(app.base, 'POST', '/api/payments/mock', { body: { sessionId: reg.json.sessionId, card: GOOD_CARD } });
  assert.equal(blocked.status, 429);
});

test('no se puede pagar dos veces la misma orden', async (t) => {
  const app = await startApp({ radius: { enabled: false } });
  t.after(() => app.close());
  const { sessionId } = await buy(app.base);
  const second = await request(app.base, 'POST', '/api/payments/mock', { body: { sessionId, card: GOOD_CARD }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
  assert.equal(second.status, 409);
});

test('las órdenes sin pagar vencen a los 30 minutos', async (t) => {
  const app = await startApp({ radius: { enabled: false } });
  t.after(() => app.close());
  const reg = await request(app.base, 'POST', '/api/register', { body: { name: 'Raúl Díaz', email: 'raul@example.com', planId: 'dia', acceptTerms: true } });
  app.store.orders.get(reg.json.sessionId).createdAt -= 31 * 60 * 1000;
  const pay = await request(app.base, 'POST', '/api/payments/mock', { body: { sessionId: reg.json.sessionId, card: GOOD_CARD } });
  assert.equal(pay.status, 410);
});

test('validaciones de entrada: 422, 415, 400 y 404', async (t) => {
  const app = await startApp({ radius: { enabled: false } });
  t.after(() => app.close());
  const v = await request(app.base, 'POST', '/api/register', { body: { name: 'x' } });
  assert.equal(v.status, 422); assert.ok(v.json.fields.email);
  const plan = await request(app.base, 'POST', '/api/register', { body: { name: 'Ana Pérez', email: 'a@b.co', planId: 'inventado', acceptTerms: true } });
  assert.equal(plan.status, 422); assert.ok(plan.json.fields.planId);
  const type = await fetch(app.base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hola' });
  assert.equal(type.status, 415);
  const bad = await fetch(app.base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{no es json' });
  assert.equal(bad.status, 400);
  assert.equal((await request(app.base, 'GET', '/api/sessions/zzz')).status, 404);
  assert.equal((await request(app.base, 'GET', `/api/sessions/${'a'.repeat(32)}`)).status, 404);
  assert.equal((await request(app.base, 'GET', '/no-existe')).status, 404);
  assert.equal((await request(app.base, 'DELETE', '/api/plans')).status, 405);
});

test('cuerpos demasiado grandes se rechazan', async (t) => {
  const app = await startApp({ radius: { enabled: false } });
  t.after(() => app.close());
  const big = await fetch(app.base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'a'.repeat(40_000) }) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
});

test('el límite de peticiones responde 429 con Retry-After', async (t) => {
  const app = await startApp({ radius: { enabled: false }, rateLimit: { windowMs: 60_000, max: 3 } });
  t.after(() => app.close());
  const body = { name: 'Ana Pérez', email: 'a@b.co', planId: 'dia', acceptTerms: true };
  for (let i = 0; i < 3; i++) assert.equal((await request(app.base, 'POST', '/api/register', { body })).status, 201);
  const r = await request(app.base, 'POST', '/api/register', { body });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
});

test('las cabeceras de seguridad y el bloqueo de path traversal funcionan', async (t) => {
  const app = await startApp({ radius: { enabled: false } });
  t.after(() => app.close());
  const home = await fetch(app.base + '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /form-action 'self' https:\/\/10\.10\.20\.1:8003/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(app.base + '/%2e%2e/package.json')).status, 404);
  assert.equal((await fetch(app.base + '/..%2fserver.js')).status, 404);
});

test('/healthz, /api/stats y /metrics exponen el estado', async (t) => {
  const app = await startApp({ radius: { enabled: false }, metricsToken: 'token-secreto' });
  t.after(() => app.close());
  await buy(app.base, 'dia');
  assert.equal((await request(app.base, 'GET', '/healthz')).json.status, 'ok');
  const stats = await request(app.base, 'GET', '/api/stats');
  assert.equal(stats.json.summary.orders.paid, 1);
  assert.equal(stats.json.summary.revenueGTQ, 15);
  assert.equal((await request(app.base, 'GET', '/metrics')).status, 401);
  const m = await request(app.base, 'GET', '/metrics', { headers: { Authorization: 'Bearer token-secreto' } });
  assert.equal(m.status, 200);
  assert.match(m.text, /portal_orders_total\{state="paid"\} 1/);
  assert.match(m.text, /portal_revenue_gtq_total 15/);
});
