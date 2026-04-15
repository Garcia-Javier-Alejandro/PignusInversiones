/**
 * app.js — Lógica del dashboard Pignus
 *
 * Este archivo maneja todo el comportamiento dinámico del dashboard:
 *   - Fetch de datos al Worker (portafolio + estado de cuenta) y a dolarapi.com (MEP)
 *   - Cálculo de rendimientos y totales
 *   - Render de los gráficos de torta (Chart.js)
 *   - Formateo de números en ARS y USD
 *
 * Está pensado para ser legible y fácil de modificar:
 *   - Para cambiar la URL del Worker: buscar WORKER_URL más abajo.
 *   - Para agregar un activo nuevo al mapa de sectores: buscar SECTORES más abajo.
 *   - Para cambiar cómo se muestran los números: buscar formatARS / formatUSD.
 */

"use strict";

// ─── URL del Worker ────────────────────────────────────────────────────────────
// Reemplazar con la URL real del Worker después del primer deploy.
// Ejemplo: "https://pignus-api.tuusuario.workers.dev"
const WORKER_URL = "https://pignus-api.REEMPLAZAR.workers.dev";

// ─── Mapa de sectores por símbolo ─────────────────────────────────────────────
// Cada posición del portafolio se clasifica según este mapa para el gráfico
// de torta "Por sector".
//
// Para AGREGAR un activo nuevo:
//   1. Abrir este archivo.
//   2. Agregar una línea con el símbolo (exactamente como aparece en IOL) y el sector.
//   3. Hacer push a GitHub — Cloudflare Pages lo deploya automáticamente.
//
// Si un símbolo no está en el mapa, se clasifica como "Otros".
const SECTORES = {
  ASML:    "Tecnología",
  COPX:    "Materiales estratégicos",  // ETF de mineras de cobre
  GGAL:    "Financiero",
  GLD:     "Oro",
  IOLCAMA: "Liquidez",                  // FCI de Money Market de IOL
  MELI:    "Tecnología",
  MSFT:    "Tecnología",
  NU:      "Financiero",
  SLB:     "Hidrocarburos",             // oilfield services
  SPY:     "Diversificado",             // ETF S&P 500
  TX26:    "Renta fija CER",            // Boncer vto 2026
  TZX26:   "Renta fija CER",            // CER V30 vto 2026
  URA:     "Energía nuclear",           // ETF de uranio
  VIST:    "Hidrocarburos",
  XLE:     "Hidrocarburos",             // ETF sector energía
  XLV:     "Salud",                     // ETF sector salud
  XOM:     "Hidrocarburos",
};

// ─── Paleta de colores para los gráficos ──────────────────────────────────────
// Colores por tipo de activo (torta 1)
const COLORES_TIPO = {
  "CEDEAR":      "#3b82f6",   // azul
  "Renta Fija":  "#f59e0b",   // ámbar
  "FCI":         "#10b981",   // verde
  "Acciones":    "#8b5cf6",   // violeta
  "Otros":       "#6b7280",   // gris
};

// Paleta general para sectores (torta 2). Se asigna por orden de aparición.
const PALETA_SECTORES = [
  "#3b82f6", "#f59e0b", "#10b981", "#8b5cf6", "#ef4444",
  "#06b6d4", "#f97316", "#84cc16", "#ec4899", "#a78bfa",
  "#14b8a6", "#fb923c",
];

// Referencias a las instancias de Chart.js (para poder destruirlas al recargar)
let chartTipo = null;
let chartSector = null;

// ─── Función principal ────────────────────────────────────────────────────────

/**
 * Carga todos los datos del dashboard en paralelo y actualiza la UI.
 * Se llama al iniciar la página y cada vez que el usuario presiona "Actualizar".
 *
 * Esta función es la que Alpine.js invoca cuando el componente se monta
 * y cuando se presiona el botón de refresh.
 */
async function loadDashboard(alpineState) {
  alpineState.loading = true;
  alpineState.error = null;

  try {
    // Fetch en paralelo: portfolio, cuenta y cotización MEP
    const [portfolio, account, mep] = await Promise.all([
      fetchJSON(`${WORKER_URL}/api/portfolio`),
      fetchJSON(`${WORKER_URL}/api/account`),
      fetchMEP(),
    ]);

    alpineState.portfolio = portfolio;
    alpineState.account = account;
    alpineState.mep = mep;
    alpineState.updatedAt = horaActual();

    // Renderizar gráficos con los datos recibidos
    const activos = portfolio.activos || [];
    renderChartTipo(activos);
    renderChartSector(activos);

  } catch (err) {
    alpineState.error = err.message;
    console.error("Error cargando dashboard:", err);
  } finally {
    alpineState.loading = false;
  }
}

