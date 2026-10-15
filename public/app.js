'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { plans: [], plan: null, config: {}, sessionId: sessionStorage.getItem('sessionId') || null, idemKey: null, redirUrl: '' };

  // ---------- utilidades ----------
  const fmtGTQ = (n) => `Q${Number(n).toLocaleString('es-GT')}`;
  const fmtDuration = (s) => {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d >= 1) return d === 1 && !h ? '1 día' : `${d} d ${h} h`;
    if (h >= 1) return m ? `${h} h ${m} min` : `${h} h`;
    return `${m} min`;
  };
  const fmtDate = (ms) => new Date(ms).toLocaleDateString('es-GT', { day: 'numeric', month: 'long', year: 'numeric' });
  const fmtSpeed = (kbps) => `${kbps / 1000} Mbps`;

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    });
    let data = {};
    try { data = await res.json(); } catch { /* respuesta vacía */ }
    if (!res.ok) { const e = new Error(data.message || 'Error de comunicación'); e.status = res.status; e.data = data; throw e; }
    return data;
  }

  function setBusy(btn, busy, label) {
    btn.disabled = busy;
    if (busy) { btn.dataset.label = btn.textContent; btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Procesando…'; }
    else btn.textContent = label || btn.dataset.label || btn.textContent;
  }

  function showFieldErrors(fields = {}, ids) {
    ids.forEach((k) => {
      const err = $(`err-${k}`);
      if (!err) return;
      err.textContent = fields[k] || '';
      const input = $(k) || $('terms');
      if (input && input.closest('.field')) input.closest('.field').classList.toggle('invalid', !!fields[k]);
    });
    const first = ids.find((k) => fields[k]);
    if (first) ($(first) || $('terms')).focus();
  }

  // ---------- navegación entre pasos ----------
  function go(step) {
    for (let i = 1; i <= 4; i++) $(`step-${i}`).hidden = i !== step;
    document.querySelectorAll('#steps li').forEach((li) => {
      const n = Number(li.dataset.step);
      li.classList.toggle('done', n < step);
      if (n === step) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
    const h = $(`h-${step}`);
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.back))));

  // ---------- paso 1: paquetes ----------
  function renderPlans() {
    const box = $('plans');
    box.replaceChildren();
    state.plans.forEach((p) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'plan';
      btn.setAttribute('aria-pressed', String(state.plan && state.plan.id === p.id));
      btn.innerHTML = `${p.featured ? '<span class="flag">MÁS ELEGIDO</span>' : ''}
        <span class="name"></span><span class="price"></span><span class="blurb"></span><span class="speed"></span>`;
      btn.querySelector('.name').textContent = p.name;
      btn.querySelector('.price').innerHTML = `${fmtGTQ(p.priceGTQ)} <small></small>`;
      btn.querySelector('.price small').textContent = `por ${p.name}`;
      btn.querySelector('.blurb').textContent = p.blurb;
      btn.querySelector('.speed').textContent = `Hasta ${fmtSpeed(p.downKbps)} de bajada`;
      btn.addEventListener('click', () => { state.plan = p; $('to-2').disabled = false; renderPlans(); });
      box.appendChild(btn);
    });
  }
  $('to-2').addEventListener('click', () => go(2));

  // ---------- paso 2: datos ----------
  $('form-datos').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = {};
    const name = $('name').value.trim(), email = $('email').value.trim();
    if (name.length < 3) fields.name = 'Escribe tu nombre completo.';
    if (!/^\S+@\S+\.\S{2,}$/.test(email)) fields.email = 'Escribe un correo válido.';
    if (!$('terms').checked) fields.acceptTerms = 'Debes aceptar las condiciones del servicio.';
    showFieldErrors(fields, ['name', 'email', 'acceptTerms']);
    if (Object.keys(fields).length) return;

    $('alert-2').hidden = true;
    setBusy($('submit-2'), true);
    try {
      const r = await api('/api/register', { method: 'POST', body: JSON.stringify({ name, email, planId: state.plan.id, acceptTerms: true }) });
      state.sessionId = r.sessionId;
      state.idemKey = crypto.randomUUID();
      sessionStorage.setItem('sessionId', r.sessionId);
      renderSummary();
      go(3);
    } catch (err) {
      if (err.data && err.data.fields) showFieldErrors(err.data.fields, ['name', 'email', 'acceptTerms']);
      else { $('alert-2').textContent = err.message; $('alert-2').hidden = false; }
    } finally { setBusy($('submit-2'), false, 'Continuar al pago'); }
  });

  // ---------- paso 3: pago ----------
  function renderSummary() {
    const p = state.plan;
    $('order-summary').innerHTML = '<div class="line"><span>Paquete</span><strong></strong></div><div class="line"><span>Velocidad</span><span></span></div><div class="line total"><span>Total a pagar</span><span></span></div>';
    const [a, b, c] = $('order-summary').querySelectorAll('.line');
    a.querySelector('strong').textContent = p.name;
    b.lastElementChild.textContent = `${fmtSpeed(p.downKbps)} ↓ / ${fmtSpeed(p.upKbps)} ↑`;
    c.lastElementChild.textContent = fmtGTQ(p.priceGTQ);
  }

  $('number').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 19).replace(/(.{4})/g, '$1 ').trim(); });
  $('exp').addEventListener('input', (e) => {
    let v = e.target.value.replace(/\D/g, '').slice(0, 4);
    if (v.length >= 3) v = `${v.slice(0, 2)}/${v.slice(2)}`;
    e.target.value = v;
  });
  $('cvc').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });

  $('form-pago').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('alert-3').hidden = true;
    setBusy($('submit-3'), true);
    const card = { holder: $('holder').value, number: $('number').value, exp: $('exp').value, cvc: $('cvc').value };
    try {
      const r = await api('/api/payments/mock', {
        method: 'POST',
        headers: { 'Idempotency-Key': state.idemKey },
        body: JSON.stringify({ sessionId: state.sessionId, card }),
      });
      $('number').value = ''; $('cvc').value = ''; $('exp').value = '';
      showSuccess(r.credentials, r.account, { brand: r.brand, last4: r.last4, transactionId: r.transactionId });
    } catch (err) {
      if (err.data && err.data.fields) showFieldErrors(err.data.fields, ['holder', 'number', 'exp', 'cvc']);
      else {
        let msg = err.message;
        if (err.data && err.data.attemptsLeft !== undefined) msg += ` Te quedan ${err.data.attemptsLeft} intentos.`;
        $('alert-3').textContent = msg; $('alert-3').hidden = false;
        state.idemKey = crypto.randomUUID(); // un intento nuevo necesita clave nueva
        if (err.status === 410 || err.status === 429) { sessionStorage.removeItem('sessionId'); }
      }
    } finally { setBusy($('submit-3'), false, 'Pagar'); }
  });

  // ---------- paso 4: conexión ----------
  function showSuccess(credentials, account, receipt) {
    const plan = state.plans.find((p) => p.id === account.planId) || state.plan;
    $('creds-block').hidden = !credentials;
    $('creds-gone').hidden = !!credentials;
    if (credentials) { $('c-user').textContent = credentials.username; $('c-pass').textContent = credentials.password; }

    const facts = [
      ['Paquete', plan ? plan.name : '—'],
      ['Tiempo disponible', fmtDuration(account.remainingSeconds)],
      ['Úsalo antes del', fmtDate(account.expiresAt)],
      ['Comprobante', receipt && receipt.transactionId ? `${receipt.brand} ···· ${receipt.last4}` : '—'],
    ];
    $('facts').className = 'facts';
    $('facts').replaceChildren(...facts.map(([k, v]) => {
      const d = document.createElement('div'); d.className = 'fact';
      d.innerHTML = '<div class="k"></div><div class="v"></div>';
      d.firstChild.textContent = k; d.lastChild.textContent = v; return d;
    }));
    if (receipt && receipt.transactionId) {
      const t = document.createElement('div'); t.className = 'fact';
      t.innerHTML = '<div class="k">N.º de transacción</div><div class="v"></div>';
      t.lastChild.textContent = receipt.transactionId; $('facts').appendChild(t);
    }

    const canAutoConnect = !!state.config.loginUrl && !!credentials;
    $('connect').hidden = !canAutoConnect;
    $('how').replaceChildren(...[
      'Conéctate a la red Wi-Fi del servicio.',
      canAutoConnect ? 'Toca “Conectarme ahora”: iniciarás sesión sin escribir nada.' : 'Cuando se abra la página de acceso, escribe tu usuario y contraseña.',
      'Listo. Verás el tiempo restante en la página de acceso.',
    ].map((t) => { const li = document.createElement('li'); li.textContent = t; return li; }));

    $('connect').onclick = () => {
      const f = $('form-connect');
      f.action = state.config.loginUrl;
      f.elements.auth_user.value = credentials.username;
      f.elements.auth_pass.value = credentials.password;
      f.elements.redirurl.value = state.redirUrl;
      f.submit();
    };
    sessionStorage.removeItem('sessionId');
    go(4);
  }

  document.querySelectorAll('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
    const text = $(btn.dataset.copy).textContent;
    try { await navigator.clipboard.writeText(text); toast('Copiado'); }
    catch {
      const range = document.createRange(); range.selectNodeContents($(btn.dataset.copy));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); toast('Selecciona y copia el texto');
    }
  }));
  $('print').addEventListener('click', () => window.print());
  $('again').addEventListener('click', () => { sessionStorage.removeItem('sessionId'); location.reload(); });

  // ---------- arranque ----------
  async function init() {
    try {
      const [cfg, plans] = await Promise.all([api('/api/config'), api('/api/plans')]);
      state.config = cfg; state.plans = plans.plans;
      $('brand-name').textContent = cfg.portalName; $('foot-name').textContent = `${cfg.portalName} · Internet prepago`;
      document.title = `Internet prepago · ${cfg.portalName}`;
      const mail = `mailto:${cfg.supportEmail}`;
      $('foot-support').href = mail; $('support-link').href = mail;
    } catch {
      $('plans').textContent = 'No pudimos cargar los paquetes. Revisa tu conexión e intenta de nuevo.';
      go(1); return;
    }
    // URL original que el usuario quería abrir (la entrega el portal cautivo)
    const r = new URLSearchParams(location.search).get('redirurl');
    if (r && /^https?:\/\//i.test(r)) state.redirUrl = r;

    renderPlans();
    // Si recarga la página a mitad de la compra, se retoma donde iba.
    if (state.sessionId) {
      try {
        const s = await api(`/api/sessions/${state.sessionId}`);
        state.plan = state.plans.find((p) => p.id === s.planId) || null;
        if (s.state === 'paid' && s.account) { state.idemKey = null; showSuccess(s.credentials, s.account, s.receipt); return; }
        if (s.state === 'registered' && !s.expired && state.plan) { state.idemKey = crypto.randomUUID(); renderSummary(); go(3); return; }
      } catch { /* la sesión ya no existe */ }
      sessionStorage.removeItem('sessionId'); state.sessionId = null;
    }
    go(1);
  }
  init();
})();
