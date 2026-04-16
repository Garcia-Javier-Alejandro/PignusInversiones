/**
 * app.js — Lógica del dashboard Pignus-Inversiones
 */

"use strict";

// ─── URL del Worker ────────────────────────────────────────────────────────────
const WORKER_URL = "https://pignus-api.garcia-javier-alejandro.workers.dev";

// ─── Mapa de sectores por símbolo ─────────────────────────────────────────────
const SECTORES = {
  ASML:    "Tecnología",
  CASH:    "Efectivo",
  COPX:    "Materiales",
  GGAL:    "Financiero",
  GLD:     "Oro",
  IOLCAMA: "Liquidez",
  MELI:    "Tecnología",
  MSFT:    "Tecnología",
  NU:      "Financiero",
  SLB:     "Hidrocarburos",
  SPY:     "Diversificado",
  TX26:    "Renta fija CER",
  TZX26:   "Renta fija CER",
  URA:     "Energía nuclear",
  VIST:    "Hidrocarburos",
  XLE:     "Hidrocarburos",
  XLV:     "Salud",
  XOM:     "Hidrocarburos",
};

// ─── Paletas ───────────────────────────────────────────────────────────────────
const COLORES_TIPO = {
  "CEDEAR":    "#3b82f6",
  "Renta Fija":"#f59e0b",
  "FCI":       "#10b981",
  "Acciones":  "#8b5cf6",
  "Efectivo":  "#6b7280",
  "Otros":     "#9ca3af",
};

const PALETA_SECTORES = [
  "#3b82f6","#f59e0b","#10b981","#8b5cf6","#ef4444",
  "#06b6d4","#f97316","#84cc16","#ec4899","#a78bfa",
  "#14b8a6","#fb923c",
];

let chartPie = null;

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
      alpineState.mep        = mep;
      alpineState.updatedAt  = horaActual();
      renderChart(getActivosConCash(portfolio, account), alpineState.chartView);
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
    const data = await fetchJSON("https://dolarapi.com/v1/dolares/bolsa");
    return ((data.compra || 0) + (data.venta || 0)) / 2;
  } catch (err) {
    console.warn("No se pudo obtener el dólar MEP:", err.message);
    return null;
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
      case "valorizado":va = a.valorizado         || 0; vb = b.valorizado         || 0; break;
      case "pct":       va = a.gananciaPorcentaje || 0; vb = b.gananciaPorcentaje || 0; break;
      case "dinero":    va = a.gananciaDinero      || 0; vb = b.gananciaDinero      || 0; break;
      default:          va = a.valorizado         || 0; vb = b.valorizado         || 0;
    }
    return dir === "asc" ? va - vb : vb - va;
  });
}

// ─── Cálculos financieros ─────────────────────────────────────────────────────

function calcTotalReturn(activos) {
  if (!activos || activos.length === 0) return 0;
  // Excluir CASH: no tiene rendimiento
  const posiciones = activos.filter(a => (a.titulo?.simbolo || a.simbolo) !== "CASH");
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

// ─── Formato de números ───────────────────────────────────────────────────────

function formatARS(v) {
  if (v == null || isNaN(v)) return "—";
  const abs  = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toLocaleString("es-AR", { maximumFractionDigits: 2 })}M`;
  if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toLocaleString("es-AR", { maximumFractionDigits: 1 })}k`;
  return `${sign}$${abs.toLocaleString("es-AR", { maximumFractionDigits: 0 })}`;
}

function formatUSD(v) {
  if (v == null || isNaN(v)) return "—";
  const abs  = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000) return `${sign}USD ${(abs / 1_000).toLocaleString("es-AR", { maximumFractionDigits: 1 })}k`;
  return `${sign}USD ${abs.toLocaleString("es-AR", { maximumFractionDigits: 0 })}`;
}

function formatValor(pesos, moneda, mep) {
  if (moneda === "MEP" && mep) return formatUSD(pesos / mep);
  return formatARS(pesos);
}

function formatPct(v) {
  if (v == null || isNaN(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

// ─── Gráfico de torta (único, con vista intercambiable) ───────────────────────

function renderChart(activos, view) {
  const canvas = document.getElementById("chartPie");
  if (!canvas) return;

  const grupos = {};
  for (const a of activos) {
    const key = view === "tipo" ? (a.tipo || "Otros") : getSector(a);
    grupos[key] = (grupos[key] || 0) + (a.valorizado || 0);
  }

  const sorted = Object.entries(grupos).sort((a, b) => b[1] - a[1]);
  const labels = sorted.map(e => e[0]);
  const data   = sorted.map(e => e[1]);
  const colors = view === "tipo"
    ? labels.map(l => COLORES_TIPO[l] || COLORES_TIPO["Otros"])
    : labels.map((_, i) => PALETA_SECTORES[i % PALETA_SECTORES.length]);

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
      plugins: {
        legend: {
          position: "right",
          labels: { color: "#374151", font: { size: 11 }, padding: 12, boxWidth: 12 },
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
      },
    },
  });
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

function horaActual() {
  return new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}

// ─── Exposición global para Alpine.js ─────────────────────────────────────────
window.loadDashboard     = loadDashboard;
window.calcTotalReturn   = calcTotalReturn;
window.calcTotalCartera  = calcTotalCartera;
window.getDisponible     = getDisponible;
window.getActivosConCash = getActivosConCash;
window.getSector         = getSector;
window.sortActivos       = sortActivos;
window.formatValor       = formatValor;
window.formatARS         = formatARS;
window.formatUSD         = formatUSD;
window.formatPct         = formatPct;
window.renderChart       = renderChart;