// ─── Fetch de datos ───────────────────────────────────────────────────────────

/**
 * Hace un GET y devuelve el JSON parseado.
 * Lanza un error con mensaje legible si el request falla.
 */
async function fetchJSON(url) {
  const response = await fetch(url);
  if (!response.ok) {
    let msg = `Error ${response.status}`;
    try {
      const data = await response.json();
      msg = data.error || msg;
    } catch (_) {}
    throw new Error(msg);
  }
  return response.json();
}

/**
 * Obtiene la cotización del dólar MEP desde dolarapi.com.
 * Devuelve el promedio entre compra y venta.
 * Si falla (el servicio externo puede caer), devuelve null — el dashboard
 * seguirá funcionando mostrando solo valores en ARS.
 */
async function fetchMEP() {
  try {
    const data = await fetchJSON("https://dolarapi.com/v1/dolares/bolsa");
    const compra = data.compra || 0;
    const venta = data.venta || 0;
    return (compra + venta) / 2;
  } catch (err) {
    console.warn("No se pudo obtener el dólar MEP:", err.message);
    return null;
  }
}

// ─── Cálculos financieros ─────────────────────────────────────────────────────

/**
 * Calcula el rendimiento total ponderado de todos los activos.
 * Fórmula: suma de ganancias / suma de costos × 100
 *
 * @param {Array} activos — lista de posiciones del portafolio
 * @returns {number} porcentaje de rendimiento (puede ser negativo)
 */
function calcTotalReturn(activos) {
  if (!activos || activos.length === 0) return 0;
  const gain = activos.reduce((s, a) => s + (a.gananciaDinero || 0), 0);
  const cost = activos.reduce((s, a) => s + ((a.ppc || 0) * (a.cantidad || 0)), 0);
  return cost > 0 ? (gain / cost) * 100 : 0;
}

/**
 * Calcula el valor total de la cartera: activos valorizados + disponible en efectivo.
 * @param {object} portfolio — respuesta de /api/portfolio
 * @param {object} account   — respuesta de /api/account
 */
function calcTotalCartera(portfolio, account) {
  const titulos = portfolio?.activos?.reduce((s, a) => s + (a.valorizado || 0), 0) || 0;
  const disponible = account?.cuentas?.[0]?.saldos?.find(s => s.descripcion === "Disponible")?.monto || 0;
  return titulos + disponible;
}

/**
 * Extrae el saldo disponible en pesos del estado de cuenta.
 */
function getDisponible(account) {
  return account?.cuentas?.[0]?.saldos?.find(s => s.descripcion === "Disponible")?.monto || 0;
}

// ─── Formato de números ───────────────────────────────────────────────────────

/**
 * Formatea un valor en pesos argentinos con formato local (punto = miles, coma = decimal).
 * Escala automáticamente: M para millones, k para miles, o el número completo.
 *
 * Ejemplos:
 *   1.500.000 → "$1,5M"
 *   826.432   → "$826k"
 *   1.794     → "$1.794"
 */
function formatARS(v) {
  if (v == null || isNaN(v)) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000) {
    return `${sign}$${(abs / 1_000_000).toLocaleString("es-AR", { maximumFractionDigits: 2 })}M`;
  }
  if (abs >= 1_000) {
    return `${sign}$${(abs / 1_000).toLocaleString("es-AR", { maximumFractionDigits: 1 })}k`;
  }
  return `${sign}$${abs.toLocaleString("es-AR", { maximumFractionDigits: 0 })}`;
}

/**
 * Formatea un valor en dólares (MEP o nominales).
 * Ejemplos:
 *   1200  → "USD 1,2k"
 *   638   → "USD 638"
 */
function formatUSD(v) {
  if (v == null || isNaN(v)) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000) {
    return `${sign}USD ${(abs / 1_000).toLocaleString("es-AR", { maximumFractionDigits: 1 })}k`;
  }
  return `${sign}USD ${abs.toLocaleString("es-AR", { maximumFractionDigits: 0 })}`;
}

