'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { luhn, validateRegistration, validateCard, ValidationError } = require('../src/validation');
const { charge } = require('../src/payments');
const { hashPassword, verifyPassword, generatePassword, generateUsername } = require('../src/credentials');
const { sourceAllowed } = require('../src/radius');
const { validate } = require('../src/config');

test('Luhn acepta tarjetas válidas y rechaza alteradas', () => {
  assert.equal(luhn('4242424242424242'), true);
  assert.equal(luhn('4242424242424243'), false);
});

test('el registro exige nombre, correo, plan y aceptar condiciones', () => {
  assert.throws(() => validateRegistration({}), (e) => e instanceof ValidationError && Object.keys(e.fields).length === 4);
  const ok = validateRegistration({ name: '  Ana  Pérez ', email: 'ANA@Example.com', planId: 'dia', acceptTerms: true });
  assert.deepEqual(ok, { name: 'Ana  Pérez', email: 'ana@example.com', planId: 'dia' });
});

test('el registro limpia caracteres de control y rechaza nombres sin letras', () => {
  assert.throws(() => validateRegistration({ name: '1234', email: 'a@b.co', planId: 'dia', acceptTerms: true }));
  const ok = validateRegistration({ name: 'Ana\u0000 López', email: 'a@b.co', planId: 'dia', acceptTerms: true });
  assert.equal(ok.name, 'Ana López');
});

test('la tarjeta vencida o con formato incorrecto se rechaza', () => {
  const base = { number: '4242424242424242', holder: 'Ana Pérez', cvc: '123' };
  assert.throws(() => validateCard({ ...base, exp: '01/20' }), (e) => !!e.fields.exp);
  assert.throws(() => validateCard({ ...base, exp: '1220' }), (e) => !!e.fields.exp);
  assert.throws(() => validateCard({ ...base, exp: '13/30' }), (e) => !!e.fields.exp);
  assert.doesNotThrow(() => validateCard({ ...base, exp: '12/39' }));
  assert.doesNotThrow(() => validateCard({ ...base, exp: '12/30' }, new Date('2026-10-14')));
});

test('la pasarela simulada aprueba, rechaza y bloquea tarjetas reales', () => {
  const mk = (number) => ({ number, holder: 'x', cvc: '123', exp: '12/39' });
  assert.equal(charge({ amountGTQ: 15, card: mk('4242424242424242') }).status, 'approved');
  const d = charge({ amountGTQ: 15, card: mk('4000000000009995') });
  assert.equal(d.status, 'declined'); assert.equal(d.code, 'insufficient_funds');
  const real = charge({ amountGTQ: 15, card: mk('4111111111111111') });
  assert.equal(real.code, 'not_test_card');
  assert.equal(charge({ amountGTQ: 1, card: mk('4242424242424242') }).last4, '4242');
});

test('las contraseñas se guardan con hash y se comparan bien', () => {
  const p = generatePassword();
  assert.match(p, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.match(generateUsername(), /^U[A-Z2-9]{7}$/);
  const h = hashPassword(p);
  assert.ok(!h.includes(p));
  assert.equal(verifyPassword(p, h), true);
  assert.equal(verifyPassword('otra', h), false);
  assert.equal(verifyPassword(p, 'basura'), false);
});

test('el filtro de origen RADIUS soporta IPv4, CIDR e IPv6', () => {
  assert.equal(sourceAllowed('10.10.30.1', []), true);
  assert.equal(sourceAllowed('10.10.30.1', ['10.10.30.0/24']), true);
  assert.equal(sourceAllowed('::ffff:10.10.30.9', ['10.10.30.0/24']), true);
  assert.equal(sourceAllowed('10.10.31.1', ['10.10.30.0/24']), false);
  assert.equal(sourceAllowed('192.168.1.5', ['10.10.30.5']), false);
  assert.equal(sourceAllowed('fd4a:7c21:9e05:30::1', ['fd4a:7c21:9e05:30::/64']), true);
  assert.equal(sourceAllowed('fd4a:7c21:9e05:99::1', ['fd4a:7c21:9e05:30::/64']), false);
});

test('la configuración exige un secreto RADIUS fuerte', () => {
  const base = { radius: { enabled: true, secret: '' } };
  assert.equal(validate(base).length, 1);
  assert.equal(validate({ radius: { enabled: true, secret: 'corto' } }).length, 1);
  assert.equal(validate({ radius: { enabled: true, secret: 'x'.repeat(20) } }).length, 0);
  assert.equal(validate({ radius: { enabled: false, secret: '' } }).length, 0);
});
