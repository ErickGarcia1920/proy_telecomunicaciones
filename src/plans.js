'use strict';
/** Catálogo de paquetes. Precios en quetzales; velocidades en kbps. */
const PLANS = Object.freeze([
  { id: 'hora',   name: '1 hora',   seconds: 3600,        priceGTQ: 5,   downKbps: 3000,  upKbps: 1000, blurb: 'Para resolver algo puntual.' },
  { id: 'dia',    name: '1 día',    seconds: 24 * 3600,   priceGTQ: 15,  downKbps: 5000,  upKbps: 2000, blurb: 'Navega y trabaja todo el día.' },
  { id: 'semana', name: '7 días',   seconds: 7 * 86400,   priceGTQ: 60,  downKbps: 5000,  upKbps: 2000, blurb: 'Una semana completa de conexión.', featured: true },
  { id: 'mes',    name: '30 días',  seconds: 30 * 86400,  priceGTQ: 180, downKbps: 8000,  upKbps: 3000, blurb: 'La mejor relación precio y tiempo.' },
]);

const byId = (id) => PLANS.find((p) => p.id === id) || null;

module.exports = { PLANS, byId };
