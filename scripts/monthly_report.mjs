/**
 * Genera la tabla resumen mensual de Pignus y Graciela.
 *
 * Uso:
 *   node scripts/monthly_report.mjs [YYYY-MM]
 *
 * Si no se pasa mes, usa el mes anterior al corriente.
 *
 * Requiere cuatro archivos JSON en $TEMP (o en la ruta que indique REPORT_DATA_DIR):
 *   port_hist.json       ← wrangler kv key get ... "portfolio_history"
 *   pos_hist.json        ← wrangler kv key get ... "positions_history"
 *   deposits.json        ← wrangler kv key get ... "deposits"
 *   graciela_ops.json    ← wrangler kv key get ... "graciela_operations"
 *
 * Ver README.md § Reporte mensual para los comandos de fetch.
 */

import { readFileSync } from "fs";

const KV_NS = "8c1461c1de29450ba42172257fcfdeda";

// ─── Período ──────────────────────────────────────────────────────────────────
const arg = process.argv[2];
let [year, month] = arg
  ? arg.split("-").map(Number)
  : (() => {
      const d = new Date();
      d.setMonth(d.getMonth() - 1);
      return [d.getFullYear(), d.getMonth() + 1];
    })();

const monthStr   = String(month).padStart(2, "0");
const startDate  = `${year}-${monthStr}-01`;
const endYear    = month === 12 ? year + 1 : year;
const endMonth   = month === 12 ? 1 : month + 1;
const endDate    = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;

const MONTH_NAMES = ["enero","febrero","marzo","abril","mayo","junio",
                     "julio","agosto","septiembre","octubre","noviembre","diciembre"];
const monthLabel = `${MONTH_NAMES[month - 1]} ${year}`;

// ─── Lectura de archivos ──────────────────────────────────────────────────────
const dir = process.env.REPORT_DATA_DIR || process.env.TEMP || "/tmp";
function load(name) {
  const raw = readFileSync(`${dir}/${name}`, "utf8").replace(/^﻿/, "");
  return JSON.parse(raw);
}

const portHistory = load("port_hist.json");
const posHistory  = load("pos_hist.json");
const deps        = load("deposits.json");
const ops         = load("graciela_ops.json");

// ─── Helpers de Graciela ──────────────────────────────────────────────────────
function computeGracielaPositions(opsToDate) {
  const h = {};
  for (const op of opsToDate) {
    const sym = op.symbol || op.ticker;
    if (op.type === "buy") {
      if (!h[sym]) h[sym] = { qty: 0, totalCost: 0, avgCost: 0 };
      h[sym].totalCost += op.price * op.qty;
      h[sym].qty       += op.qty;
      h[sym].avgCost    = h[sym].qty > 0 ? h[sym].totalCost / h[sym].qty : 0;
    } else if (op.type === "sell") {
      if (h[sym]) h[sym].qty -= op.qty;
    }
  }
  return h;
}

function computeGracielaCash(opsToDate) {
  let cash = 0;
  for (const op of opsToDate) {
    if (op.type === "deposit")    cash += op.amount || 0;
    if (op.type === "withdrawal") cash -= op.amount || 0;
    if (op.type === "buy")        cash -= op.price * op.qty + (op.commission || 0);
    if (op.type === "sell")       cash += op.price * op.qty - (op.commission || 0);
  }
  return cash;
}

const posHistByDate = {};
for (const p of posHistory) posHistByDate[p.date] = p;

const sortedOps = [...ops].sort((a, b) => a.date.localeCompare(b.date));

function gracielaValue(date) {
  const dayPos = posHistByDate[date];
  if (!dayPos) return 0;
  const opsToDate = sortedOps.filter(op => op.date <= date);
  const holdings  = computeGracielaPositions(opsToDate);
  const unitPrice = {};
  for (const a of dayPos.activos || []) { if (a.q > 0) unitPrice[a.s] = a.v / a.q; }
  let total = 0;
  for (const [sym, pos] of Object.entries(holdings)) {
    const qty = Math.max(0, pos.qty);
    if (qty > 0 && unitPrice[sym]) total += qty * unitPrice[sym];
  }
  total += Math.max(0, computeGracielaCash(opsToDate));
  return total;
}

