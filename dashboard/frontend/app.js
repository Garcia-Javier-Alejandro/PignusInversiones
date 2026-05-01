/**
 * app.js — Lógica del dashboard Pignus-Inversiones
 */

"use strict";

// ─── URL del Worker ────────────────────────────────────────────────────────────
const WORKER_URL = "https://pignus-api.garcia-javier-alejandro.workers.dev";

// ─── Valores históricos de MEP (fuente: cotizaciones reales de mercado) ────────
// Se aplican client-side para cubrir snapshots con mep:null sin necesitar redeploy del worker.
const MEP_HISTORICO = {
  "2026-03-02": 1413.54, "2026-03-03": 1434.11, "2026-03-04": 1427.70,
  "2026-03-05": 1433.21, "2026-03-06": 1437.53, "2026-03-09": 1430.17,
  "2026-03-10": 1422.12, "2026-03-11": 1413.80, "2026-03-12": 1415.52,
  "2026-03-13": 1424.34, "2026-03-16": 1424.92, "2026-03-17": 1417.30,
  "2026-03-18": 1420.38, "2026-03-19": 1421.08, "2026-03-20": 1422.13,
  "2026-03-23": 1415.68, "2026-03-24": 1415.68, "2026-03-25": 1404.55,
  "2026-03-26": 1401.28, "2026-03-27": 1429.73, "2026-03-30": 1432.51,
  "2026-03-31": 1422.84,
  "2026-04-01": 1434.04, "2026-04-02": 1434.04, "2026-04-03": 1434.04,
  "2026-04-06": 1429.57, "2026-04-07": 1430.16, "2026-04-08": 1424.45,
  "2026-04-09": 1420.86, "2026-04-10": 1412.50, "2026-04-13": 1404.47,
  "2026-04-14": 1412.09, "2026-04-15": 1398.53, "2026-04-16": 1406.23,
  "2026-04-17": 1412.53, "2026-04-20": 1414.73, "2026-04-21": 1414.42,
  "2026-04-22": 1419.84, "2026-04-23": 1424.40, "2026-04-24": 1438.34,
  "2026-04-27": 1461.73, "2026-04-28": 1447.18, "2026-04-29": 1435.60,
  "2026-04-30": 1442.43,
};

function patchMepValues(snapshots) {
  for (const s of snapshots) {
    // Aplicar siempre: sobreescribe valores incorrectos guardados en KV (ej. interpolación errónea).
    if (MEP_HISTORICO[s.date]) s.mep = MEP_HISTORICO[s.date];
  }
}

// ─── Mapa de sectores por símbolo ─────────────────────────────────────────────
const SECTORES = {
  // Renta fija ajustable
  TX26:    "Renta fija ajustable",
  TZX26:   "Renta fija ajustable",
  // Oro
  GLD:     "Oro",
  // Liquidez (efectivo; los FCI quedan mapeados a "Liquidez" en getSector)
  IOLCAMA: "Liquidez",
  CASH:    "Liquidez",
  // Finanzas
  GGAL:    "Finanzas",
  NU:      "Finanzas",
  // Oil & Gas
  VIST:    "Oil&Gas",
  XOM:     "Oil&Gas",
  XLE:     "Oil&Gas",
  SLB:     "Oil&Gas",
  // Tecnología
  ASML:    "Tecnología",
  MELI:    "Tecnología",
  MSFT:    "Tecnología",
  // Materiales estratégicos
  COPX:    "Materiales estratégicos",
  URA:     "Materiales estratégicos",
  // Mercado amplio EE.UU.
  SPY:     "Mercado USA",
  // Salud
  XLV:     "Salud",
  // Agro
  ADGO:    "Agro",
};

// ─── Normalización de tipos IOL → display ─────────────────────────────────────
// IOL devuelve el tipo en titulo.tipo con strings propios.
// Este mapa los convierte a los nombres que queremos mostrar.
// Si aparece un tipo nuevo en consola como "undefined" o desconocido, agregarlo acá.
const TIPO_MAP = {
  "CEDEARS":                  "CEDEARs",
  "ACCIONES":                 "Acciones",
  "TitulosPublicos":          "Bonos",
  "BONOS":                    "Bonos",
  "TITULOS_PUBLICOS":         "Bonos",
  "OBLIGACIONES_NEGOCIABLES": "Bonos",
  "LETRAS":                   "Bonos",
  "FondoComundeInversion":    "FCI",
  "FCI":                      "FCI",
  "FONDOS":                   "FCI",
  "Efectivo":                 "Efectivo",
};

function getTipo(activo) {
  const raw = activo.titulo?.tipo || activo.tipo || "";
  return TIPO_MAP[raw] || (raw ? raw : "Otros");
}

// ─── Paletas ───────────────────────────────────────────────────────────────────
const COLORES_TIPO = {
  "CEDEARs":  "#3b82f6",
  "Acciones": "#8b5cf6",
  "Bonos":    "#f59e0b",
  "FCI":      "#10b981",
  "Efectivo": "#6b7280",
  "Otros":    "#9ca3af",
};

const PALETA_SECTORES = [
  "#3b82f6","#f59e0b","#10b981","#8b5cf6","#ef4444",
  "#06b6d4","#f97316","#84cc16","#ec4899","#a78bfa",
  "#14b8a6","#fb923c",
];

let chartPie     = null;
let chartHistory = null;
let chartCarteraUSD = null;
let _histLastTouchTs    = 0;
let _histTooltipDismiss = false;
let _histListenerAdded  = false;
let _usdLastTouchTs     = 0;
let _usdTooltipDismiss  = false;
let _usdListenerAdded   = false;

// ─── Función principal ────────────────────────────────────────────────────────

