'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const fmtUptime = (s) => {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min ${s % 60} s`;
  };
  const fmtBytes = (b) => b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} kB`;

  function drawLine(canvas, points, { unit, color }) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const pad = { l: 44, r: 8, t: 10, b: 20 };
    const max = Math.max(1, ...points) * 1.2;
    const x = (i) => pad.l + (i / Math.max(1, points.length - 1)) * (w - pad.l - pad.r);
    const y = (v) => pad.t + (1 - v / max) * (h - pad.t - pad.b);

    ctx.strokeStyle = css('--border'); ctx.fillStyle = css('--muted'); ctx.font = '11px system-ui, sans-serif'; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i, yy = y(v);
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
      ctx.fillText(v.toFixed(v < 10 ? 1 : 0) + unit, 4, yy + 4);
    }
    if (points.length < 2) { ctx.fillText('Recopilando datos…', pad.l + 8, h / 2); return; }
    const g = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
    g.addColorStop(0, color + '55'); g.addColorStop(1, color + '00');
    ctx.beginPath(); points.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.lineTo(x(points.length - 1), h - pad.b); ctx.lineTo(x(0), h - pad.b); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); points.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.stroke();
  }

  async function tick() {
    const t0 = performance.now();
    try {
      const [health, stats] = await Promise.all([
        fetch('/healthz', { cache: 'no-store' }).then((r) => r.json()),
        fetch('/api/stats', { cache: 'no-store' }).then((r) => r.json()),
      ]);
      const rtt = performance.now() - t0;
      const s = stats.summary, last = stats.history[stats.history.length - 1];
      const ok = health.status === 'ok';
      $('pill').textContent = ok ? 'Todos los sistemas operativos' : 'Servicio degradado';
      $('pill').classList.toggle('bad', !ok);
      $('s-portal').textContent = ok ? 'Operativo' : 'Degradado'; $('s-portal').classList.toggle('bad', !ok);
      $('k-uptime').textContent = fmtUptime(s.uptimeSeconds);
      $('k-online').textContent = s.usersOnline;
      $('k-accounts').textContent = `${s.accountsActive} cuentas vigentes`;
      $('k-lat').textContent = `${Math.round(rtt)} ms`;
      $('k-lat-sub').textContent = `servidor p50 ${s.latencyMs.p50} ms · p95 ${s.latencyMs.p95} ms`;
      const bps = last ? last.bps : 0;
      $('k-bw').textContent = `${(bps / 1e6).toFixed(2)} Mbps`;
      $('k-bytes').textContent = `↓ ${fmtBytes(s.bytesIn)} · ↑ ${fmtBytes(s.bytesOut)} acumulados`;
      $('s-radius').textContent = `${s.radius.accepted} aceptadas · ${s.radius.rejected} rechazadas`;
      $('s-orders').textContent = `${s.orders.paid} aprobados · ${s.orders.declined} rechazados`;
      $('updated').textContent = `Actualizado ${new Date(stats.serverTime).toLocaleTimeString('es-GT')}`;
      drawLine($('c-bw'), stats.history.map((p) => p.bps / 1e6), { unit: '', color: css('--brand') });
      drawLine($('c-lat'), stats.history.map((p) => p.p95), { unit: '', color: '#f59e0b' });
    } catch {
      $('pill').textContent = 'Sin conexión con el servicio'; $('pill').classList.add('bad');
      $('s-portal').textContent = 'Sin respuesta'; $('s-portal').classList.add('bad');
    }
  }
  tick();
  setInterval(tick, 5000);
  window.addEventListener('resize', tick);
})();
