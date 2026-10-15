'use strict';
/** Validaciones de entrada sin dependencias externas. */

class ValidationError extends Error {
  constructor(fields) {
    super('Datos inválidos');
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

function cleanText(v, max) {
  return typeof v === 'string' ? v.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

function validateRegistration(body) {
  const fields = {};
  const name = cleanText(body && body.name, 80);
  const email = cleanText(body && body.email, 254).toLowerCase();
  const planId = cleanText(body && body.planId, 20);
  const acceptTerms = !!body && body.acceptTerms === true;

  if (name.length < 3 || !/\p{L}/u.test(name)) fields.name = 'Escribe tu nombre completo.';
  if (!EMAIL_RE.test(email)) fields.email = 'Escribe un correo válido.';
  if (!planId) fields.planId = 'Elige un paquete.';
  if (!acceptTerms) fields.acceptTerms = 'Debes aceptar las condiciones del servicio.';

  if (Object.keys(fields).length) throw new ValidationError(fields);
  return { name, email, planId };
}

/** Algoritmo de Luhn para números de tarjeta. */
function luhn(num) {
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = num.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function validateCard(card, now = new Date()) {
  const fields = {};
  const number = String((card && card.number) || '').replace(/[\s-]/g, '');
  const holder = cleanText(card && card.holder, 80);
  const cvc = String((card && card.cvc) || '').trim();
  const exp = String((card && card.exp) || '').trim();

  if (!/^\d{13,19}$/.test(number) || !luhn(number)) fields.number = 'Número de tarjeta inválido.';
  if (holder.length < 3) fields.holder = 'Escribe el nombre que aparece en la tarjeta.';
  if (!/^\d{3,4}$/.test(cvc)) fields.cvc = 'Código de seguridad inválido.';

  const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(exp);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) {
    fields.exp = 'Usa el formato MM/AA.';
  } else {
    const year = 2000 + Number(m[2]);
    const firstOfNextMonth = new Date(Date.UTC(year, Number(m[1]), 1));
    if (firstOfNextMonth <= now) fields.exp = 'La tarjeta está vencida.';
  }

  if (Object.keys(fields).length) throw new ValidationError(fields);
  return { number, holder, cvc, exp };
}

module.exports = { ValidationError, validateRegistration, validateCard, luhn, cleanText };