async function loadDashboard(alpineState) {
  alpineState.loading = true;
  alpineState.error   = null;
  alpineState.stale   = false;

  try {
    const [portfolio, account, mep] = await Promise.all([
      fetchJSON(`${WORKER_URL}/api/portfolio`),
      fetchJSON(`${WORKER_URL}/api/account`),
      fetchMEP(),
    ]);

    if (isValidPortfolio(portfolio)) {
      alpineState.portfolio  = portfolio;
      alpineState.account    = account;
      alpineState.mep        = mep.value;
      alpineState.mepStale   = mep.stale;
      alpineState.mepPar     = mep.par;
      alpineState.updatedAt  = horaActual();
      renderChart(getActivosConCash(portfolio, account), alpineState.chartView, alpineState.chartType);

      // Guardar snapshot diario y cargar historial (fire-and-forget en paralelo)
      const totalARS = account?.cuentas?.find(c => c.moneda === "peso_Argentino")?.total || 0;
      const totalGanancia = (portfolio.activos || []).reduce((s, a) => s + (a.gananciaDinero || 0), 0);
      saveSnapshot(totalARS, mep.value, totalGanancia, portfolio.activos || []);
      loadHistory(alpineState);
    } else {
      alpineState.stale = true;
      console.warn("IOL devolvió datos vacíos, conservando datos anteriores.");
    }

  } catch (err) {
    alpineState.error = err.message;
    console.error("Error cargando dashboard:", err);
  } finally {
    alpineState.loading = false;
  }
}

/**
 * Devuelve false si el portafolio viene vacío o con todo en cero.
 * IOL hace esto durante el mantenimiento nocturno (~00:00–00:10).
 */
