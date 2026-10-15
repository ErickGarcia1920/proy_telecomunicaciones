'use strict';
const crypto = require('node:crypto');

// Alfabeto sin caracteres ambiguos (0/O, 1/I/L) para poder teclearlo sin errores.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomString(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const generateUsername = () => `U${randomString(7)}`;
const generatePassword = () => `${randomString(4)}-${randomString(4)}`;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const newId = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

module.exports = { generateUsername, generatePassword, hashPassword, verifyPassword, newId };
