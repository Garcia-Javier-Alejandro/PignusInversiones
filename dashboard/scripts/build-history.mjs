/**
 * build-history.mjs
 *
 * Reconstruye snapshots sintéticos de la cartera desde el 09/03/26,
 * usando Yahoo Finance para CEDEARs, argentinadatos.com para MPVcp y MEP,
 * e interpolación lineal para bonos (TZX26, TX26).
 *
 * Al finalizar, escribe los snapshots en el KV de producción via wrangler CLI.
 *
 * Uso:
 *   node dashboard/scripts/build-history.mjs [--dry-run]
 */

import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";

const KV_ID   = "8c1461c1de29450ba42172257fcfdeda";
const DRY_RUN = process.argv.includes("--dry-run");

// ─── Historial de transacciones ────────────────────────────────────────────────
// Fuente: MovimientosHistoricos + OperacionesFinalizadas CSVs
// qty en unidades reales (no VN para bonos — ver nota abajo)
// Para bonos (TZX26, TX26): qty=VN en pesos nominales, precio=por cada 100 VN
const TRANSACTIONS = [
  // 09/03 — primeras compras (depósito 8.1M fue el 08/03)
  { date: "2026-03-09", op: "buy",  sym: "COPX",   qty:     59,      ppc:  8320     },
  { date: "2026-03-09", op: "buy",  sym: "URA",    qty:     68,      ppc: 14438.97  },
  { date: "2026-03-09", op: "buy",  sym: "MELI",   qty:     22,      ppc: 21710     },
  { date: "2026-03-09", op: "buy",  sym: "GGAL",   qty:    161,      ppc:  6123.32  },
  { date: "2026-03-09", op: "buy",  sym: "GLD",    qty:    105,      ppc: 13960     },
  { date: "2026-03-09", op: "fci",  sym: "IOLCAMA",ars:   1100000                  },
  // 10/03
  { date: "2026-03-10", op: "buy",  sym: "TZX26",  qty: 420875,      ppc:  352.9   },
  // 11/03
  { date: "2026-03-11", op: "buy",  sym: "MSFT",   qty:     24,      ppc: 19920    },
  { date: "2026-03-11", op: "buy",  sym: "VIST",   qty:     16,      ppc: 29360    },
  // 12/03
  { date: "2026-03-12", op: "buy",  sym: "VIST",   qty:      3,      ppc: 29700    },
  // 25/03
  { date: "2026-03-25", op: "sell", sym: "URA",    qty:     35,      prc: 14542.86 },
  { date: "2026-03-25", op: "fci",  sym: "IOLCAMA",ars:  -544332.05               }, // rescate (negativo)
  // 27/03
  { date: "2026-03-27", op: "buy",  sym: "TX26",   qty:  81546,      ppc: 1313.23  },
  // 01/04
  { date: "2026-04-01", op: "fci",  sym: "IOLCAMA",ars:     5236.62               },
  // 08/04
  { date: "2026-04-08", op: "sell", sym: "VIST",   qty:     19,      prc: 31000    },
  { date: "2026-04-08", op: "buy",  sym: "NU",     qty:     44,      ppc: 11050    },
  { date: "2026-04-08", op: "buy",  sym: "COPX",   qty:     11,      ppc:  8697.27 },
  // 10/04 — segundo depósito 4M (solo cash, no posiciones)
  { date: "2026-04-10", op: "deposit", ars: 4000000 },
  // 15/04
  { date: "2026-04-15", op: "buy",  sym: "TZX26",  qty:  48625,      ppc:  375.25  },
  { date: "2026-04-15", op: "buy",  sym: "SLB",    qty:     15,      ppc: 25540    },
  { date: "2026-04-15", op: "buy",  sym: "ASML",   qty:     58,      ppc: 14470    },
  { date: "2026-04-15", op: "buy",  sym: "SPY",    qty:     15,      ppc: 51150    },
  { date: "2026-04-15", op: "buy",  sym: "XLV",    qty:     78,      ppc:  7555    },
  { date: "2026-04-15", op: "buy",  sym: "VIST",   qty:     12,      ppc: 32060    },
  { date: "2026-04-15", op: "buy",  sym: "XOM",    qty:     17,      ppc: 21780    },
  { date: "2026-04-15", op: "buy",  sym: "XLE",    qty:      9,      ppc: 40880    },
  { date: "2026-04-15", op: "buy",  sym: "MSFT",   qty:      5,      ppc: 19650    },
];

