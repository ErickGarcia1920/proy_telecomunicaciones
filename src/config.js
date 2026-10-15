'use strict';
/**
 * Configuración centralizada. Todo se controla por variables de entorno para
 * poder desplegar el mismo código en el laboratorio y en la máquina final.
 */
const path = require('node:path');

const env = process.env;
const int = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v, d) => (v === undefined ? d : ['1', 'true', 'yes', 'si'].includes(String(v).toLowerCase()));

const config = {
  http: {
    host: env.HOST || '::',                 // '::' atiende IPv4 e IPv6 (Dual Stack)
    port: int(env.PORT, 3000),
    trustProxy: bool(env.TRUST_PROXY, false), // true si va detrás de HAProxy
    bodyLimitBytes: 16 * 1024,
  },
  portal: {
    name: env.PORTAL_NAME || 'Conecta Rural',
    // URL de login del portal cautivo de pfSense, p. ej.
    // https://10.10.20.1:8003/index.php?zone=prepago
    loginUrl: env.PORTAL_LOGIN_URL || '',
    supportEmail: env.SUPPORT_EMAIL || 'soporte@conectarural.example',
  },
  radius: {
    enabled: bool(env.RADIUS_ENABLED, true),
    host: env.RADIUS_HOST || '::',
    authPort: int(env.RADIUS_AUTH_PORT, 1812),
    acctPort: int(env.RADIUS_ACCT_PORT, 1813),
    secret: env.RADIUS_SECRET || '',
    // Direcciones/CIDR IPv4 o IPv6 de pfSense autorizadas a consultar. Vacío = cualquiera.
    clients: (env.RADIUS_CLIENTS || '').split(',').map((s) => s.trim()).filter(Boolean),
    interimSeconds: int(env.RADIUS_INTERIM_SECONDS, 60),
    maxSessionSeconds: int(env.RADIUS_MAX_SESSION_SECONDS, 86400),
    idleSeconds: int(env.RADIUS_IDLE_SECONDS, 900),
    enforceSingleDevice: bool(env.RADIUS_SINGLE_DEVICE, true),
    sendBandwidth: bool(env.RADIUS_SEND_BANDWIDTH, true), // atributos WISPr por plan
  },
  store: {
    file: env.DATA_FILE || path.join(__dirname, '..', 'data', 'store.json'),
    persist: bool(env.PERSIST, true),
  },
  rateLimit: {
    windowMs: 60_000,
    max: int(env.RATE_LIMIT_PER_MINUTE, 40),
  },
  accountValidityDays: int(env.ACCOUNT_VALIDITY_DAYS, 30),
  metricsToken: env.METRICS_TOKEN || '', // si se define, /metrics exige Authorization: Bearer <token>
  env: env.NODE_ENV || 'development',
};

/** Falla pronto si la configuración es insegura. */
function validate(cfg) {
  const problems = [];
  if (cfg.radius.enabled) {
    if (!cfg.radius.secret) problems.push('RADIUS_SECRET es obligatorio cuando RADIUS_ENABLED=true.');
    else if (cfg.radius.secret.length < 16) problems.push('RADIUS_SECRET debe tener al menos 16 caracteres.');
  }
  return problems;
}

module.exports = { config, validate };
