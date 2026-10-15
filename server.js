'use strict';
const { config, validate } = require('./src/config');
const { Store } = require('./src/store');
const { Metrics } = require('./src/metrics');
const { createApp } = require('./src/app');
const { startRadius } = require('./src/radius');

async function main() {
  const problems = validate(config);
  if (problems.length) {
    console.error('Configuración inválida:\n - ' + problems.join('\n - '));
    process.exit(1);
  }

  const store = new Store(config.store);
  const metrics = new Metrics();
  const { server } = createApp({ config, store, metrics });

  // Escucha en '::' (IPv4 + IPv6). Si el sistema no tiene IPv6, cae a IPv4.
  const listen = (host) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: config.http.port, host }, () => { server.removeListener('error', reject); resolve(host); });
  });
  let boundHost;
  try { boundHost = await listen(config.http.host); }
  catch (err) {
    if (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL') boundHost = await listen('0.0.0.0');
    else throw err;
  }
  console.log(`[http] ${config.portal.name} escuchando en [${boundHost}]:${config.http.port}`);

  let radius = null;
  if (config.radius.enabled) radius = await startRadius({ config, store, metrics });
  else console.log('[radius] desactivado (RADIUS_ENABLED=false)');

  const sampler = setInterval(() => metrics.sample(store), 5000);
  sampler.unref();

  // Limpieza de órdenes sin pagar con más de 24 h.
  const janitor = setInterval(() => {
    const limit = Date.now() - 24 * 3600 * 1000;
    for (const [id, o] of store.orders) if (o.state === 'registered' && o.createdAt < limit) store.orders.delete(id);
    store.save();
  }, 3600 * 1000);
  janitor.unref();

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[sistema] ${signal} recibido, cerrando…`);
    server.close();
    if (radius) await radius.close();
    store.flush();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => { console.error(err); process.exit(1); });
