'use strict';
/**
 * Almacén persistente en un archivo JSON con escritura atómica
 * (archivo temporal + rename) para no corromper datos si el proceso se corta.
 * Nunca guarda números de tarjeta ni contraseñas en claro.
 */
const fs = require('node:fs');
const path = require('node:path');

class Store {
  constructor({ file, persist }) {
    this.file = file;
    this.persist = persist;
    this.orders = new Map();      // id de sesión/orden -> orden
    this.accounts = new Map();    // usuario -> cuenta
    this.payments = new Map();    // clave de idempotencia -> resultado
    this.counters = { accepted: 0, rejected: 0, acctPackets: 0, bytesIn: 0, bytesOut: 0, revenueGTQ: 0, declined: 0 };
    this._timer = null;
    this.mtime = 0;
    this._load();
  }

  _load() {
    if (!this.persist || !fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.mtime = fs.statSync(this.file).mtimeMs;
      this.orders.clear(); this.accounts.clear(); this.payments.clear();
      (raw.orders || []).forEach((o) => this.orders.set(o.id, o));
      (raw.accounts || []).forEach((a) => this.accounts.set(a.username, a));
      (raw.payments || []).forEach(([k, v]) => this.payments.set(k, v));
      Object.assign(this.counters, raw.counters || {});
    } catch (err) {
      // Conserva el archivo dañado en lugar de sobrescribirlo.
      const backup = `${this.file}.corrupto-${Date.now()}`;
      fs.renameSync(this.file, backup);
      console.error(`[store] archivo dañado, respaldado en ${backup}: ${err.message}`);
    }
  }

  snapshot() {
    return {
      version: 1,
      orders: [...this.orders.values()],
      accounts: [...this.accounts.values()],
      payments: [...this.payments.entries()],
      counters: this.counters,
    };
  }

  /** Programa un guardado diferido para agrupar escrituras seguidas. */
  save() {
    if (!this.persist || this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 250);
    this._timer.unref();
  }

  flush() {
    if (!this.persist) return;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.snapshot()), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.mtime = fs.statSync(this.file).mtimeMs;
  }

  /**
   * Si el archivo cambió porque OTRO proceso escribió (p. ej. el servidor activo
   * en un par activo/respaldo con disco compartido), recarga el estado.
   * Pensado para un solo escritor a la vez; no sirve para activo/activo.
   */
  syncFromDisk() {
    if (!this.persist || this._timer) return false; // hay cambios propios pendientes: no pisarlos
    try {
      const m = fs.statSync(this.file).mtimeMs;
      if (m > this.mtime) { this._load(); return true; }
    } catch { /* el archivo aún no existe */ }
    return false;
  }

  /** Comprueba que el almacén se puede escribir (usado por /healthz). */
  writable() {
    if (!this.persist) return true;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.accessSync(path.dirname(this.file), fs.constants.W_OK);
      return true;
    } catch { return false; }
  }
}

module.exports = { Store };