/**
 * Formatea un valor en la moneda actualmente seleccionada (ARS o MEP).
 * Si moneda es "MEP" y hay cotización disponible, divide por el MEP.
 * Si no hay MEP disponible, muestra igual en ARS con una nota.
 *
 * @param {number} pesos  — valor en pesos argentinos
 * @param {string} moneda — "ARS" o "MEP"
 * @param {number|null} mep — cotización del dólar MEP (null si no está disponible)
 */
function formatValor(pesos, moneda, mep) {
  if (moneda === "MEP" && mep) {
    return formatUSD(pesos / mep);
  }
  return formatARS(pesos);
}

/**
 * Formatea un porcentaje con signo y un decimal.
 * Ejemplo: 12.3456 → "+12,3%"
 */
function formatPct(v) {
  if (v == null || isNaN(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

// ─── Gráficos de torta (Chart.js) ─────────────────────────────────────────────

/**
 * Renderiza la torta "Por tipo de activo" (CEDEAR, Renta Fija, FCI, Acciones).
 * Destruye la instancia anterior si existe para evitar duplicados.
 *
 * El tipo de activo lo provee IOL en el campo `tipo` de cada activo.
 */
function renderChartTipo(activos) {
  const canvas = document.getElementById("chartTipo");
  if (!canvas) return;

  // Agrupar por tipo sumando el valor valorizado
  const grupos = {};
  for (const a of activos) {
    const tipo = a.tipo || "Otros";
    grupos[tipo] = (grupos[tipo] || 0) + (a.valorizado || 0);
  }

  const labels = Object.keys(grupos);
  const data = Object.values(grupos);
  const colors = labels.map(l => COLORES_TIPO[l] || COLORES_TIPO["Otros"]);

  if (chartTipo) chartTipo.destroy();

  chartTipo = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: "#1e293b" }],
    },
    options: chartOptions("Tipo de activo"),
  });
}

/**
 * Renderiza la torta "Por sector" usando el mapa SECTORES definido arriba.
 * Los activos que no están en el mapa van a "Otros".
 */
function renderChartSector(activos) {
  const canvas = document.getElementById("chartSector");
  if (!canvas) return;

  // Agrupar por sector usando el mapa SECTORES
  const grupos = {};
  for (const a of activos) {
    const simbolo = a.simbolo || a.titulo?.simbolo || "";
    const sector = SECTORES[simbolo] || "Otros";
    grupos[sector] = (grupos[sector] || 0) + (a.valorizado || 0);
  }

  // Ordenar por valor descendente para que los segmentos más grandes vayan primero
  const sorted = Object.entries(grupos).sort((a, b) => b[1] - a[1]);
  const labels = sorted.map(e => e[0]);
  const data = sorted.map(e => e[1]);
  const colors = labels.map((_, i) => PALETA_SECTORES[i % PALETA_SECTORES.length]);

  if (chartSector) chartSector.destroy();

  chartSector = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: "#1e293b" }],
    },
    options: chartOptions("Por sector"),
  });
}

/**
 * Opciones comunes para ambas tortas (Chart.js config).
 * Muestra porcentaje en los tooltips y leyenda a la derecha (o abajo en mobile).
 */
function chartOptions(title) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: "bottom",
        labels: {
          color: "#cbd5e1",       // slate-300
          font: { size: 11 },
          padding: 12,
          boxWidth: 12,
        },
      },
      tooltip: {
        callbacks: {
          label(ctx) {
            const total = ctx.dataset.data.reduce((s, v) => s + v, 0);
            const pct = total > 0 ? ((ctx.raw / total) * 100).toFixed(1) : "0";
            return ` ${formatARS(ctx.raw)} (${pct}%)`;
          },
        },
      },
    },
  };
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

/**
 * Devuelve la hora actual formateada como "HH:MM".
 */
function horaActual() {
  return new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}

// ─── Exposición global para Alpine.js ─────────────────────────────────────────
// Alpine.js necesita acceder a estas funciones desde los atributos x-* del HTML.
// Las exponemos en window para que estén disponibles globalmente.
window.loadDashboard = loadDashboard;
window.calcTotalReturn = calcTotalReturn;
window.calcTotalCartera = calcTotalCartera;
window.getDisponible = getDisponible;
window.formatValor = formatValor;
window.formatARS = formatARS;
window.formatUSD = formatUSD;
window.formatPct = formatPct;