function isValidPortfolio(portfolio) {
  const activos = portfolio?.activos;
  if (!activos || activos.length === 0) return false;
  return activos.reduce((s, a) => s + (a.valorizado || 0), 0) > 0;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchJSON(url) {
  const response = await fetch(url);
  if (!response.ok) {
    let msg = `Error ${response.status}`;
    try { const d = await response.json(); msg = d.error || msg; } catch (_) {}
    throw new Error(msg);
  }
  return response.json();
}

async function fetchMEP() {
  try {
    const data = await fetchJSON(`${WORKER_URL}/api/mep`);
    return { value: data.mep || null, stale: !!(data.stale), par: data.par || null };
  } catch (err) {
    console.warn("No se pudo obtener el dólar MEP:", err.message);
    return { value: null, stale: true, par: null };
  }
}

// ─── Datos enriquecidos ───────────────────────────────────────────────────────

/**
 * Agrega una fila sintética "CASH" al portafolio con el saldo disponible.
 */
function getActivosConCash(portfolio, account) {
  const activos    = [...(portfolio?.activos || [])];
  const disponible = getDisponible(account);
  if (disponible > 0) {
    activos.push({
      titulo:             { simbolo: "CASH", descripcion: "Efectivo disponible" },
      tipo:               "Efectivo",
      valorizado:         disponible,
      gananciaDinero:     0,
      gananciaPorcentaje: 0,
      ppc:                1,
      cantidad:           disponible,
    });
  }
  return activos;
}

function getSector(activo) {
  const simbolo = activo.titulo?.simbolo || activo.simbolo || "";
  // FCI son instrumentos de liquidez en la vista por sector
  if (getTipo(activo) === "FCI") return "Liquidez";
  return SECTORES[simbolo] || "Otros";
}

/**
 * Ordena activos por columna. Devuelve un nuevo array (no muta el original).
 */
function sortActivos(activos, col, dir) {
  return [...activos].sort((a, b) => {
    let va, vb;
    if (col === "simbolo") {
      va = (a.titulo?.simbolo || a.simbolo || "").toLowerCase();
      vb = (b.titulo?.simbolo || b.simbolo || "").toLowerCase();
      return dir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    if (col === "tipo") {
      va = (a.tipo || "").toLowerCase();
      vb = (b.tipo || "").toLowerCase();
      return dir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    if (col === "sector") {
      va = getSector(a).toLowerCase();
      vb = getSector(b).toLowerCase();
      return dir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    switch (col) {
      case "ppc":       va = a.ppc               || 0; vb = b.ppc               || 0; break;
      case "ultimo":    va = (a.ppc || 0) * (1 + (a.gananciaPorcentaje || 0) / 100);
                        vb = (b.ppc || 0) * (1 + (b.gananciaPorcentaje || 0) / 100); break;
      case "valorizado":va = a.valorizado         || 0; vb = b.valorizado         || 0; break;
      case "pct":       va = a.gananciaPorcentaje || 0; vb = b.gananciaPorcentaje || 0; break;
      case "dinero":    va = a.gananciaDinero      || 0; vb = b.gananciaDinero      || 0; break;
      default:          va = a.valorizado         || 0; vb = b.valorizado         || 0;
    }
    return dir === "asc" ? va - vb : vb - va;
  });
}

// ─── Cálculos financieros ─────────────────────────────────────────────────────

/**
 * Rendimiento de los últimos ~30 días, ajustado por depósitos.
 * Base: snapshot más reciente con antigüedad ≥ 30 días. Si no hay ninguno,
 * usa el más antiguo disponible (e.g., los primeros días de uso).
 * Fórmula: (valorHoy − Σdepósitos) / valorBase − 1
 * Retorna { pct, fromDate } o null si no hay datos suficientes.
 */
function calcReturn30d(snapshots, deposits, totalCartera, moneda, mep) {
  if (!snapshots || snapshots.length < 2 || !totalCartera) return null;

  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().split("T")[0];

  // Snapshot base: el más reciente con fecha <= hace 30 días
  let base = null;
  for (const s of sorted) {
    if (s.date <= cutoff) base = s;
  }
  // Si todos los snapshots son de menos de 30 días, usar el más antiguo
  if (!base) base = sorted[0];
  // No comparar el snapshot más reciente consigo mismo
  if (base.date === sorted[sorted.length - 1].date) return null;

  if (!base.totalARS || base.totalARS <= 0) return null;

  const periodDeposits = (deposits || []).filter(d => d.date > base.date);

  if (moneda === "MEP" && mep) {
    const mepBase           = base.mep || mep;
    const baseUSD           = base.totalARS / mepBase;
    const periodDepositoUSD = periodDeposits.reduce((s, d) => s + (d.amount || 0) / (d.mep || mep), 0);
    const carteraUSD        = totalCartera / mep;
    return {
      pct:      ((carteraUSD - periodDepositoUSD) / baseUSD - 1) * 100,
      fromDate: base.date,
    };
  }

  const totalCF = periodDeposits.reduce((s, d) => s + (d.amount || 0), 0);
  return {
    pct:      ((totalCartera - totalCF) / base.totalARS - 1) * 100,
    fromDate: base.date,
  };
}

/**
 * Rendimiento real sobre capital aportado.
 * Fórmula: (valor actual − Σ depósitos) / Σ depósitos × 100
 * Si no hay depósitos registrados, cae al cálculo por PPC (menos preciso).
 */
function calcTotalReturn(activos, totalCartera, deposits, moneda, mep) {
  const totalAportado = (deposits || []).reduce((s, d) => s + (d.amount || 0), 0);
  if (totalAportado > 0 && totalCartera > 0) {
    if (moneda === "MEP" && mep) {
      const aportadoUSD = (deposits || []).reduce((s, d) => s + (d.amount || 0) / (d.mep || mep), 0);
      const carteraUSD  = totalCartera / mep;
      return ((carteraUSD - aportadoUSD) / aportadoUSD) * 100;
    }
    return ((totalCartera - totalAportado) / totalAportado) * 100;
  }
  // Fallback: ganancia acumulada por PPC (excluye CASH)
  const posiciones = (activos || []).filter(a => (a.titulo?.simbolo || a.simbolo) !== "CASH");
  const gain = posiciones.reduce((s, a) => s + (a.gananciaDinero || 0), 0);
  const cost = posiciones.reduce((s, a) => s + ((a.ppc || 0) * (a.cantidad || 0)), 0);
  return cost > 0 ? (gain / cost) * 100 : 0;
}

function calcTotalCartera(portfolio, account) {
  // IOL ya calcula el total (títulos valorizados + disponible) en cuenta.total.
  const cuenta = account?.cuentas?.find(c => c.moneda === "peso_Argentino") || account?.cuentas?.[0];
  return cuenta?.total || 0;
}

function getDisponible(account) {
  if (!account?.cuentas) return 0;
  // IOL devuelve el disponible en pesos directamente en cuenta.disponible.
  // La subcuenta de pesos se identifica por moneda === "peso_Argentino".
  const cuenta = account.cuentas.find(c => c.moneda === "peso_Argentino") || account.cuentas[0];
  return cuenta?.disponible || 0;
}

// ─── Historial y benchmarks ───────────────────────────────────────────────────

async function loadHistory(alpineState) {
  try {
    const data = await fetchJSON(`${WORKER_URL}/api/history`);
    patchMepValues(data.snapshots || []);
    alpineState.historyData = data;
    alpineState.deposits    = data.deposits || [];
    // Si /api/mep falló, usar el mep más reciente guardado en snapshots como fallback.
    if (!alpineState.mep) {
      const snap = [...(data.snapshots || [])].reverse().find(s => s.mep > 1);
      if (snap) { alpineState.mep = snap.mep; alpineState.mepStale = true; alpineState.mepPar = "snapshot"; }
    }
    renderHistoryChart(data, alpineState.moneda, alpineState.periodoHist);
    renderCarteraUSDChart(data, alpineState.periodoHist);

    // Advertir si el último snapshot tiene más de 1 día de antigüedad.
    // Indica que el guardado automático viene fallando o el dashboard no se abrió.
    const snaps = data.snapshots || [];
    if (snaps.length > 0) {
      const lastDate = snaps[snaps.length - 1].date;          // "YYYY-MM-DD" ARG
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0];
      if (lastDate < yesterday) {
        const dias = Math.round((Date.now() - new Date(lastDate + "T12:00:00").getTime()) / 86_400_000);
        alpineState.snapshotWarning = `Último registro guardado hace ${dias} día${dias !== 1 ? "s" : ""}. El historial puede tener huecos.`;
      }
    }
  } catch (err) {
    console.warn("No se pudo cargar el historial:", err.message);
  }
}

// ─── Helpers de color por performance ────────────────────────────────────────

/** Interpola linealmente entre dos colores hex. t ∈ [0, 1]. */
function lerpColor(hex1, hex2, t) {
  const p = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
  const [r1,g1,b1] = p(hex1);
  const [r2,g2,b2] = p(hex2);
  return `rgb(${Math.round(r1+(r2-r1)*t)},${Math.round(g1+(g2-g1)*t)},${Math.round(b1+(b2-b1)*t)})`;
}

/**
 * Paleta estilo Finviz: charcoal en 0%, rojo saturado en −10%, verde brillante en +10%.
 * Escala con raíz cuadrada: diferencias pequeñas (±0.5%) ya muestran tinte visible.
 */
function perfColor(pct) {
  const DARK = "#383a3a"; // charcoal ~10% más claro que antes
  if (Math.abs(pct) < 0.01) return DARK;
  const t = Math.min(1, Math.sqrt(Math.abs(pct) / 10));
  if (pct > 0) return lerpColor(DARK, "#1aba64", t); // charcoal → verde brillante
  return lerpColor(DARK, "#e03131", t);               // charcoal → rojo saturado
}

/**
 * Calcula el rendimiento ponderado (%) por grupo (sector o tipo).
 * Usa promedio ponderado de gananciaPorcentaje por valorizado para evitar
 * problemas de unidades con bonos (IOL reporta ppc per 100 VN, no per 1 VN).
 * Devuelve un mapa { nombre → pct | null }.
 */
function buildPerfMap(activos, view) {
  const data = {};
  for (const a of activos) {
    if ((a.titulo?.simbolo || a.simbolo) === "CASH") continue;
    const key = view === "sector" ? getSector(a) : getTipo(a);
    if (!data[key]) data[key] = { weightedSum: 0, totalWeight: 0 };
    const w = a.valorizado || 0;
    data[key].weightedSum += (a.gananciaPorcentaje || 0) * w;
    data[key].totalWeight += w;
  }
  const result = {};
  for (const [name, d] of Object.entries(data)) {
    result[name] = d.totalWeight > 0 ? d.weightedSum / d.totalWeight : null;
  }
  return result;
}

/** Colores de performance para el treemap de sectores. */
function buildSectorPerfColors(activos, sectorNames) {
  const perfMap = buildPerfMap(activos, "sector");
  return sectorNames.map(name => {
    const pct = perfMap[name];
    return pct != null ? perfColor(pct) : "#1e2020";
  });
}

/** Guarda un snapshot del día en el Worker (fire-and-forget). */
async function saveSnapshot(totalARS, mep, totalGanancia, activos) {
  try {
    await fetch(`${WORKER_URL}/api/snapshot`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ totalARS, mep, totalGanancia, activos: activos || [] }),
    });
  } catch (err) {
    console.warn("No se pudo guardar snapshot:", err.message);
  }
}