function pignusValue(date) {
  const combined = portHistory.find(s => s.date === date);
  if (!combined) return null;
  return Math.max(0, combined.totalARS - gracielaValue(date));
}

// ─── Valores del período ──────────────────────────────────────────────────────
const pignusStart  = pignusValue(startDate);
const pignusEnd    = pignusValue(endDate);
const gracielaEnd  = portHistory.find(s => s.date === endDate)?.totalARS - pignusEnd;

const gracielaDepositDates = new Set(
  ops.filter(op => op.type === "deposit" || op.type === "withdrawal").map(op => op.date)
);
const pignusDeposits = deps.filter(d => !gracielaDepositDates.has(d.date));

// Pignus: aportes en el período
const pignusAportesMes = pignusDeposits
  .filter(d => d.date >= startDate && d.date < endDate)
  .reduce((s, d) => s + d.amount, 0);

// Pignus: TWR acumulado (todos los aportes)
const pignusTotalAportado = pignusDeposits.reduce((s, d) => s + d.amount, 0);
// Para TWR necesitamos el valor antes de cada aporte; aproximamos con ganancia neta simple
const pignusAccGain    = pignusEnd - pignusTotalAportado;
const pignusAccGainPct = pignusTotalAportado ? (pignusAccGain / pignusTotalAportado) * 100 : 0;

// Graciela: aportes en el período
const gracielaDepositsInPeriod = ops
  .filter(op => op.type === "deposit" && op.date >= startDate && op.date < endDate)
  .reduce((s, op) => s + op.amount, 0);

const gracielaTotalAportado = ops
  .filter(op => op.type === "deposit")
  .reduce((s, op) => s + op.amount, 0);

const gracielaAccGain    = gracielaEnd - gracielaTotalAportado;
const gracielaAccGainPct = gracielaTotalAportado ? (gracielaAccGain / gracielaTotalAportado) * 100 : 0;

// Resultados del mes
const pignusJuneResult  = pignusEnd != null && pignusStart != null ? pignusEnd - pignusStart - pignusAportesMes : null;
const pignusJunePct     = pignusStart ? (pignusJuneResult / pignusStart) * 100 : null;

const gracielaStart     = 0; // Graciela opens the month with $0 if she started this month, else value at start
const gracielaJuneResult = gracielaEnd - gracielaDepositsInPeriod;
const gracielaJunePct    = gracielaDepositsInPeriod
  ? (gracielaJuneResult / gracielaDepositsInPeriod) * 100
  : null;

// SPY del período: inicio del mes → último día hábil del mes
// Se usa el último snapshot con SPY estrictamente antes del endDate (= primer día del mes sig.)
function spyPrice(date, before = false) {
  const snaps = [...posHistory]
    .filter(s => before ? s.date < date : s.date <= date)
    .filter(s => s.activos?.some(a => a.s === "SPY"));
  const snap = snaps.slice(-1)[0];
  const spy = snap?.activos?.find(a => a.s === "SPY");
  return spy && spy.q > 0 ? { price: spy.v / spy.q, date: snap.date } : null;
}
const spyStartObj = spyPrice(startDate);
const spyEndObj   = spyPrice(endDate, true); // último día hábil del mes, no el día 1 del sig.
const spyStart    = spyStartObj?.price;
const spyEnd      = spyEndObj?.price;
const spyPct      = spyStart && spyEnd ? ((spyEnd - spyStart) / spyStart) * 100 : null;

