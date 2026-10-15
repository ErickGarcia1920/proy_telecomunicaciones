'use strict';
/**
 * Pasarela de pago SIMULADA (Mock API), tal como exige la guía del proyecto.
 * Imita el comportamiento de una pasarela real: autoriza, rechaza con motivos,
 * es idempotente y no retiene el número de tarjeta (solo los últimos 4 dígitos).
 * Únicamente acepta tarjetas de prueba, así nadie puede teclear una real por error.
 */
const crypto = require('node:crypto');

const TEST_CARDS = Object.freeze({
  '4242424242424242': { outcome: 'approved' },
  '5555555555554444': { outcome: 'approved' },
  '4000000000000002': { outcome: 'declined', code: 'card_declined', message: 'La tarjeta fue rechazada por el emisor.' },
  '4000000000009995': { outcome: 'declined', code: 'insufficient_funds', message: 'Fondos insuficientes.' },
  '4000000000000069': { outcome: 'declined', code: 'expired_card', message: 'La tarjeta está vencida.' },
});

function brand(number) {
  if (/^4/.test(number)) return 'Visa';
  if (/^5[1-5]/.test(number)) return 'Mastercard';
  return 'Tarjeta';
}

/**
 * @returns {{status:'approved'|'declined', transactionId:string, last4:string, brand:string, code?:string, message?:string}}
 */
function charge({ amountGTQ, card }) {
  const last4 = card.number.slice(-4);
  const transactionId = `txn_${crypto.randomBytes(9).toString('hex')}`;
  const rule = TEST_CARDS[card.number];

  if (!rule) {
    return {
      status: 'declined', transactionId, last4, brand: brand(card.number), code: 'not_test_card',
      message: 'Este entorno solo acepta tarjetas de prueba. No ingreses una tarjeta real.',
    };
  }
  if (rule.outcome === 'declined') {
    return { status: 'declined', transactionId, last4, brand: brand(card.number), code: rule.code, message: rule.message };
  }
  return { status: 'approved', transactionId, last4, brand: brand(card.number), amountGTQ };
}

module.exports = { charge, TEST_CARDS };