/** Registra un depósito o retiro y recarga el historial. */
async function saveDeposit(alpineState) {
  const date   = alpineState.depositDate;
  const amount = parseFloat(alpineState.depositAmount);
  const note   = alpineState.depositNote || "";
  if (!date || isNaN(amount) || amount === 0) return;
  try {
    await fetch(`${WORKER_URL}/api/deposit`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ date, amount, note, mep: alpineState.mep || null }),
    });
    alpineState.depositDate   = "";
    alpineState.depositAmount = "";
    alpineState.depositNote   = "";
    alpineState.showDepositForm = false;
    await loadHistory(alpineState);
  } catch (err) {
    console.warn("Error guardando depósito:", err.message);
  }
}

/** Guarda una tasa diaria de MP y recarga el gráfico. */
async function saveMPRate(alpineState) {
  const dailyPct = parseFloat(alpineState.mpRateInput);
  if (isNaN(dailyPct) || dailyPct <= 0) return;
  try {
    await fetch(`${WORKER_URL}/api/mp-rate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ dailyPct }),
    });
    await loadHistory(alpineState);
  } catch (err) {
    console.warn("Error guardando tasa MP:", err.message);
  }
}

/**
 * Calcula las tres curvas a partir de los snapshots del Worker.
 *
 * Algoritmo de benchmarks:
 *   - Día 0: se "compra" SPY / MP con el valor total de la cartera.
 *   - SPY: unidades fijas × precio histórico CEDEAR (ARS).
 *   - MP:  cuotas fijas × VCP de "Mercado Fondo - Clase A" (dato real de CAFCI).
 *
 * Si un snapshot no tiene VCP (feriado, dato faltante), la curva MP
 * usa el último VCP conocido como aproximación.
 *
 * @returns { labels, pignusData, spyData, mpData } o null si hay < 2 puntos.
 */
/**
 * Calcula las tres curvas del gráfico histórico.
 *
 * Benchmarks con depósitos:
 *   Cada vez que se registra un depósito, los benchmarks también "compran"
 *   SPY/MP con ese monto al precio de ese día. Así la comparación es justa:
 *   "¿qué hubiera pasado si pusiera cada peso aportado en SPY o MP?"
 */
function computeHistoryChartData(snapshots, spyPrices, deposits, moneda, periodo) {
  if (!snapshots || snapshots.length < 1) return null;

  const allSorted      = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const depositsSorted = [...(deposits || [])].sort((a, b) => a.date.localeCompare(b.date));
  const cutoff         = periodCutoff(periodo);

  // Insertar puntos sintéticos interpolados en fechas de depósito que no tienen snapshot.
  // Así la anotación del depósito puede anclarse exactamente en su fecha.
  const snapDates = new Set(allSorted.map(s => s.date));
  for (const dep of depositsSorted) {
    if (snapDates.has(dep.date)) continue;
    const prev = [...allSorted].reverse().find(s => s.date < dep.date);
    const next = allSorted.find(s => s.date > dep.date);
    if (!prev || !next) continue;
    const d0 = new Date(prev.date + "T12:00:00").getTime();
    const d1 = new Date(next.date + "T12:00:00").getTime();
    const dt = new Date(dep.date  + "T12:00:00").getTime();
    const t  = (dt - d0) / (d1 - d0);
    const lerp = (a, b) => (a != null && b != null) ? a + t * (b - a) : (a ?? b ?? null);
    allSorted.push({
      date:          dep.date,
      totalARS:      lerp(prev.totalARS, next.totalARS),
      mep:           lerp(prev.mep,      next.mep),
      mpVcp:         lerp(prev.mpVcp,    next.mpVcp),
      totalGanancia: lerp(prev.totalGanancia, next.totalGanancia),
      synthetic:     true,
    });
    snapDates.add(dep.date);
  }
  allSorted.sort((a, b) => a.date.localeCompare(b.date));

  const spyByDate = {};
  for (const p of (spyPrices || [])) spyByDate[p.date] = p.price;
  // Agregar precios SPY de los depósitos como puntos ancla para períodos sin datos históricos.
  // Permite dibujar la curva antes de que positions_history tenga datos de SPY.
  for (const dep of depositsSorted) {
    if (dep.spyPrice && !spyByDate[dep.date]) spyByDate[dep.date] = dep.spyPrice;
  }

  let spyUnits  = 0;
  let mpCuotas  = 0;
  let lastMpVcp = null;
  let lastDate  = null;

  const pignusData = [];
  const spyData    = [];
  const mpData     = [];

  for (const snap of allSorted) {
    const mepForDay = snap.mep || 1;
    if (snap.mpVcp) lastMpVcp = snap.mpVcp;
    const mpVcp = snap.mpVcp || lastMpVcp;

    // Acumular unidades benchmark desde el inicio (aunque no esté en el rango visible)
    const lo = lastDate || "0000-00-00";
    const periodDeposits = depositsSorted.filter(d => d.date > lo && d.date <= snap.date);
    for (const dep of periodDeposits) {
      const depSpy = dep.spyPrice || nearestSPYPrice(spyByDate, dep.date);
      if (depSpy)     spyUnits += (dep.amount * (1 - 0.003)) / depSpy;
      if (dep.mpVcp)  mpCuotas += dep.amount / dep.mpVcp;
    }
    lastDate = snap.date;

    if (cutoff && snap.date < cutoff) continue;

    const spyPrice = nearestSPYPrice(spyByDate, snap.date);
    const spyARS   = spyPrice && spyUnits > 0 ? spyUnits * spyPrice : null;
    const mpARS    = mpVcp    && mpCuotas > 0 ? mpCuotas * mpVcp    : null;

    const toDisplay = v => v == null ? null
      : (moneda === "MEP" ? (mepForDay > 1 ? v / mepForDay : null) : v);

    const ts = new Date(snap.date + "T12:00:00").getTime();
    pignusData.push({ x: ts, y: toDisplay(snap.totalARS) });
    spyData.push({ x: ts, y: toDisplay(spyARS) });
    mpData.push({ x: ts, y: toDisplay(mpARS) });
  }

  // Depósitos dentro del rango visible (para anotaciones).
  // Como un depósito puede no caer en fecha de snapshot, lo ancla al snapshot
  // visible más cercano en o después de su fecha.
  const visibleSnapDates = allSorted
    .filter(s => !cutoff || s.date >= cutoff)
    .map(s => s.date);

  const visibleDeposits = depositsSorted
    .filter(d => !cutoff || d.date >= cutoff)
    .map(d => {
      const anchorDate = visibleSnapDates.find(sd => sd >= d.date) || visibleSnapDates[visibleSnapDates.length - 1];
      if (!anchorDate) return null;
      return { ...d, annotationTs: new Date(anchorDate + "T12:00:00").getTime() };
    })
    .filter(Boolean);

  return pignusData.length >= 2 ? { pignusData, spyData, mpData, visibleDeposits } : null;
}

/** Fecha de corte para filtrar snapshots según el período seleccionado. */
function periodCutoff(periodo) {
  const daysMap = { "1m": 30, "3m": 90, "6m": 180 };
  const days = daysMap[periodo];
  if (!days) return null;
  return new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];
}

/** Devuelve el precio SPY más reciente disponible en o antes de `targetDate`. */
function nearestSPYPrice(spyByDate, targetDate) {
  let bestDate = null;
  let best = null;
  for (const [d, price] of Object.entries(spyByDate)) {
    if (d <= targetDate && (bestDate === null || d > bestDate)) {
      bestDate = d;
      best = price;
    }
  }
  return best;
}

function formatDateLabel(dateStr) {
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

function renderHistoryChart(data, moneda, periodo) {
  const canvas = document.getElementById("chartHistory");
  if (!canvas) return;

  const computed = computeHistoryChartData(data.snapshots, data.spyPrices, data.deposits, moneda, periodo);
  if (!computed) return;

  if (chartHistory) chartHistory.destroy();

  const fmtY = v => moneda === "MEP" ? formatUSD(v) : formatARS(v);

  const xMin = computed.pignusData[0].x;
  const lastValid = [...computed.pignusData].reverse().find(p => p.y != null);
  const xMax = lastValid ? lastValid.x : computed.pignusData[computed.pignusData.length - 1].x;

  // Anotaciones: línea vertical punteada por cada depósito visible
  const annotations = {};
  for (const dep of (computed.visibleDeposits || [])) {
    const monto  = dep.amount >= 0
      ? `+$${(dep.amount / 1e6).toFixed(1)}M`
      : `-$${(Math.abs(dep.amount) / 1e6).toFixed(1)}M`;
    annotations[`dep_${dep.date}`] = {
      type:        "line",
      xMin:        dep.annotationTs,
      xMax:        dep.annotationTs,
      borderColor: "#60a5fa",
      borderWidth: 1.5,
      borderDash:  [4, 3],
      label: {
        display:         true,
        content:         monto,
        position:        "start",
        xAdjust:         32,
        yAdjust:         -4,
        textAlign:       "left",
        backgroundColor: "rgba(96,165,250,0.12)",
        color:           "#3b82f6",
        font:            { size: 13, weight: "bold" },
        padding:         { x: 4, y: 2 },
        borderRadius:    3,
      },
    };
  }

  if (!_histListenerAdded) {
    canvas.addEventListener('touchstart', () => {
      _histTooltipDismiss = (chartHistory?.tooltip._active?.length ?? 0) > 0;
      _histLastTouchTs = Date.now();
    }, { passive: true });
    _histListenerAdded = true;
  }

  chartHistory = new Chart(canvas, {
    type: "line",
    data: {
      datasets: [
        {
          label:           "Pignus",
          data:            computed.pignusData,
          borderColor:     "#10b981",
          backgroundColor: "#10b98118",
          borderWidth:     2,
          tension:         0.3,
          pointRadius:     0,
          pointHoverRadius: 4,
          fill:            true,
        },
        {
          label:           "S&P 500",
          data:            computed.spyData,
          borderColor:     "#f97316",
          backgroundColor: "transparent",
          borderWidth:     2,
          tension:         0.3,
          pointRadius:     0,
          pointHoverRadius: 4,
          fill:            false,
        },
        {
          label:           "MP",
          data:            computed.mpData,
          borderColor:     "#3b82f6",
          backgroundColor: "transparent",
          borderWidth:     2,
          tension:         0.3,
          pointRadius:     0,
          pointHoverRadius: 4,
          fill:            false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      // Sin "click" ni "touchend": click queda para dismiss manual; tooltip persiste tras levantar el dedo.
      events: ["mousemove", "mouseout", "touchstart", "touchmove"],
      onClick(evt, elements, chart) {
        const isFromTouch = Date.now() - _histLastTouchTs < 500;
        if (!isFromTouch && chart.tooltip._active?.length > 0) {
          chart.tooltip.setActiveElements([], {});
          chart.update();
        } else if (isFromTouch && _histTooltipDismiss) {
          chart.tooltip.setActiveElements([], {});
          chart.update();
          _histTooltipDismiss = false;
        }
      },
      plugins: {
        legend: {
          position: "top",
          labels: {
            color: "#374151",
            font: { size: 14 },
            padding: 8,
            usePointStyle: true,
            pointStyle:    "line",
          },
        },
        datalabels:  { display: false },
        annotation:  { annotations },
        tooltip: {
          callbacks: {
            title(items) {
              if (!items.length) return '';
              const d = new Date(items[0].parsed.x);
              return `${String(d.getUTCDate()).padStart(2,"0")}/${String(d.getUTCMonth()+1).padStart(2,"0")}/${d.getUTCFullYear()}`;
            },
            label(ctx) {
              if (ctx.parsed.y == null) return null;
              return ` ${ctx.dataset.label}: ${fmtY(ctx.parsed.y)}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          min: xMin,
          max: xMax,
          ticks: {
            color: "#9ca3af",
            font: { size: 13 },
            maxTicksLimit: 8,
            callback(v) {
              const d = new Date(v);
              return `${String(d.getUTCDate()).padStart(2,"0")}/${String(d.getUTCMonth()+1).padStart(2,"0")}`;
            },
          },
          grid: { color: "#f3f4f6" },
        },
        y: {
          ...(moneda === "ARS" ? { min: 6_000_000, max: 15_000_000 } : {}),
          ticks: { color: "#9ca3af", font: { size: 13 }, callback: fmtY },
          grid:  { color: "#f3f4f6" },
        },
      },
    },
  });
}


