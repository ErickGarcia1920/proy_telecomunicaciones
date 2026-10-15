'use strict';
/** Cabeceras de seguridad, límite de peticiones y lectura segura del cuerpo. */

function securityHeaders(portalLoginUrl) {
  let formAction = "'self'";
  try { if (portalLoginUrl) formAction += ` ${new URL(portalLoginUrl).origin}`; } catch { /* URL inválida: se ignora */ }
  return {
    'Content-Security-Policy': [
      "default-src 'self'", "img-src 'self' data:", "style-src 'self'", "script-src 'self'",
      "connect-src 'self'", "base-uri 'none'", "frame-ancestors 'none'", `form-action ${formAction}`,
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

/** Ventana fija por IP. Suficiente para frenar abusos en un portal de este tamaño. */
class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
    this._gc = setInterval(() => this.sweep(), windowMs);
    this._gc.unref();
  }
  sweep() { const t = Date.now(); for (const [k, v] of this.hits) if (t > v.reset) this.hits.delete(k); }
  check(key) {
    const t = Date.now();
    let e = this.hits.get(key);
    if (!e || t > e.reset) { e = { count: 0, reset: t + this.windowMs }; this.hits.set(key, e); }
    e.count += 1;
    return { allowed: e.count <= this.max, retryAfter: Math.ceil((e.reset - t) / 1000) };
  }
}

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    if (!type.toLowerCase().startsWith('application/json')) return reject(new HttpError(415, 'Se esperaba application/json'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Cuerpo demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new HttpError(400, 'JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  const a = req.socket.remoteAddress || 'desconocida';
  return a.startsWith('::ffff:') ? a.slice(7) : a;
}

module.exports = { securityHeaders, RateLimiter, HttpError, readJson, clientIp };
