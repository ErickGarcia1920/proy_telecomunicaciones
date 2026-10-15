'use strict';
/**
 * Métricas en memoria. Se exponen en dos formatos:
 *  - /metrics   → texto Prometheus (lo puede leer Telegraf con inputs.prometheus)
 *  - /api/stats → JSON para el panel de estado integrado
 */
const RING = 500; // últimas N latencias para calcular percentiles

class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.requests = new Map();      // "METHOD route status" -> n
    this.latencies = [];            // ms
    this.radius = { accept: 0, reject: 0, dropped: 0, rejectReasons: new Map() };
    this.history = [];              // serie temporal para la gráfica, 1 punto cada 5 s
    this._lastBytes = null;
  }

  observeRequest(method, route, status, ms) {
    const key = `${method} ${route} ${status}`;
    this.requests.set(key, (this.requests.get(key) || 0) + 1);
    this.latencies.push(ms);
    if (this.latencies.length > RING) this.latencies.shift();
  }

  radiusAccept() { this.radius.accept += 1; }
  radiusReject(reason) {
    this.radius.reject += 1;
    this.radius.rejectReasons.set(reason, (this.radius.rejectReasons.get(reason) || 0) + 1);
  }
  radiusDropped() { this.radius.dropped += 1; }

  percentile(p) {
    if (!this.latencies.length) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  }

  totalRequests() { let n = 0; for (const v of this.requests.values()) n += v; return n; }

  summary(store) {
    const accounts = [...store.accounts.values()];
    const t = Date.now();
    const staleMs = 180_000;
    const online = accounts.reduce((n, a) => n + Object.values(a.sessions || {}).filter((s) => t - s.lastSeen <= staleMs).length, 0);
    const orders = [...store.orders.values()];
    return {
      uptimeSeconds: Math.floor((t - this.startedAt) / 1000),
      requestsTotal: this.totalRequests(),
      latencyMs: { p50: round(this.percentile(50)), p95: round(this.percentile(95)), p99: round(this.percentile(99)) },
      usersOnline: online,
      accountsActive: accounts.filter((a) => a.status === 'active' && t <= a.expiresAt && a.usedSeconds < a.totalSeconds).length,
      orders: {
        total: orders.length,
        paid: orders.filter((o) => o.state === 'paid').length,
        declined: store.counters.declined || 0,
      },
      revenueGTQ: store.counters.revenueGTQ,
      bytesIn: store.counters.bytesIn,
      bytesOut: store.counters.bytesOut,
      radius: { accepted: this.radius.accept, rejected: this.radius.reject, dropped: this.radius.dropped },
    };
  }

  /** Toma una muestra para la serie temporal (consumo en bits por segundo). */
  sample(store) {
    const total = store.counters.bytesIn + store.counters.bytesOut;
    const t = Date.now();
    let bps = 0;
    if (this._lastBytes) bps = Math.max(0, ((total - this._lastBytes.total) * 8) / ((t - this._lastBytes.t) / 1000));
    this._lastBytes = { total, t };
    this.history.push({ t, bps: Math.round(bps), p95: round(this.percentile(95)), online: this.summary(store).usersOnline });
    if (this.history.length > 120) this.history.shift();
  }

  prometheus(store) {
    const s = this.summary(store);
    const out = [];
    const metric = (name, help, type, lines) => { out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...lines); };
    metric('portal_uptime_seconds', 'Segundos desde que arrancó el portal', 'gauge', [`portal_uptime_seconds ${s.uptimeSeconds}`]);
    metric('portal_http_requests_total', 'Peticiones HTTP atendidas', 'counter',
      [...this.requests.entries()].map(([k, v]) => {
        const [method, route, status] = k.split(' ');
        return `portal_http_requests_total{method="${method}",route="${route}",status="${status}"} ${v}`;
      }));
    metric('portal_http_latency_ms', 'Latencia de respuesta en milisegundos', 'gauge', [
      `portal_http_latency_ms{quantile="0.5"} ${s.latencyMs.p50}`,
      `portal_http_latency_ms{quantile="0.95"} ${s.latencyMs.p95}`,
      `portal_http_latency_ms{quantile="0.99"} ${s.latencyMs.p99}`,
    ]);
    metric('portal_users_online', 'Usuarios con sesión activa', 'gauge', [`portal_users_online ${s.usersOnline}`]);
    metric('portal_accounts_active', 'Cuentas vigentes con saldo', 'gauge', [`portal_accounts_active ${s.accountsActive}`]);
    metric('portal_orders_total', 'Órdenes por estado', 'counter', [
      `portal_orders_total{state="paid"} ${s.orders.paid}`,
      `portal_orders_total{state="declined"} ${s.orders.declined}`,
    ]);
    metric('portal_revenue_gtq_total', 'Ingresos simulados en quetzales', 'counter', [`portal_revenue_gtq_total ${s.revenueGTQ}`]);
    metric('portal_traffic_bytes_total', 'Tráfico acumulado reportado por pfSense', 'counter', [
      `portal_traffic_bytes_total{direction="in"} ${s.bytesIn}`,
      `portal_traffic_bytes_total{direction="out"} ${s.bytesOut}`,
    ]);
    metric('portal_radius_requests_total', 'Resultados de autenticación RADIUS', 'counter', [
      `portal_radius_requests_total{result="accept"} ${s.radius.accepted}`,
      `portal_radius_requests_total{result="reject"} ${s.radius.rejected}`,
      `portal_radius_requests_total{result="dropped"} ${s.radius.dropped}`,
    ]);
    return out.join('\n') + '\n';
  }
}

const round = (n) => Math.round(n * 100) / 100;

module.exports = { Metrics };