// ─── Fetch MP VCP ─────────────────────────────────────────────────────────────
async function fetchVCP(date) {
  const [y, m, d] = date.split("-");
  const url = `https://api.argentinadatos.com/v1/finanzas/fci/mercadoDinero/${y}/${m}/${d}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const entry = data.find(e => /Mercado.*Clase A/i.test(e.fondo));
    return entry?.vcp ?? null;
  } catch { return null; }
}

// ─── Formateo ─────────────────────────────────────────────────────────────────
function fmt(n, decimals = 2) {
  if (n == null) return "?";
  return n.toLocaleString("es-AR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function money(n) { return n == null ? "?" : `$${fmt(n)}`; }
function pct(n)   { return n == null ? "?" : `${n >= 0 ? "+" : ""}${fmt(n)}%`; }
function sign(n)  { return n >= 0 ? "+" : ""; }

// ─── Main ─────────────────────────────────────────────────────────────────────
const [mpStart, mpEnd] = await Promise.all([fetchVCP(startDate), fetchVCP(endDate)]);

// Si la API no tiene dato para endDate, usar último disponible del portfolio_history
const mpEndFallback = mpEnd ?? portHistory.filter(s => s.date <= endDate && s.mpVcp).slice(-1)[0]?.mpVcp;
const mpMonthly = mpStart && mpEndFallback ? ((mpEndFallback / mpStart) - 1) * 100 : null;
const mpTNA     = mpMonthly != null ? (Math.pow(1 + mpMonthly / 100, 12) - 1) * 100 : null;

console.log(`\n${"═".repeat(60)}`);
console.log(`  RESUMEN MENSUAL — ${monthLabel.toUpperCase()}`);
console.log(`${"═".repeat(60)}\n`);

console.log("CUENTA PIGNUS");
console.log("─".repeat(40));
console.log(`  Capital al inicio (${startDate}):  ${money(pignusStart)}`);
console.log(`  Aportes:                         $${fmt(pignusAportesMes)}`);
console.log(`  Retiros:                         $0`);
console.log(`  Valor al ${endDate}:           ${money(pignusEnd)}`);
console.log(`  Resultado del mes:               ${sign(pignusJuneResult)}${money(pignusJuneResult)} (${pct(pignusJunePct)})`);
console.log(`  Resultado acumulado:             ${sign(pignusAccGain)}${money(pignusAccGain)} (${pct(pignusAccGainPct)})`);

console.log();
console.log("CUENTA GRACIELA");
console.log("─".repeat(40));
console.log(`  Capital al inicio (${startDate}):  ${money(0)}`);
console.log(`  Aportes:                         ${money(gracielaDepositsInPeriod)}`);
console.log(`  Retiros:                         $0`);
console.log(`  Valor al ${endDate}:           ${money(gracielaEnd)}`);
console.log(`  Resultado del mes:               ${sign(gracielaJuneResult)}${money(gracielaJuneResult)} (${pct(gracielaJunePct)})`);
console.log(`  Resultado acumulado:             ${sign(gracielaAccGain)}${money(gracielaAccGain)} (${pct(gracielaAccGainPct)})`);

console.log();
console.log(`COMPARACIÓN CON REFERENCIAS DE MERCADO — ${monthLabel.toUpperCase()}`);
console.log("─".repeat(40));
console.log(`  Cartera Pignus:   ${pct(pignusJunePct)}`);
console.log(`  Cartera Graciela: ${pct(gracielaJunePct)}`);
console.log(`  S&P 500 (CEDEAR): ${pct(spyPct)}   (${spyStartObj?.date} ${money(spyStart)} → ${spyEndObj?.date} ${money(spyEnd)})`);
if (mpMonthly != null)
  console.log(`  Mercado Pago:     ${pct(mpMonthly)} mensual  (~${fmt(mpTNA, 1)}% TNA)`);
else
  console.log(`  Mercado Pago:     (sin dato para ${endDate} — verificar API argentinadatos.com)`);

console.log();