// Tickers de Yahoo Finance (todos con sufijo .BA)
const YF_TICKERS = {
  COPX: "COPX.BA", URA: "URA.BA", MELI: "MELI.BA", GGAL: "GGAL.BA",
  GLD: "GLD.BA",  MSFT: "MSFT.BA", VIST: "VIST.BA", NU: "NU.BA",
  SLB: "SLB.BA",  ASML: "ASML.BA", SPY: "SPY.BA",  XLV: "XLV.BA",
  XOM: "XOM.BA",  XLE: "XLE.BA",
};

// Bonos: precio conocido en fechas clave (precio por cada 100 VN)
// Usamos interpolación lineal entre puntos conocidos.
const BOND_KNOWN_PRICES = {
  TZX26: [
    { date: "2026-03-10", price: 352.9  },
    { date: "2026-04-15", price: 375.25 },
    { date: "2026-04-17", price: 375.7  },
  ],
  TX26: [
    { date: "2026-03-27", price: 1313.23 },
    { date: "2026-04-15", price: 1341.5  },
    { date: "2026-04-17", price: 1341.5  },
  ],
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function dateToMs(d) { return new Date(d + "T12:00:00Z").getTime(); }

/** Precio interpolado linealmente de un bono para una fecha dada */
function bondPrice(sym, date) {
  const pts = BOND_KNOWN_PRICES[sym];
  if (!pts) return null;
  if (date <= pts[0].date) return pts[0].price;
  if (date >= pts[pts.length - 1].date) return pts[pts.length - 1].price;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (date >= a.date && date <= b.date) {
      const t = (dateToMs(date) - dateToMs(a.date)) / (dateToMs(b.date) - dateToMs(a.date));
      return a.price + t * (b.price - a.price);
    }
  }
  return pts[pts.length - 1].price;
}

/** Nearest neighbor en un array de {date, value} */
function nearest(arr, date) {
  let best = null;
  for (const p of arr) {
    if (p.date <= date && (!best || p.date > best.date)) best = p;
  }
  return best?.value ?? null;
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

/** Descarga historial Yahoo Finance para un ticker → Map<date, price> */
async function fetchYF(ticker) {
  try {
    const json = await fetchJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=2y`
    );
    const result = json.chart?.result?.[0];
    if (!result) return {};
    const timestamps = result.timestamp || [];
    const closes = result.indicators?.adjclose?.[0]?.adjclose
                || result.indicators?.quote?.[0]?.close || [];
    const map = {};
    timestamps.forEach((ts, i) => {
      if (closes[i] > 0) {
        map[new Date(ts * 1000).toISOString().split("T")[0]] = closes[i];
      }
    });
    return map;
  } catch (e) {
    console.warn(`  ⚠ YF ${ticker}: ${e.message}`);
    return {};
  }
}

/** Historial VCP de Mercado Fondo Clase A → Map<date, vcp> */
async function fetchMPHistory() {
  const map = {};
  // argentinadatos tiene endpoint por día: /v1/finanzas/fci/mercadoDinero/{year}/{month}/{day}
  // Para obtener el rango histórico, usamos el endpoint por año/mes si existe,
  // o iteramos días hábiles del período.
  const days = businessDays("2026-03-09", "2026-04-17");
  // Procesar en lotes para no saturar la API
  for (let i = 0; i < days.length; i += 5) {
    const batch = days.slice(i, i + 5);
    await Promise.all(batch.map(async date => {
      const [y, m, d] = date.split("-");
      try {
        const data = await fetchJson(
          `https://api.argentinadatos.com/v1/finanzas/fci/mercadoDinero/${y}/${m}/${d}`
        );
        const entry = (Array.isArray(data) ? data : [])
          .find(e => e.fondo === "Mercado Fondo - Clase A");
        if (entry?.vcp) map[date] = entry.vcp;
      } catch { /* feriado o sin datos */ }
    }));
  }
  return map;
}

/** Historial MEP (dólar implícito) desde argentinadatos → Map<date, mep> */
async function fetchMEPHistory() {
  try {
    const data = await fetchJson("https://api.argentinadatos.com/v1/cotizaciones/dolares/bolsa");
    const map = {};
    for (const entry of (Array.isArray(data) ? data : [])) {
      if (entry.fecha && entry.venta) {
        map[entry.fecha.split("T")[0]] = entry.venta;
      }
    }
    return map;
  } catch (e) {
    console.warn("  ⚠ MEP history:", e.message);
    return {};
  }
}