// ─── Gráfico Cartera ARS y USD MEP ───────────────────────────────────────────

// TWR (Time-Weighted Return): igual que el primer gráfico, cada depósito se descuenta
// del período en que ocurre, evitando que los aportes inflen el rendimiento.
function computeCarteraUSDChartData(snapshots, deposits, periodo) {
  if (!snapshots || snapshots.length < 2) return null;

  const allSorted = [...snapshots]
    .filter(s => s.mep > 1 && s.totalARS > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const cutoff  = periodCutoff(periodo);
  const visible = cutoff ? allSorted.filter(s => s.date >= cutoff) : allSorted;
  if (visible.length < 2) return null;

  const depositsSorted = [...(deposits || [])]
    .filter(d => !cutoff || d.date >= visible[0].date)
    .sort((a, b) => a.date.localeCompare(b.date));

  const arsData = [];
  const usdData = [];
  const mepData = [];

  // Punto inicial: 0 %
  let twrARS  = 1.0;
  let twrUSD  = 1.0;
  let prevARS = visible[0].totalARS;
  let prevUSD = visible[0].totalARS / visible[0].mep;
  let lastDate = visible[0].date;

  arsData.push({ x: new Date(visible[0].date + "T12:00:00").getTime(), y: 0 });
  usdData.push({ x: new Date(visible[0].date + "T12:00:00").getTime(), y: 0 });
  mepData.push({ x: new Date(visible[0].date + "T12:00:00").getTime(), y: visible[0].mep });

  for (let i = 1; i < visible.length; i++) {
    const snap = visible[i];
    const currUSD = snap.totalARS / snap.mep;

    // Depósitos/retiros entre el punto anterior y este (exclusive → inclusive)
    const depsInPeriod = depositsSorted.filter(d => d.date > lastDate && d.date <= snap.date);
    const depARS = depsInPeriod.reduce((s, d) => s + d.amount, 0);
    const depUSD = depsInPeriod.reduce((s, d) => {
      const mep = d.mep > 1 ? d.mep : snap.mep;
      return s + d.amount / mep;
    }, 0);

    // Base ajustada por depósitos (TWR: los aportes no cuentan como rendimiento)
    twrARS *= snap.totalARS / (prevARS + depARS);
    twrUSD *= currUSD          / (prevUSD + depUSD);

    const ts = new Date(snap.date + "T12:00:00").getTime();
    arsData.push({ x: ts, y: (twrARS - 1) * 100 });
    usdData.push({ x: ts, y: (twrUSD - 1) * 100 });
    mepData.push({ x: ts, y: snap.mep });

    lastDate = snap.date;
    prevARS  = snap.totalARS;
    prevUSD  = currUSD;
  }

  return { arsData, usdData, mepData };
}

function renderCarteraUSDChart(data, periodo) {
  const canvas = document.getElementById("chartCarteraUSD");
  if (!canvas) return;

  const computed = computeCarteraUSDChartData(data.snapshots, data.deposits, periodo);
  if (!computed) return;

  if (chartCarteraUSD) chartCarteraUSD.destroy();

  const xMin = computed.arsData[0].x;
  const xMax = computed.arsData[computed.arsData.length - 1].x;

  if (!_usdListenerAdded) {
    canvas.addEventListener("touchstart", () => {
      _usdTooltipDismiss = (chartCarteraUSD?.tooltip._active?.length ?? 0) > 0;
      _usdLastTouchTs = Date.now();
    }, { passive: true });
    _usdListenerAdded = true;
  }

  chartCarteraUSD = new Chart(canvas, {
    type: "line",
    data: {
      datasets: [
        {
          label:            "Cartera ARS",
          data:             computed.arsData,
          yAxisID:          "yPct",
          borderColor:      "#3b82f6",
          backgroundColor:  "#3b82f618",
          borderWidth:      2,
          tension:          0.3,
          pointRadius:      0,
          pointHoverRadius: 4,
          fill:             true,
        },
        {
          label:            "Cartera USD MEP",
          data:             computed.usdData,
          yAxisID:          "yPct",
          borderColor:      "#10b981",
          backgroundColor:  "transparent",
          borderWidth:      2,
          tension:          0.3,
          pointRadius:      0,
          pointHoverRadius: 4,
          fill:             false,
        },
        {
          label:            "MEP",
          data:             computed.mepData,
          yAxisID:          "yMEP",
          borderColor:      "#f59e0b",
          backgroundColor:  "transparent",
          borderWidth:      1.5,
          borderDash:       [4, 3],
          tension:          0.3,
          pointRadius:      0,
          pointHoverRadius: 4,
          fill:             false,
        },
      ],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      events: ["mousemove", "mouseout", "touchstart", "touchmove"],
      onClick(evt, elements, chart) {
        const isFromTouch = Date.now() - _usdLastTouchTs < 500;
        if (!isFromTouch && chart.tooltip._active?.length > 0) {
          chart.tooltip.setActiveElements([], {});
          chart.update();
        } else if (isFromTouch && _usdTooltipDismiss) {
          chart.tooltip.setActiveElements([], {});
          chart.update();
          _usdTooltipDismiss = false;
        }
      },
      plugins: {
        legend: {
          position: "top",
          labels: {
            color: "#374151",
            font:  { size: 14 },
            padding: 8,
            usePointStyle: true,
            pointStyle:    "line",
          },
        },
        datalabels: { display: false },
        annotation:  { annotations: {} },
        tooltip: {
          callbacks: {
            title(items) {
              if (!items.length) return "";
              const d = new Date(items[0].parsed.x);
              return `${String(d.getUTCDate()).padStart(2,"0")}/${String(d.getUTCMonth()+1).padStart(2,"0")}/${d.getUTCFullYear()}`;
            },
            label(ctx) {
              if (ctx.parsed.y == null) return null;
              if (ctx.dataset.yAxisID === "yPct") {
                const sign = ctx.parsed.y >= 0 ? "+" : "";
                return ` ${ctx.dataset.label}: ${sign}${ctx.parsed.y.toFixed(1)}%`;
              }
              return ` MEP: $${Math.round(ctx.parsed.y).toLocaleString("es-AR")}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          min:  xMin,
          max:  xMax,
          ticks: {
            color: "#9ca3af",
            font:  { size: 13 },
            maxTicksLimit: 8,
            callback(v) {
              const d = new Date(v);
              return `${String(d.getUTCDate()).padStart(2,"0")}/${String(d.getUTCMonth()+1).padStart(2,"0")}`;
            },
          },
          grid: { color: "#f3f4f6" },
        },
        yPct: {
          type:     "linear",
          position: "left",
          ticks: {
            color: "#6b7280",
            font:  { size: 13 },
            callback: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`,
          },
          grid: { color: "#f3f4f6" },
        },
        yMEP: {
          type:     "linear",
          position: "right",
          ticks: {
            color: "#f59e0b",
            font:  { size: 13 },
            callback: v => `$${Math.round(v).toLocaleString("es-AR")}`,
          },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

// ─── Formato de números ───────────────────────────────────────────────────────

function formatARS(v) {
  if (v == null || isNaN(v)) return "—";
  const abs  = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}M`;
  if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k`;
  return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function formatUSD(v) {
  if (v == null || isNaN(v)) return "—";
  const abs  = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000) return `${sign}USD ${(abs / 1_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k`;
  return `${sign}USD ${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function formatValor(pesos, moneda, mep) {
  if (moneda === "MEP" && mep) return formatUSD(pesos / mep);
  return formatARS(pesos);
}

function formatPct(v) {
  if (v == null || isNaN(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

// ─── Gráfico de composición (torta o treemap) ─────────────────────────────────

function renderChart(activos, view, chartType = "donut") {
  if (chartType === "treemap") {
    renderTreemap(activos, view);
  } else {
    renderDonut(activos, view);
  }
}

/** Agrupa activos por view (tipo|sector) y devuelve sorted entries + colors. */
function buildGrupos(activos, view) {
  const grupos = {};
  for (const a of activos) {
    const key = view === "tipo" ? getTipo(a) : getSector(a);
    grupos[key] = (grupos[key] || 0) + (a.valorizado || 0);
  }
  const sorted = Object.entries(grupos).sort((a, b) => b[1] - a[1]);
  const colors = view === "tipo"
    ? sorted.map(([l]) => COLORES_TIPO[l] || COLORES_TIPO["Otros"])
    : sorted.map((_, i) => PALETA_SECTORES[i % PALETA_SECTORES.length]);
  return { sorted, colors };
}

function renderDonut(activos, view) {
  const canvas = document.getElementById("chartPie");
  if (!canvas) return;

  const { sorted, colors } = buildGrupos(activos, view);
  const labels = sorted.map(e => e[0]);
  const data   = sorted.map(e => e[1]);

  if (chartPie) chartPie.destroy();

  chartPie = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: "#f9fafb" }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { left: 0 } },
      events: ["mousemove", "mouseout", "click", "touchstart", "touchmove", "touchend"],
      plugins: {
        legend: {
          position: "right",
          labels: { color: "#374151", font: { size: 14 }, padding: 10, boxWidth: 12, maxWidth: 200 },
        },
        tooltip: {
          callbacks: {
            label(ctx) {
              const total = ctx.dataset.data.reduce((s, v) => s + v, 0);
              const pct   = total > 0 ? ((ctx.raw / total) * 100).toFixed(1) : "0";
              return ` ${formatARS(ctx.raw)} (${pct}%)`;
            },
          },
        },
        datalabels: {
          color: "#fff",
          font: { size: 14, weight: "bold" },
          formatter(value, ctx) {
            const total = ctx.dataset.data.reduce((s, v) => s + v, 0);
            const pct   = total > 0 ? (value / total) * 100 : 0;
            return pct >= 6 ? pct.toFixed(1) + "%" : "";
          },
          display(ctx) {
            const total = ctx.dataset.data.reduce((s, v) => s + v, 0);
            return total > 0 && (ctx.dataset.data[ctx.dataIndex] / total) * 100 >= 6;
          },
        },
      },
    },
  });
}

function wrapLabel(text, maxChars = 12) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!line) { line = w; continue; }
    const test = `${line} ${w}`;
    if (test.length <= maxChars) { line = test; }
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

function renderTreemap(activos, view) {
  const canvas = document.getElementById("chartPie");
  if (!canvas) return;

  const { sorted, colors } = buildGrupos(activos, view);
  const total    = sorted.reduce((s, [, v]) => s + v, 0);
  const perfMap  = buildPerfMap(activos, view);

  // Colores: por sector → performance encoding; por tipo → paleta fija
  const finalColors = (view === "sector")
    ? buildSectorPerfColors(activos, sorted.map(([name]) => name))
    : colors;
  const colorMap = {};
  sorted.forEach(([name], i) => { colorMap[name] = finalColors[i]; });

  if (chartPie) chartPie.destroy();

  chartPie = new Chart(canvas, {
    type: "treemap",
    data: {
      datasets: [{
        label: "Composición",
        data: sorted.map(([label, value]) => ({ label, value, perf: perfMap[label] ?? null })),
        key: "value",
        labels: {
          display: true,
          formatter(ctx) {
            const d       = ctx.raw._data;
            if (!d) return "";
            const areaPct = total > 0 ? (d.value / total) * 100 : 0;
            if (areaPct < 4) return "";
            const perf    = d.perf;
            const perfStr = perf != null
              ? (perf >= 0 ? "+" : "") + perf.toFixed(1) + "%"
              : "";
            if (areaPct < 8) return perfStr;
            const labelLines = wrapLabel(d.label);
            return [...labelLines, perfStr];
          },
          color:     ["#fff", "#fff", "#fff", "#ffffffdd"],
          font:      [{ size: 13, weight: "bold" }, { size: 13, weight: "bold" }, { size: 13, weight: "bold" }, { size: 12 }],
          hoverColor:["#fff", "#fff", "#fff", "#ffffffdd"],
          align: "center",
          position: "middle",
        },
        backgroundColor(ctx) {
          return colorMap[ctx.raw._data?.label] || "#1e2020";
        },
        borderColor: "#111",
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      events: ["mousemove", "mouseout", "click", "touchstart", "touchmove", "touchend"],
      plugins: {
        legend:     { display: false },
        datalabels: { display: false },
        tooltip: {
          callbacks: {
            title(items) { return items[0]?.raw._data?.label || ""; },
            label(ctx) {
              const d = ctx.raw._data;
              if (!d) return "";
              const composPct = total > 0 ? (d.value / total * 100).toFixed(1) : "0";
              const perfStr   = d.perf != null
                ? ` · Rend: ${d.perf >= 0 ? "+" : ""}${d.perf.toFixed(1)}%`
                : "";
              return ` ${formatARS(d.value)} (${composPct}% cartera)${perfStr}`;
            },
          },
        },
      },
    },
  });
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

function horaActual() {
  return new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

// ─── Exposición global para Alpine.js ─────────────────────────────────────────
window.getTipo            = getTipo;
window.loadDashboard      = loadDashboard;
window.calcTotalReturn    = calcTotalReturn;
window.calcReturn30d      = calcReturn30d;
window.calcTotalCartera   = calcTotalCartera;
window.getDisponible      = getDisponible;
window.getActivosConCash  = getActivosConCash;
window.getSector          = getSector;
window.sortActivos        = sortActivos;
window.formatValor        = formatValor;
window.formatARS          = formatARS;
window.formatUSD          = formatUSD;
window.formatPct          = formatPct;
window.formatDateLabel    = formatDateLabel;
window.renderChart        = renderChart;
window.renderHistoryChart = renderHistoryChart;
window.renderCarteraUSDChart = renderCarteraUSDChart;
window.saveMPRate            = saveMPRate;
