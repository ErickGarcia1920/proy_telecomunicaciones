'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { PLANS, byId } = require('./plans');
const { validateRegistration, validateCard, ValidationError } = require('./validation');
const { charge } = require('./payments');
const { generateUsername, generatePassword, hashPassword, newId } = require('./credentials');
const { securityHeaders, RateLimiter, HttpError, readJson, clientIp } = require('./security');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};
const ORDER_TTL_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function createApp({ config, store, metrics, logger = console }) {
  const limiter = new RateLimiter(config.rateLimit);
  const baseHeaders = securityHeaders(config.portal.loginUrl);

  const send = (res, status, body, headers = {}) => {
    const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
    const payload = isJson ? JSON.stringify(body) : body;
    res.writeHead(status, {
      ...baseHeaders,
      'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(payload);
  };

  const publicPlan = (p) => ({ id: p.id, name: p.name, seconds: p.seconds, priceGTQ: p.priceGTQ, downKbps: p.downKbps, upKbps: p.upKbps, blurb: p.blurb, featured: !!p.featured });

  function getOrder(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new HttpError(404, 'Sesión no encontrada');
    const order = store.orders.get(id);
    if (!order) throw new HttpError(404, 'Sesión no encontrada');
    return order;
  }

  function accountSummary(account) {
    return {
      username: account.username,
      planId: account.planId,
      remainingSeconds: Math.max(0, account.totalSeconds - account.usedSeconds),
      totalSeconds: account.totalSeconds,
      expiresAt: account.expiresAt,
    };
  }

  /** Entrega las credenciales una sola vez y borra la contraseña en claro. */
  function takeCredentials(order) {
    if (!order.pendingPassword) return null;
    const creds = { username: order.username, password: order.pendingPassword };
    delete order.pendingPassword;
    order.delivered = true;
    store.save();
    return creds;
  }

  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
    routes.push({ method, pattern, re, keys, handler, ...opts });
  };

  route('GET', '/healthz', async () => {
    const ok = store.writable();
    return { status: ok ? 200 : 503, body: { status: ok ? 'ok' : 'degraded', uptimeSeconds: Math.floor(process.uptime()), storage: ok ? 'ok' : 'sin escritura' } };
  });

  route('GET', '/metrics', async (req) => {
    if (config.metricsToken && req.headers.authorization !== `Bearer ${config.metricsToken}`) throw new HttpError(401, 'No autorizado');
    return { status: 200, body: metrics.prometheus(store), headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' } };
  });

  route('GET', '/api/stats', async () => ({
    status: 200,
    body: { summary: metrics.summary(store), history: metrics.history, serverTime: Date.now() },
  }));

  route('GET', '/api/config', async () => ({
    status: 200,
    body: {
      portalName: config.portal.name,
      loginUrl: config.portal.loginUrl,
      supportEmail: config.portal.supportEmail,
      validityDays: config.accountValidityDays,
    },
  }));

  route('GET', '/api/plans', async () => ({ status: 200, body: { plans: PLANS.map(publicPlan) } }));

  route('POST', '/api/register', async (req) => {
    const data = validateRegistration(await readJson(req, config.http.bodyLimitBytes));
    const plan = byId(data.planId);
    if (!plan) throw new ValidationError({ planId: 'El paquete elegido no existe.' });
    const order = {
      id: newId(), name: data.name, email: data.email, planId: plan.id, amountGTQ: plan.priceGTQ,
      state: 'registered', attempts: 0, createdAt: Date.now(),
    };
    store.orders.set(order.id, order);
    store.save();
    return { status: 201, body: { sessionId: order.id, plan: publicPlan(plan), amountGTQ: order.amountGTQ, expiresInSeconds: ORDER_TTL_MS / 1000 } };
  }, { limited: true });

  route('POST', '/api/payments/mock', async (req) => {
    const body = await readJson(req, config.http.bodyLimitBytes);
    const order = getOrder(body.sessionId);
    const key = String(req.headers['idempotency-key'] || '').slice(0, 80);

    // Reintento idempotente: misma clave → mismo resultado, sin cobrar dos veces.
    if (key && store.payments.has(key)) {
      const prev = store.payments.get(key);
      if (prev.orderId !== order.id) throw new HttpError(409, 'La clave de idempotencia ya se usó en otra orden');
      const account = store.accounts.get(order.username);
      return { status: 200, body: { ...prev.result, credentials: takeCredentials(order), account: account ? accountSummary(account) : undefined, replayed: true } };
    }

    if (order.state === 'paid') throw new HttpError(409, 'Esta orden ya fue pagada');
    if (Date.now() - order.createdAt > ORDER_TTL_MS) throw new HttpError(410, 'La orden venció. Vuelve a empezar.');
    if (order.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'Demasiados intentos de pago. Vuelve a empezar.');

    const card = validateCard(body.card);
    order.attempts += 1;
    const result = charge({ amountGTQ: order.amountGTQ, card });

    if (result.status === 'declined') {
      store.counters.declined += 1;
      store.save();
      const out = { status: 'declined', code: result.code, message: result.message, transactionId: result.transactionId, attemptsLeft: MAX_ATTEMPTS - order.attempts };
      if (key) store.payments.set(key, { orderId: order.id, result: out });
      return { status: 402, body: out };
    }

    const plan = byId(order.planId);
    const username = generateUsername();
    const password = generatePassword();
    const account = {
      username, passHash: hashPassword(password), planId: plan.id, orderId: order.id,
      totalSeconds: plan.seconds, usedSeconds: 0, inOctets: 0, outOctets: 0,
      expiresAt: Date.now() + config.accountValidityDays * 86_400_000, status: 'active', createdAt: Date.now(), sessions: {},
    };
    store.accounts.set(username, account);
    Object.assign(order, {
      state: 'paid', paidAt: Date.now(), transactionId: result.transactionId, last4: result.last4, brand: result.brand,
      username, pendingPassword: password, delivered: false,
    });
    store.counters.revenueGTQ += order.amountGTQ;

    const out = { status: 'approved', transactionId: result.transactionId, brand: result.brand, last4: result.last4, amountGTQ: order.amountGTQ };
    if (key) store.payments.set(key, { orderId: order.id, result: out });
    store.save();
    return { status: 200, body: { ...out, credentials: takeCredentials(order), account: accountSummary(account) } };
  }, { limited: true });

  route('GET', '/api/sessions/:id', async (req, params) => {
    const order = getOrder(params.id);
    const body = {
      state: order.state, planId: order.planId, amountGTQ: order.amountGTQ,
      expired: order.state === 'registered' && Date.now() - order.createdAt > ORDER_TTL_MS,
    };
    if (order.state === 'paid') {
      const account = store.accounts.get(order.username);
      body.account = account ? accountSummary(account) : null;
      body.receipt = { transactionId: order.transactionId, brand: order.brand, last4: order.last4, paidAt: order.paidAt };
      body.credentials = takeCredentials(order); // solo la primera vez
    }
    return { status: 200, body };
  });

  async function serveStatic(req, res, pathname) {
    const alias = { '/': '/index.html', '/estado': '/estado.html' };
    const rel = alias[pathname] || pathname;
    const full = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
    const ext = path.extname(full);
    res.writeHead(200, {
      ...baseHeaders,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(full).pipe(res);
    return true;
  }

  const server = http.createServer(async (req, res) => {
    const started = process.hrtime.bigint();
    let routeName = 'static';
    let status = 500;
    const ip = clientIp(req, config.http.trustProxy);
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      const match = routes.map((r) => ({ r, m: r.re.exec(pathname) })).find((x) => x.m && x.r.method === req.method);

      if (match) {
        routeName = match.r.pattern;
        if (routeName.startsWith('/api/')) store.syncFromDisk();
        if (match.r.limited) {
          const rl = limiter.check(ip);
          if (!rl.allowed) throw new HttpError(429, 'Demasiadas peticiones. Intenta de nuevo en un momento.', { retryAfter: rl.retryAfter });
        }
        const params = Object.fromEntries(match.r.keys.map((k, i) => [k, match.m[i + 1]]));
        const out = await match.r.handler(req, params);
        status = out.status;
        send(res, out.status, out.body, out.headers);
      } else if ((req.method === 'GET' || req.method === 'HEAD') && await serveStatic(req, res, pathname)) {
        status = 200;
      } else if (routes.some((r) => r.re.test(pathname))) {
        throw new HttpError(405, 'Método no permitido');
      } else {
        routeName = 'not_found';
        throw new HttpError(404, 'No encontrado');
      }
    } catch (err) {
      if (err instanceof ValidationError) { status = 422; send(res, 422, { error: 'validation', message: err.message, fields: err.fields }); }
      else if (err instanceof HttpError) {
        status = err.status;
        send(res, err.status, { error: 'http', message: err.message }, err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {});
      } else {
        status = 500;
        logger.error(`[http] error no controlado: ${err.stack || err}`);
        send(res, 500, { error: 'internal', message: 'Error interno del servidor' });
      }
    } finally {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (routeName !== 'static' || status >= 400) metrics.observeRequest(req.method, routeName, status, ms);
      else metrics.observeRequest(req.method, 'static', status, ms);
      if (config.env !== 'test') logger.log(JSON.stringify({ t: new Date().toISOString(), ip, method: req.method, route: routeName, status, ms: Math.round(ms * 10) / 10 }));
    }
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  return { server, limiter };
}

module.exports = { createApp };