/** Genera lista de días hábiles entre dos fechas (lunes–viernes, no feriados) */
function businessDays(from, to) {
  const days = [];
  const d = new Date(from + "T12:00:00Z");
  const end = new Date(to + "T12:00:00Z");
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) {
      days.push(d.toISOString().split("T")[0]);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== build-history.mjs ===\n");

  // 1. Descargar precios históricos
  console.log("Descargando precios de Yahoo Finance...");
  const pricesByTicker = {};
  for (const [sym, ticker] of Object.entries(YF_TICKERS)) {
    process.stdout.write(`  ${ticker}... `);
    pricesByTicker[sym] = await fetchYF(ticker);
    const n = Object.keys(pricesByTicker[sym]).length;
    console.log(`${n} días`);
  }

  console.log("\nDescargando VCP Mercado Fondo...");
  const mpMap = await fetchMPHistory();
  console.log(`  ${Object.keys(mpMap).length} registros`);

  console.log("Descargando historial MEP...");
  const mepMap = await fetchMEPHistory();
  console.log(`  ${Object.keys(mepMap).length} registros`);

  // 2. Simular estado del portafolio día por día
  // holdings: { sym: qty } para acciones/CEDEARs
  // bonds: { sym: qty }  para bonos (qty = VN)
  // iolcamaARS: valor en ARS de la posición FCI
  // cashARS: efectivo disponible

  // Precio de compra por símbolo (para usar como fallback si no hay precio en Yahoo)
  const ppcBySymbol = {};
  for (const tx of TRANSACTIONS) {
    if (tx.op === "buy" && tx.ppc) ppcBySymbol[tx.sym] = tx.ppc;
  }

  const holdings = {};   // CEDEARs/acciones
  const bonds = {};      // bonos
  let iolcamaARS = 0;
  let cashARS = 8100000; // depósito inicial 08/03

  // Índice de transacciones por fecha
  const txByDate = {};
  for (const tx of TRANSACTIONS) {
    if (!txByDate[tx.date]) txByDate[tx.date] = [];
    txByDate[tx.date].push(tx);
  }

  const START_DATE = "2026-03-09";
  const END_DATE   = "2026-04-16"; // 17 ya existe como snapshot real
  const days = businessDays(START_DATE, END_DATE);

  const syntheticSnapshots = [];

  for (const date of days) {
    // Aplicar transacciones del día
    for (const tx of (txByDate[date] || [])) {
      if (tx.op === "buy") {
        if (tx.sym === "TZX26" || tx.sym === "TX26") {
          // Bono: qty = VN, precio por 100 VN
          bonds[tx.sym] = (bonds[tx.sym] || 0) + tx.qty;
          cashARS -= tx.qty * tx.ppc / 100;
        } else {
          holdings[tx.sym] = (holdings[tx.sym] || 0) + tx.qty;
          cashARS -= tx.qty * tx.ppc;
        }
      } else if (tx.op === "sell") {
        holdings[tx.sym] = (holdings[tx.sym] || 0) - tx.qty;
        cashARS += tx.qty * tx.prc;
      } else if (tx.op === "fci") {
        iolcamaARS += tx.ars; // positivo = suscripción, negativo = rescate
        cashARS    -= tx.ars;
      } else if (tx.op === "deposit") {
        cashARS += tx.ars;
      }
    }

    // Calcular valor total de CEDEARs/acciones
    let cedearARS = 0;
    for (const [sym, qty] of Object.entries(holdings)) {
      if (qty <= 0) continue;
      const prices = pricesByTicker[sym] || {};
      // Precio más cercano anterior, o más cercano posterior si no hay anterior
      const all = Object.entries(prices).sort((a, b) => a[0].localeCompare(b[0]));
      const before = [...all].filter(([d]) => d <= date).pop();
      const after  = all.find(([d]) => d > date);
      const price  = before?.[1] ?? after?.[1] ?? ppcBySymbol[sym];
      if (!price) { console.warn(`  ⚠ Sin precio para ${sym} el ${date}`); continue; }
      cedearARS += qty * price;
    }

    // Valor bonos (qty × price_per_100 / 100)
    let bondsARS = 0;
    for (const [sym, qty] of Object.entries(bonds)) {
      if (qty <= 0) continue;
      const price = bondPrice(sym, date);
      if (price) bondsARS += qty * price / 100;
    }

    // Hacer crecer el IOLCAMA a la tasa del VCP (estimación: 0.089% diario ≈ 33% TNA)
    // Usar VCP si disponible, si no usar tasa fija
    const dailyRate = 0.00089;
    if (iolcamaARS > 0) iolcamaARS *= (1 + dailyRate);

    const totalARS = cedearARS + bondsARS + iolcamaARS + Math.max(0, cashARS);

    // Ganancia total = totalARS - capital_invertido
    // Capital al 09/03: 8.1M. Al 13/04: +4M = 12.1M (fecha registrada del segundo depósito)
    // Para 10-12/04 (cash aún sin invertir) dejamos totalGanancia=null para no confundir inferDeposits.
    const capital = date < "2026-04-13" ? 8100000 : 12100000;
    const totalGanancia = (date >= "2026-04-10" && date < "2026-04-13") ? null : totalARS - capital;

    const mpVcp = mpMap[date] || nearest(
      Object.entries(mpMap).map(([d, v]) => ({ date: d, value: v })), date
    );
    const mep = mepMap[date] || nearest(
      Object.entries(mepMap).map(([d, v]) => ({ date: d, value: v })), date
    );

    syntheticSnapshots.push({
      date,
      totalARS: Math.round(totalARS * 100) / 100,
      totalGanancia: Math.round(totalGanancia * 100) / 100,
      mep: mep || null,
      mpVcp: mpVcp || null,
      synthetic: true,
    });

    const gain = totalGanancia >= 0 ? `+${(totalGanancia/1000).toFixed(0)}K` : `${(totalGanancia/1000).toFixed(0)}K`;
    console.log(`  ${date}: ${(totalARS/1e6).toFixed(3)}M ARS  gcia=${gain}`);
  }

  // 3. Leer snapshots reales actuales
  console.log("\nLeyendo portfolio_history actual de KV...");
  let currentHistory;
  try {
    const raw = execSync(
      `npx wrangler kv key get "portfolio_history" --namespace-id=${KV_ID} --remote`,
      { encoding: "utf8" }
    ).trim();
    currentHistory = JSON.parse(raw);
  } catch (e) {
    console.error("Error leyendo KV:", e.message);
    currentHistory = [];
  }
  console.log(`  ${currentHistory.length} snapshots existentes:`, currentHistory.map(s => s.date).join(", "));

  // 4. Mezclar: conservar snapshots reales (sin "synthetic"), agregar sintéticos solo si no hay uno real
  const realDates = new Set(currentHistory.filter(s => !s.synthetic).map(s => s.date));

  // Remover el snapshot fantasma del 03/03
  const cleanedReal = currentHistory.filter(s => s.date >= "2026-03-09");

  // Snapshots sintéticos que no pisen fechas reales, y solo hasta END_DATE
  const newSynthetic = syntheticSnapshots.filter(s => !realDates.has(s.date));

  const merged = [...newSynthetic, ...cleanedReal]
    .sort((a, b) => a.date.localeCompare(b.date));

  // Eliminar duplicados (real gana sobre sintético)
  const seen = new Set();
  const final = [];
  for (const snap of merged.sort((a, b) => a.date.localeCompare(b.date))) {
    if (seen.has(snap.date)) continue;
    seen.add(snap.date);
    final.push(snap);
  }

  console.log(`\nSnapshots resultantes (${final.length}):`);
  for (const s of final) {
    const tag = s.synthetic ? "[syn]" : "[real]";
    console.log(`  ${tag} ${s.date}: ${(s.totalARS/1e6).toFixed(3)}M`);
  }

  // 5. Actualizar también los depósitos: corregir fecha 03/03 → 08/03
  console.log("\nLeyendo deposits de KV...");
  let deposits;
  try {
    const raw = execSync(
      `npx wrangler kv key get "deposits" --namespace-id=${KV_ID} --remote`,
      { encoding: "utf8" }
    ).trim();
    deposits = JSON.parse(raw);
  } catch (e) {
    deposits = [];
  }

  const fixedDeposits = deposits.map(d =>
    d.date === "2026-03-03" ? { ...d, date: "2026-03-08" } : d
  );
  console.log("Deposits:", fixedDeposits.map(d => `${d.date}:${d.amount/1e6}M`).join(", "));

  // 6. Escribir en KV (o solo mostrar si dry-run)
  if (DRY_RUN) {
    console.log("\n[DRY RUN] No se escribe en KV.");
    return;
  }

  // Escribir via archivo temporal para evitar problemas de shell escaping
  console.log("\nEscribiendo portfolio_history en KV...");
  const histFile = "portfolio_history_tmp.json";
  writeFileSync(histFile, JSON.stringify(final));
  execSync(
    `npx wrangler kv key put "portfolio_history" --path="${histFile}" --namespace-id=${KV_ID} --remote`,
    { encoding: "utf8" }
  );
  unlinkSync(histFile);
  console.log("  ✓ portfolio_history actualizado");

  if (JSON.stringify(fixedDeposits) !== JSON.stringify(deposits)) {
    console.log("Actualizando deposits (corrigiendo fecha 03/03 → 08/03)...");
    const depFile = "deposits_tmp.json";
    writeFileSync(depFile, JSON.stringify(fixedDeposits));
    execSync(
      `npx wrangler kv key put "deposits" --path="${depFile}" --namespace-id=${KV_ID} --remote`,
      { encoding: "utf8" }
    );
    unlinkSync(depFile);
    console.log("  ✓ deposits actualizado");
  }

  console.log("\n✅ Listo.");
}

main().catch(err => { console.error(err); process.exit(1); });
