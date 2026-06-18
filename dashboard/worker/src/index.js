/**
 * Cloudflare Worker — pignus-api
 *
 * Proxy seguro entre el frontend (Cloudflare Pages) y la API de IOL.
 * Responsabilidades:
 *   1. Mantener un token de IOL válido (lo renueva automáticamente usando KV).
 *   2. Exponer dos endpoints para el dashboard:
 *        GET /api/portfolio  → portafolio Argentina con todas las posiciones
 *        GET /api/account    → estado de cuenta (saldo disponible en pesos)
 *   3. Manejar CORS para que el navegador pueda hacer los fetch desde Pages.
 *
 * Variables de entorno requeridas (configurar con `wrangler secret put`):
 *   IOL_USERNAME    — email de la cuenta IOL
 *   IOL_PASSWORD    — contraseña de la cuenta IOL
 *   ALLOWED_ORIGIN  — URL exacta del frontend (ej: https://pignusinversiones.pages.dev)
 *
 * KV Binding requerido (configurar en wrangler.toml):
 *   TOKEN_CACHE     — namespace de KV donde se guarda el token
 */

// ─── Constantes ────────────────────────────────────────────────────────────────

const IOL_BASE = "https://api.invertironline.com";

// Cuántos segundos antes de que expire el token lo renovamos preventivamente.
// IOL emite tokens de 1200 segundos (~20 min). Renovamos si faltan menos de 60s.
const TOKEN_REFRESH_MARGIN_SEC = 60;

// Sector por símbolo — usado en /api/report-data
const SECTOR_MAP = {
  TZX26:   "Renta Fija CER",
  TX26:    "Renta Fija CER",
  GLD:     "Materias Primas",
  COPX:    "Minería",
  URA:     "Energía",
  SLB:     "Energía",
  XOM:     "Energía",
  XLE:     "Energía",
  GGAL:    "Acciones Argentinas",
  VIST:    "Acciones Argentinas",
  MELI:    "Tecnología",
  MSFT:    "Tecnología",
  ASML:    "Tecnología",
  NU:      "Fintech Global",
  SPY:     "Renta Variable Global",
  XLV:     "Salud",
  IOLCAMA: "Liquidez",
};

// ─── Helpers de CORS ──────────────────────────────────────────────────────────

/**
 * Verifica si requestOrigin está en la lista de orígenes permitidos.
 * ALLOWED_ORIGIN puede ser un valor único o una lista separada por comas.
 * Devuelve el origen coincidente, o null si no está permitido.
 */
function resolveOrigin(requestOrigin, allowedSetting) {
  if (!allowedSetting) return null;
  const allowed = allowedSetting.split(",").map(s => s.trim());
  return allowed.includes(requestOrigin) ? requestOrigin : null;
}

// ─── Entry point del Worker ────────────────────────────────────────────────────

export default {
  /**
   * Maneja cada request que llega al Worker.
   * El Worker solo acepta requests desde el origen autorizado (ALLOWED_ORIGIN),
   * excepto los OPTIONS de preflight que necesitan responder sin credenciales.
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── CORS preflight ──────────────────────────────────────────────────────────
    // Los navegadores mandan un OPTIONS antes del GET real para verificar permisos.
    // Hay que responder 204 con los headers de CORS correctos.
    const requestOrigin = request.headers.get("Origin") || "";
    const matchedOrigin = resolveOrigin(requestOrigin, env.ALLOWED_ORIGIN);
    if (request.method === "OPTIONS") {
      return corsPreflightResponse(matchedOrigin);
    }

    // ── Verificar origen ────────────────────────────────────────────────────────
    // Solo aceptamos requests del frontend autorizado. Esto evita que terceros
    // usen nuestro Worker como proxy gratuito hacia IOL.
    if (env.ALLOWED_ORIGIN && !matchedOrigin) {
      return new Response("Forbidden", { status: 403 });
    }

    // ── Routing ─────────────────────────────────────────────────────────────────
    try {
      if (url.pathname === "/api/portfolio") {
        return await handlePortfolio(request, env);
      }
      if (url.pathname === "/api/account") {
        return await handleAccount(request, env);
      }
      if (url.pathname === "/api/history") {
        return await handleHistory(request, env);
      }
      if (url.pathname === "/api/snapshot" && request.method === "POST") {
        return await handleSnapshot(request, env);
      }
      if (url.pathname === "/api/positions") {
        return await handlePositions(request, env);
      }
      if (url.pathname === "/api/mep") {
        return await handleMEP(request, env);
      }
      if (url.pathname === "/api/mp-rate" && request.method === "POST") {
        return await handleMPRate(request, env);
      }
      if (url.pathname === "/api/deposit" && request.method === "POST") {
        return await handleDeposit(request, env);
      }
      if (url.pathname === "/api/deposits") {
        return await handleGetDeposits(request, env);
      }
      if (url.pathname === "/api/report-data") {
        return await handleReportData(request, env);
      }
      if (url.pathname === "/api/reports" && request.method === "GET") {
        return await handleGetReports(request, env);
      }
      if (url.pathname === "/api/reports" && request.method === "POST") {
        return await handleSaveReport(request, env);
      }
      if (url.pathname === "/api/graciela/operations" && request.method === "GET") {
        return await handleGetGracielaOps(request, env);
      }
      if (url.pathname === "/api/graciela/operations" && request.method === "POST") {
        return await handleAddGracielaOp(request, env);
      }
      if (url.pathname === "/api/graciela/operations/import" && request.method === "PUT") {
        return await handleImportGracielaOps(request, env);
      }
      if (url.pathname.startsWith("/api/graciela/operations/") && request.method === "DELETE") {
        const opId = url.pathname.split("/").pop();
        return await handleDeleteGracielaOp(request, env, opId);
      }
      if (url.pathname === "/api/feedback" && request.method === "POST") {
        return await handleFeedback(request, env, matchedOrigin);
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      // Si algo falla (IOL caído, token inválido, etc.), devolvemos el error
      // en formato JSON para que el frontend lo pueda mostrar.
      console.error("Worker error:", err.message);
      return jsonResponse(
        { error: err.message },
        { status: 502, origin: matchedOrigin }
      );
    }
  },

  /**
   * Cron trigger — guarda snapshot diario automáticamente al cierre del mercado.
   * Configurado en wrangler.toml: lunes a viernes a las 20:00 UTC (17:00 ARG).
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailySnapshot(env));
  },
};

// ─── Handlers de endpoints ─────────────────────────────────────────────────────

/**
 * GET /api/portfolio
 * Proxy a GET /api/v2/portafolio/argentina de IOL.
 * Devuelve el portafolio completo con todas las posiciones valorizadas.
 */
async function handlePortfolio(request, env) {
  const portfolioParam = new URL(request.url).searchParams.get("portfolio");
  const token = await getValidToken(env);
  const data  = await iolGet("/api/v2/portafolio/argentina", token, env);
  if (portfolioParam === "graciela" || portfolioParam === "pignus") {
    const ops        = await kvGet(env, "graciela_operations", []);
    const gracielaPos = computeGracielaPositions(ops);
    const split      = splitPortfolioActivos(data, gracielaPos);
    return jsonResponse({ ...data, activos: split[portfolioParam] }, { origin: request.headers.get("Origin") || "" });
  }
  return jsonResponse(data, { origin: request.headers.get("Origin") || "" });
}

/**
 * GET /api/account
 * Proxy a GET /api/v2/estadocuenta de IOL.
 * Devuelve el estado de cuenta con el saldo disponible en pesos.
 */
async function handleAccount(request, env) {
  const portfolioParam = new URL(request.url).searchParams.get("portfolio");
  const token = await getValidToken(env);
  const data  = await iolGet("/api/v2/estadocuenta", token, env);
  if (portfolioParam === "graciela" || portfolioParam === "pignus") {
    const ops         = await kvGet(env, "graciela_operations", []);
    const gracielaCash = computeGracielaCash(ops);
    const split       = splitAccountCash(data, gracielaCash);
    return jsonResponse(split[portfolioParam], { origin: request.headers.get("Origin") || "" });
  }
  return jsonResponse(data, { origin: request.headers.get("Origin") || "" });
}

// ─── Historial y benchmarks ───────────────────────────────────────────────────

/**
 * GET /api/history
 * Devuelve snapshots de la cartera y precios históricos de SPY.
 * Cada snapshot ya incluye mpVcp (Valor Cuota Patrimonial de Mercado Fondo - Clase A).
 * Si algún snapshot no tiene VCP (guardado antes de esta feature), lo backfilla y persiste.
 */
async function handleHistory(request, env) {
  const portfolioParam = new URL(request.url).searchParams.get("portfolio");
  if (portfolioParam === "graciela") return await handleGracielaHistory(request, env);
  if (portfolioParam === "pignus")   return await handlePignusHistory(request, env);
  let   snapshots = await kvGet(env, "portfolio_history", []);
  let   deposits  = await kvGet(env, "deposits", []);

  // Backfill mpVcp en snapshots que no lo tengan
  let snapshotsChanged = false;
  for (const snap of snapshots) {
    if (snap.mpVcp == null) {
      snap.mpVcp = await fetchMercadoFondoVCP(snap.date);
      if (snap.mpVcp) snapshotsChanged = true;
    }
  }

  // Backfill mep: 1) lookup estático exacto, 2) argentinadatos.com con fallback a días cercanos.
  for (const snap of snapshots) {
    if (snap.mep == null || snap.mep <= 1) {
      snap.mep = MEP_HISTORICO[snap.date] ?? await fetchMepNearDate(snap.date);
      if (snap.mep) snapshotsChanged = true;
    }
  }

  // Segundo pase: interpolación lineal para fechas que siguen sin MEP
  // (argentinadatos.com puede no tener datos para rangos de feriados extendidos).
  {
    const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
    const fills  = new Map();
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].mep != null && sorted[i].mep > 1) continue;
      let prev = null, next = null;
      for (let j = i - 1; j >= 0; j--) {
        if (sorted[j].mep > 1) { prev = sorted[j]; break; }
      }
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].mep > 1) { next = sorted[j]; break; }
      }
      let val = null;
      if (prev && next) {
        const t0 = new Date(prev.date).getTime();
        const t1 = new Date(next.date).getTime();
        const ti = new Date(sorted[i].date).getTime();
        val = prev.mep + (next.mep - prev.mep) * ((ti - t0) / (t1 - t0));
      } else if (prev) {
        val = prev.mep;
      } else if (next) {
        val = next.mep;
      }
      if (val) fills.set(sorted[i].date, val);
    }
    for (const snap of snapshots) {
      if (fills.has(snap.date)) { snap.mep = fills.get(snap.date); snapshotsChanged = true; }
    }
  }

  if (snapshotsChanged) {
    await env.TOKEN_CACHE.put("portfolio_history", JSON.stringify(snapshots));
  }

  const spyPrices = await getSPYHistory(env);
  const spyByDate = {};
  for (const p of spyPrices) spyByDate[p.date] = p.price;

  // Inferir depósitos/retiros de snapshots consecutivos con totalGanancia
  const inferred = inferDeposits(snapshots, deposits);
  if (inferred.length > 0) {
    for (const dep of inferred) {
      // Precios para el benchmark: usar datos del snapshot de ese día
      const snap = snapshots.find(s => s.date === dep.date);
      dep.mpVcp    = snap?.mpVcp || null;
      dep.spyPrice = spyByDate[dep.date] || nearestSpyPrice(spyPrices, dep.date);
      deposits.push(dep);
    }
    deposits.sort((a, b) => a.date.localeCompare(b.date));
  }

  // Backfill mpVcp, spyPrice y mep en depósitos que los necesiten.
  // spyPrice se fuerza a refrescar siempre desde los datos actuales: el valor guardado
  // puede venir de cuando IOL devolvía el mismo precio actual para toda la historia.
  let depositsChanged = inferred.length > 0;
  for (const dep of deposits) {
    if (dep.mpVcp == null) {
      dep.mpVcp = await fetchMercadoFondoVCP(dep.date);
      if (dep.mpVcp) depositsChanged = true;
    }
    const freshSpy = spyByDate[dep.date] || nearestSpyPrice(spyPrices, dep.date);
    if (freshSpy && freshSpy !== dep.spyPrice) {
      dep.spyPrice = freshSpy;
      depositsChanged = true;
    }
    if (dep.mep == null) {
      const m = nearestMepForDate(snapshots, dep.date);
      if (m) { dep.mep = m; depositsChanged = true; }
    }
  }
  if (depositsChanged) {
    await env.TOKEN_CACHE.put("deposits", JSON.stringify(deposits));
  }

  // Excluir del historial de Pignus los depósitos que pertenecen a Graciela.
  // La auto-detección trabaja sobre el total combinado y registraría los depósitos
  // de Graciela como depósitos de Pignus. Los filtramos por fecha.
  const gracielaOps = await kvGet(env, "graciela_operations", []);
  const gracielaDepositDates = new Set(
    gracielaOps
      .filter(op => op.type === "deposit" || op.type === "withdrawal")
      .map(op => op.date)
  );
  deposits = deposits.filter(d => !gracielaDepositDates.has(d.date));

  return jsonResponse({ snapshots, spyPrices, deposits }, { origin: request.headers.get("Origin") || "" });
}

/**
 * Infiere depósitos/retiros comparando snapshots consecutivos.
 * Condición: ambos deben tener totalGanancia, y el delta inexplicado > $500k.
 * No duplica depósitos ya registrados en el mismo período.
 */
function inferDeposits(snapshots, existingDeposits, threshold = 500_000) {
  const sorted = [...snapshots]
    .filter(s => s.totalGanancia != null)
    .sort((a, b) => a.date.localeCompare(b.date));

  const result = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const prev = sorted[i];
    const curr = sorted[i + 1];

    const rendimiento = curr.totalGanancia - prev.totalGanancia;
    const delta       = curr.totalARS      - prev.totalARS;
    const deposito    = delta - rendimiento;

    if (Math.abs(deposito) < threshold) continue;

    // No duplicar si ya hay un depósito registrado en este período
    const yaExiste = existingDeposits.some(
      d => d.date > prev.date && d.date <= curr.date
    );
    if (yaExiste) continue;

    result.push({
      date:   curr.date,
      amount: Math.round(deposito),
      note:   "Auto-detectado",
      auto:   true,
    });
  }
  return result;
}

/** Devuelve el precio SPY más reciente en o antes de targetDate. */
function nearestSpyPrice(spyPrices, targetDate) {
  let best = null;
  for (const p of spyPrices) {
    if (p.date <= targetDate && (best == null || p.date > best.date)) best = p;
  }
  return best?.price || null;
}

/** Devuelve el MEP del snapshot más cercano a targetDate (antes o después). */
function nearestMepForDate(snapshots, targetDate) {
  let before = null, after = null;
  for (const s of snapshots) {
    if (!s.mep || s.mep <= 1) continue;
    if (s.date <= targetDate) {
      if (!before || s.date > before.date) before = s;
    } else {
      if (!after  || s.date < after.date)  after  = s;
    }
  }
  if (before && after) {
    const db = new Date(targetDate) - new Date(before.date);
    const da = new Date(after.date)  - new Date(targetDate);
    return db <= da ? before.mep : after.mep;
  }
  return before?.mep ?? after?.mep ?? null;
}

/**
 * POST /api/snapshot
 * Body: { totalARS, mep, totalGanancia, activos }
 * El frontend llama a esto cada vez que carga datos válidos (una vez por día).
 * Guarda el resumen del día en portfolio_history y las posiciones compactas en positions_history.
 */
async function handleSnapshot(request, env) {
  const { totalARS, mep, totalGanancia, activos } = await request.json();
  if (!totalARS || totalARS <= 0) {
    return jsonResponse({ error: "Invalid data" }, { status: 400, origin: request.headers.get("Origin") || "" });
  }
  const { skipped } = await saveSnapshotToKV({ totalARS, mep, totalGanancia, activos }, env);
  return jsonResponse({ ok: true, skipped: !!skipped }, { origin: request.headers.get("Origin") || "" });
}

/**
 * Lógica compartida de guardado de snapshot. Usada por handleSnapshot (HTTP)
 * y runDailySnapshot (cron). Retorna { skipped: true } si ya existe para hoy.
 */
async function saveSnapshotToKV({ totalARS, mep, totalGanancia, activos }, env) {
  // Fecha en zona horaria de Argentina (UTC-3, sin DST). Usar UTC causaría que a las
  // 23:xx ARG el snapshot quede fechado al día siguiente.
  const today   = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Argentina/Buenos_Aires" });
  const history = await kvGet(env, "portfolio_history", []);

  if (history.some(s => s.date === today)) return { skipped: true };

  // Guardar resumen liviano (totales + benchmarks)
  const mpVcp = await fetchMercadoFondoVCP(today);
  history.push({ date: today, totalARS, totalGanancia: totalGanancia ?? null, mep: mep || null, mpVcp });
  await env.TOKEN_CACHE.put("portfolio_history", JSON.stringify(history));

  // Guardar posiciones compactas (campo a campo para minimizar tamaño en KV)
  if (Array.isArray(activos) && activos.length > 0) {
    const positions = await kvGet(env, "positions_history", []);
    const compact = activos.map(a => ({
      s:   a.titulo?.simbolo       || a.simbolo            || "",
      t:   a.titulo?.tipo          || a.tipo               || "",
      q:   a.cantidad              || 0,
      ppc: a.ppc                   || 0,
      v:   a.valorizado            || 0,
      g:   a.gananciaDinero        || 0,
      gp:  a.gananciaPorcentaje    || 0,
    }));
    positions.push({ date: today, activos: compact });
    await env.TOKEN_CACHE.put("positions_history", JSON.stringify(positions));
  }

  return { skipped: false };
}

/**
 * Obtiene el MEP actual usando la cadena de fallbacks (misma lógica que handleMEP
 * pero retorna el valor numérico directamente, sin construir una Response).
 */
async function getMepValue(env) {
  const PARES = [
    { ars: "/api/v2/cotizaciones/titulos/bCBA/AL30",  usd: "/api/v2/cotizaciones/titulos/bCBA/AL30D" },
    { ars: "/api/v2/cotizaciones/titulos/bCBA/GD30",  usd: "/api/v2/cotizaciones/titulos/bCBA/GD30D" },
    { ars: "/api/v2/cotizaciones/titulos/byma/AL30",  usd: "/api/v2/cotizaciones/titulos/byma/AL30D" },
    { ars: "/api/v2/cotizaciones/titulos/byma/GD30",  usd: "/api/v2/cotizaciones/titulos/byma/GD30D" },
    { ars: "/api/v2/cotizaciones/titulos/bCBA/AE38",  usd: "/api/v2/cotizaciones/titulos/bCBA/AE38D" },
    { ars: "/api/v2/cotizaciones/titulos/bCBA/GD35",  usd: "/api/v2/cotizaciones/titulos/bCBA/GD35D" },
  ];
  try {
    const token = await getValidToken(env);
    for (const par of PARES) {
      try {
        const [bARS, bUSD] = await Promise.all([iolGet(par.ars, token, env), iolGet(par.usd, token, env)]);
        const p = bARS.ultimoPrecio ?? bARS.precio;
        const q = bUSD.ultimoPrecio ?? bUSD.precio;
        if (p && q && q !== 0) return p / q;
      } catch { /* probar siguiente */ }
    }
  } catch { /* token o red falló */ }
  // Fallback externo
  try { return await fetchMepFromDolarApi(); } catch { /* ignorar */ }
  return null;
}

/**
 * Corre el snapshot diario desde el cron trigger.
 * Autentica con IOL, obtiene portafolio y MEP, y guarda en KV.
 */
async function runDailySnapshot(env) {
  try {
    const token     = await getValidToken(env);
    const [portfolio, account, mep] = await Promise.all([
      iolGet("/api/v2/portafolio/argentina", token, env),
      iolGet("/api/v2/estadocuenta",          token, env),
      getMepValue(env),
    ]);

    const cuentaPesos = (account?.cuentas || []).find(c => c.moneda === "peso_Argentino");
    const totalARS    = cuentaPesos?.total || 0;
    if (!totalARS) { console.error("Cron snapshot: totalARS inválido, abortando."); return; }

    const activos      = portfolio?.activos || [];
    const totalGanancia = activos.reduce((s, a) => s + (a.gananciaDinero || 0), 0);

    const { skipped } = await saveSnapshotToKV({ totalARS, mep, totalGanancia, activos }, env);
    console.log(`Cron snapshot: ${skipped ? "ya existía para hoy" : "guardado OK"} | ARS=${totalARS} | MEP=${mep}`);
  } catch (err) {
    console.error("Cron snapshot falló:", err.message);
  }
}

/**
 * GET /api/positions
 * Devuelve el historial completo de posiciones por día.
 * Cada entrada: { date, activos: [{ s, t, q, ppc, v, g, gp }] }
 * Campos: s=simbolo, t=tipo, q=cantidad, ppc=precio promedio compra,
 *         v=valorizado, g=gananciaDinero, gp=gananciaPorcentaje
 */
async function handlePositions(request, env) {
  const positions = await kvGet(env, "positions_history", []);
  return jsonResponse(positions, { origin: request.headers.get("Origin") || "" });
}

/**
 * GET /api/mep
 * Calcula el dólar MEP implícito como precio_AL30_ARS / precio_AL30D_USD.
 * AL30 y AL30D son el mismo bono soberano en distintas series de liquidación;
 * el cociente de precios da el tipo de cambio de mercado sin depender de
 * fuentes externas (solo IOL).
 * Caché KV de 15 minutos para no saturar el endpoint de cotizaciones.
 */
async function lastKnownMepFromSnapshots(env) {
  const snapshots = await kvGet(env, "portfolio_history", []);
  const last = [...snapshots].reverse().find(s => s.mep > 1);
  return last?.mep ?? null;
}

async function fetchMepFromDolarApi() {
  const res = await fetch("https://dolarapi.com/v1/dolares/bolsa");
  if (!res.ok) throw new Error(`dolarapi.com ${res.status}`);
  const { compra, venta } = await res.json();
  if (!compra || !venta) throw new Error("dolarapi.com: precios ausentes");
  return (compra + venta) / 2;
}

// Valores históricos exactos de MEP para fechas donde la API externa no tiene datos.
// Fuente: cotizaciones reales de mercado (compra == venta en todos los casos).
const MEP_HISTORICO = {
  // Marzo 2026
  "2026-03-02": 1413.54, "2026-03-03": 1434.11, "2026-03-04": 1427.70,
  "2026-03-05": 1433.21, "2026-03-06": 1437.53, "2026-03-09": 1430.17,
  "2026-03-10": 1422.12, "2026-03-11": 1413.80, "2026-03-12": 1415.52,
  "2026-03-13": 1424.34, "2026-03-16": 1424.92, "2026-03-17": 1417.30,
  "2026-03-18": 1420.38, "2026-03-19": 1421.08, "2026-03-20": 1422.13,
  "2026-03-23": 1415.68, "2026-03-24": 1415.68, "2026-03-25": 1404.55,
  "2026-03-26": 1401.28, "2026-03-27": 1429.73, "2026-03-30": 1432.51,
  "2026-03-31": 1422.84,
  // Abril 2026
  "2026-04-01": 1434.04, "2026-04-02": 1434.04, "2026-04-03": 1434.04,
  "2026-04-06": 1429.57, "2026-04-07": 1430.16, "2026-04-08": 1424.45,
  "2026-04-09": 1420.86, "2026-04-10": 1412.50, "2026-04-13": 1404.47,
  "2026-04-14": 1412.09, "2026-04-15": 1398.53, "2026-04-16": 1406.23,
  "2026-04-17": 1412.53, "2026-04-20": 1414.73, "2026-04-21": 1414.42,
  "2026-04-22": 1419.84, "2026-04-23": 1424.40, "2026-04-24": 1438.34,
  "2026-04-27": 1461.73, "2026-04-28": 1447.18, "2026-04-29": 1435.60,
  "2026-04-30": 1442.43,
};

async function fetchMepFromArgentinaDatos(date) {
  const [y, m, d] = date.split("-");
  const res = await fetch(`https://api.argentinadatos.com/v1/cotizaciones/dolares/bolsa/${y}/${m}/${d}`);
  if (!res.ok) return null;
  const { compra, venta } = await res.json();
  if (!compra || !venta) return null;
  return (compra + venta) / 2;
}

async function fetchMepNearDate(date) {
  const exact = await fetchMepFromArgentinaDatos(date);
  if (exact) return exact;
  // Si el día exacto no tiene cotización (feriado/fin de semana), retrocede hasta 5 días hábiles.
  const d = new Date(date + "T12:00:00Z");
  for (let i = 1; i <= 5; i++) {
    const prev = new Date(d);
    prev.setUTCDate(d.getUTCDate() - i);
    const mep = await fetchMepFromArgentinaDatos(prev.toISOString().split("T")[0]);
    if (mep) return mep;
  }
  return null;
}

async function handleMEP(request, env) {
  const cached = await kvGet(env, "mep_cache", null);
  if (cached && (Date.now() - cached.fetchedAt) < 15 * 60_000) {
    return jsonResponse(cached, { origin: request.headers.get("Origin") || "" });
  }

  // Fuera del horario de mercado (~17:00-11:00 ARG), IOL puede devolver precios cero
  // o el endpoint puede fallar. En ese caso devolvemos la caché aunque haya vencido
  // (stale: true) para que el frontend siempre tenga un MEP disponible.
  // Pares de bonos a intentar en orden. IOL cambia tickers/mercados sin previo aviso.
  const PARES = [
    { ars: "/api/v2/cotizaciones/titulos/bCBA/AL30",  usd: "/api/v2/cotizaciones/titulos/bCBA/AL30D",  label: "AL30/bCBA" },
    { ars: "/api/v2/cotizaciones/titulos/bCBA/GD30",  usd: "/api/v2/cotizaciones/titulos/bCBA/GD30D",  label: "GD30/bCBA" },
    { ars: "/api/v2/cotizaciones/titulos/byma/AL30",  usd: "/api/v2/cotizaciones/titulos/byma/AL30D",  label: "AL30/byma" },
    { ars: "/api/v2/cotizaciones/titulos/byma/GD30",  usd: "/api/v2/cotizaciones/titulos/byma/GD30D",  label: "GD30/byma" },
    { ars: "/api/v2/cotizaciones/titulos/bCBA/AE38",  usd: "/api/v2/cotizaciones/titulos/bCBA/AE38D",  label: "AE38/bCBA" },
    { ars: "/api/v2/cotizaciones/titulos/bCBA/GD35",  usd: "/api/v2/cotizaciones/titulos/bCBA/GD35D",  label: "GD35/bCBA" },
  ];

  try {
    const token = await getValidToken(env);

    for (const par of PARES) {
      try {
        const [bARS, bUSD] = await Promise.all([
          iolGet(par.ars, token, env),
          iolGet(par.usd, token, env),
        ]);
        const precioARS = bARS.ultimoPrecio ?? bARS.precio;
        const precioUSD = bUSD.ultimoPrecio ?? bUSD.precio;
        if (!precioARS || !precioUSD || precioUSD === 0) continue;

        const result = {
          mep:       precioARS / precioUSD,
          par:       par.label,
          fetchedAt: Date.now(),
        };
        await env.TOKEN_CACHE.put("mep_cache", JSON.stringify(result));
        return jsonResponse(result, { origin: request.headers.get("Origin") || "" });
      } catch {
        // Este par falló, probar el siguiente
      }
    }

    // Ningún par de IOL funcionó — intentar dolarapi.com como fuente externa
    try {
      const mepExterno = await fetchMepFromDolarApi();
      const result = { mep: mepExterno, par: "dolarapi.com", fetchedAt: Date.now() };
      await env.TOKEN_CACHE.put("mep_cache", JSON.stringify(result));
      return jsonResponse(result, { origin: request.headers.get("Origin") || "" });
    } catch { /* dolarapi.com también falló */ }

    // Último recurso: caché KV o último snapshot con MEP
    if (cached) return jsonResponse({ ...cached, stale: true }, { origin: request.headers.get("Origin") || "" });
    const lastSnapMep = await lastKnownMepFromSnapshots(env);
    if (lastSnapMep) return jsonResponse({ mep: lastSnapMep, stale: true, par: "snapshot" }, { origin: request.headers.get("Origin") || "" });
    return jsonResponse({ error: "MEP no disponible" }, { status: 502, origin: request.headers.get("Origin") || "" });

  } catch (err) {
    try {
      const mepExterno = await fetchMepFromDolarApi();
      const result = { mep: mepExterno, par: "dolarapi.com", fetchedAt: Date.now() };
      await env.TOKEN_CACHE.put("mep_cache", JSON.stringify(result));
      return jsonResponse(result, { origin: request.headers.get("Origin") || "" });
    } catch { /* dolarapi.com también falló */ }
    if (cached) return jsonResponse({ ...cached, stale: true }, { origin: request.headers.get("Origin") || "" });
    const lastSnapMep = await lastKnownMepFromSnapshots(env);
    if (lastSnapMep) return jsonResponse({ mep: lastSnapMep, stale: true, par: "snapshot" }, { origin: request.headers.get("Origin") || "" });
    return jsonResponse({ error: err.message }, { status: 502, origin: request.headers.get("Origin") || "" });
  }
}

/**
 * POST /api/mp-rate
 * Body: { dailyPct }  — porcentaje diario (ej: 0.089 para ~33% TNA)
 * Si ya existe un registro para hoy, lo reemplaza.
 */
async function handleMPRate(request, env) {
  const { dailyPct } = await request.json();
  if (dailyPct == null || isNaN(dailyPct) || dailyPct <= 0) {
    return jsonResponse({ error: "Invalid rate" }, { status: 400, origin: request.headers.get("Origin") || "" });
  }

  const today = new Date().toISOString().split("T")[0];
  const rates = await kvGet(env, "mp_rates", []);
  const idx   = rates.findIndex(r => r.date === today);
  if (idx >= 0) rates[idx].dailyPct = dailyPct;
  else rates.push({ date: today, dailyPct });

  await env.TOKEN_CACHE.put("mp_rates", JSON.stringify(rates));
  return jsonResponse({ ok: true }, { origin: request.headers.get("Origin") || "" });
}

/**
 * Obtiene precios históricos del CEDEAR SPY desde IOL.
 * Intenta bCBA primero, luego byma. Caché de 24h en KV.
 * Devuelve array de { date: "YYYY-MM-DD", price: number }.
 */
async function getSPYHistory(env) {
  const cached = await kvGet(env, "spy_history_cache_iol", null);
  if (cached?.prices?.length > 0 && (Date.now() - cached.fetchedAt) < 86_400_000) {
    return cached.prices;
  }

  // Fuente primaria: Yahoo Finance. Confiable, cubre 400 días con precios que varían.
  // IOL devuelve 'ultimoPrecio' igual para todos los días históricos, no sirve.
  const fromYahoo = await getSPYFromYahooFinance(env);
  if (fromYahoo.length > 0) {
    await env.TOKEN_CACHE.put("spy_history_cache_iol", JSON.stringify({ fetchedAt: Date.now(), prices: fromYahoo }));
    return fromYahoo;
  }

  // Fallback: IOL, sólo si devuelve precios históricos reales (variados, suficientes).
  const to   = new Date().toISOString().split("T")[0];
  const from = new Date(Date.now() - 365 * 86_400_000).toISOString().split("T")[0];
  const ENDPOINTS = [
    `/api/v2/cotizaciones/titulos/bCBA/SPY/historico/ajustada?fechaDesde=${from}&fechaHasta=${to}&ajustada=sinAjustar`,
    `/api/v2/cotizaciones/titulos/bCBA/SPY/historico?fechaDesde=${from}&fechaHasta=${to}&ajustada=sinAjustar`,
    `/api/v2/cotizaciones/titulos/byma/SPY/historico/ajustada?fechaDesde=${from}&fechaHasta=${to}&ajustada=sinAjustar`,
    `/api/v2/cotizaciones/titulos/byma/SPY/historico?fechaDesde=${from}&fechaHasta=${to}&ajustada=sinAjustar`,
  ];
  try {
    const token = await getValidToken(env);
    for (const endpoint of ENDPOINTS) {
      try {
        const data   = await iolGet(endpoint, token, env);
        const prices = parseSPYPrices(data);
        // Rechazar si no son precios históricos reales: IOL suele devolver ultimoPrecio
        // (precio actual) para todas las fechas, generando una línea plana.
        if (prices.length < 20) continue;
        const uniquePrices = new Set(prices.map(p => p.price)).size;
        if (uniquePrices < 10) continue;
        await env.TOKEN_CACHE.put("spy_history_cache_iol", JSON.stringify({ fetchedAt: Date.now(), prices }));
        console.log(`SPY history: ${prices.length} precios desde IOL (${uniquePrices} únicos)`);
        return prices;
      } catch (endpointErr) {
        console.warn(`SPY IOL endpoint falló:`, endpointErr.message);
      }
    }
  } catch (err) {
    console.warn("SPY: error de token:", err.message);
  }

  return cached?.prices || [];
}

/**
 * Obtiene precios históricos de SPY CEDEAR (ARS) usando Yahoo Finance como fuente.
 * Fórmula: CEDEAR_ARS = SPY_USD × MEP × ratio
 * donde ratio = CEDEAR_ARS / (SPY_USD × MEP) se calibra desde positions_history.
 */
async function getSPYFromYahooFinance(env) {
  try {
    const periodTo   = Math.floor(Date.now() / 1000);
    const periodFrom = Math.floor((Date.now() - 400 * 86_400_000) / 1000);
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&period1=${periodFrom}&period2=${periodTo}`,
      { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
    );
    if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status}`);

    const data   = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error("Yahoo Finance: sin resultado");

    const timestamps = result.timestamp || [];
    const closes     = result.indicators?.quote?.[0]?.close || [];

    // SPY USD por fecha (NYSE closing price)
    const spyUSDByDate = {};
    for (let i = 0; i < timestamps.length; i++) {
      if (!closes[i] || closes[i] <= 0) continue;
      const date = new Date(timestamps[i] * 1000).toISOString().split("T")[0];
      spyUSDByDate[date] = closes[i];
    }
    if (Object.keys(spyUSDByDate).length === 0) throw new Error("Yahoo Finance: sin precios");

    // MEP por fecha (portfolio_history)
    const snapshots = await kvGet(env, "portfolio_history", []);
    const mepByDate = {};
    for (const s of snapshots) {
      if (s.mep && s.mep > 1) mepByDate[s.date] = s.mep;
    }

    // Calibrar ratio CEDEAR_ARS / (SPY_USD × MEP) usando positions_history
    const posHistory = await kvGet(env, "positions_history", []);
    let ratioSum = 0, ratioCount = 0;
    for (const day of posHistory) {
      const spy = (day.activos || []).find(a => a.s === "SPY");
      if (!spy?.q || !spy?.v || spy.q <= 0) continue;
      const cedarARS = spy.v / spy.q;
      const spyUSD   = spyUSDByDate[day.date] ?? nearestSpyUSD(spyUSDByDate, day.date);
      const mep      = mepByDate[day.date];
      if (spyUSD && mep) { ratioSum += cedarARS / (spyUSD * mep); ratioCount++; }
    }
    // Si no hay positions, usar depósitos para calibrar
    if (ratioCount === 0) {
      const deposits = await kvGet(env, "deposits", []);
      for (const dep of deposits) {
        if (!dep.spyPrice || !dep.mep) continue;
        const spyUSD = spyUSDByDate[dep.date] ?? nearestSpyUSD(spyUSDByDate, dep.date);
        if (spyUSD) { ratioSum += dep.spyPrice / (spyUSD * dep.mep); ratioCount++; }
      }
    }
    if (ratioCount === 0) throw new Error("No hay datos para calibrar ratio CEDEAR/SPY");

    const ratio     = ratioSum / ratioCount;
    const mepDates  = Object.keys(mepByDate).sort();

    // Generar CEDEAR_ARS = SPY_USD × MEP_interpolado × ratio para cada fecha
    const prices = [];
    for (const [date, spyUSD] of Object.entries(spyUSDByDate)) {
      const mep = mepByDate[date] ?? interpolateMep(mepDates, date, mepByDate);
      if (!mep) continue;
      prices.push({ date, price: Math.round(spyUSD * mep * ratio) });
    }

    console.log(`Yahoo Finance SPY: ${prices.length} precios, ratio=${ratio.toFixed(5)} (${ratioCount} muestras)`);
    return prices.sort((a, b) => a.date.localeCompare(b.date));
  } catch (err) {
    console.warn("Yahoo Finance SPY falló:", err.message);
    return [];
  }
}

/** Precio SPY USD más reciente en o antes de targetDate. */
function nearestSpyUSD(byDate, targetDate) {
  let best = null;
  for (const [d, v] of Object.entries(byDate)) {
    if (d <= targetDate) best = v;
  }
  return best;
}

/** MEP más cercano (antes o después) para fechas sin snapshot. */
function interpolateMep(sortedDates, targetDate, mepByDate) {
  if (!sortedDates.length) return null;
  let before = null;
  for (const d of sortedDates) {
    if (d <= targetDate) before = d;
  }
  return before ? mepByDate[before] : mepByDate[sortedDates[0]];
}

/**
 * Extrae precios históricos de la respuesta de IOL.
 * Tolera distintos formatos: array directo, o envuelto en un campo.
 */
function parseSPYPrices(data) {
  const candidates = [
    data?.instrumentoHistorico,
    data?.historico,
    data?.precios,
    Array.isArray(data) ? data : null,
  ];
  for (const items of candidates) {
    if (!Array.isArray(items) || items.length === 0) continue;
    const prices = items
      .map(p => ({
        date:  (p.fechaHora || p.fecha || "").split("T")[0],
        price: p.cierre || p.ultimoPrecio || p.precio || null,
      }))
      .filter(p => p.date && p.price != null && p.price > 0);
    if (prices.length > 0) return prices;
  }
  return [];
}

/**
 * GET /api/deposits — devuelve la lista de depósitos registrados.
 * POST /api/deposit — Body: { date: "YYYY-MM-DD", amount: number, note?: string }
 * Los depósitos se usan para calcular el rendimiento real sobre capital aportado.
 */
async function handleGetDeposits(request, env) {
  const deposits = await kvGet(env, "deposits", []);
  return jsonResponse(deposits, { origin: request.headers.get("Origin") || "" });
}

async function handleDeposit(request, env) {
  const { date, amount, note, mep } = await request.json();
  if (!date || !amount || amount <= 0) {
    return jsonResponse({ error: "date y amount requeridos" }, { status: 400, origin: request.headers.get("Origin") || "" });
  }
  const deposits = await kvGet(env, "deposits", []);
  const idx = deposits.findIndex(d => d.date === date);
  const entry = { date, amount, note: note || "", mep: mep || null };
  if (idx >= 0) deposits[idx] = entry;
  else deposits.push(entry);
  deposits.sort((a, b) => a.date.localeCompare(b.date));
  await env.TOKEN_CACHE.put("deposits", JSON.stringify(deposits));
  return jsonResponse({ ok: true }, { origin: request.headers.get("Origin") || "" });
}

// ─── Cartera Graciela ─────────────────────────────────────────────────────────

/**
 * Deriva las posiciones actuales de Graciela desde sus operaciones de compra/venta.
 * Devuelve { SIMBOLO: { qty, totalCost, avgCost } }.
 * qty puede quedar negativa si hay ventas sin compra registrada (dato incompleto);
 * los consumidores deben clampear a Math.max(0, qty).
 */
function computeGracielaPositions(ops) {
  const positions = {};
  const sorted = [...ops]
    .filter(o => o.type === "buy" || o.type === "sell")
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const op of sorted) {
    const { symbol, qty, price } = op;
    if (!symbol || qty == null || qty <= 0 || price == null) continue;
    if (!positions[symbol]) positions[symbol] = { qty: 0, totalCost: 0 };
    if (op.type === "buy") {
      positions[symbol].qty       += qty;
      positions[symbol].totalCost += qty * price;
    } else {
      const avgCost = positions[symbol].qty > 0
        ? positions[symbol].totalCost / positions[symbol].qty
        : price;
      positions[symbol].qty       -= qty;
      positions[symbol].totalCost  = Math.max(0, positions[symbol].totalCost - avgCost * qty);
    }
  }
  for (const pos of Object.values(positions)) {
    pos.avgCost = pos.qty > 0 ? pos.totalCost / pos.qty : 0;
  }
  return positions;
}

/**
 * Efectivo de Graciela: depósitos + ingresos por ventas − egresos por compras.
 */
function computeGracielaCash(ops) {
  let cash = 0;
  for (const op of [...ops].sort((a, b) => a.date.localeCompare(b.date))) {
    if      (op.type === "deposit")    cash += op.amount || 0;
    else if (op.type === "withdrawal") cash -= op.amount || 0;
    else if (op.type === "buy")        cash -= (op.qty || 0) * (op.price || 0);
    else if (op.type === "sell")       cash += (op.qty || 0) * (op.price || 0);
  }
  return cash;
}

/**
 * Divide los activos del portafolio IOL en { graciela, pignus }.
 * Para cada símbolo la cantidad de Graciela se clampea a [0, iol_qty].
 * El costo promedio de Pignus se deduce del costo total IOL menos el de Graciela.
 */
function splitPortfolioActivos(iolPortfolio, gracielaPositions) {
  const gracielaActivos = [];
  const pignusActivos   = [];
  for (const activo of (iolPortfolio?.activos || [])) {
    const symbol    = activo.titulo?.simbolo || activo.simbolo || "";
    const iolQty    = activo.cantidad   || 0;
    const iolValue  = activo.valorizado || 0;
    const unitPrice = iolQty > 0 ? iolValue / iolQty : 0;
    const graPos    = gracielaPositions[symbol];
    const graQty    = graPos ? Math.max(0, Math.min(graPos.qty, iolQty)) : 0;
    const graAvgCost = graPos?.avgCost || 0;
    const graValue  = graQty * unitPrice;
    const graCost   = graQty * graAvgCost;
    const graGain   = graValue - graCost;
    const graGainPct = graAvgCost > 0 ? ((unitPrice / graAvgCost) - 1) * 100 : 0;
    const pigQty    = iolQty - graQty;
    const pigValue  = iolValue - graValue;
    const iolTotalCost = (activo.ppc || 0) * iolQty;
    const pigCost   = Math.max(0, iolTotalCost - graCost);
    const pigPpc    = pigQty > 0 ? pigCost / pigQty : (activo.ppc || 0);
    const pigGain   = (activo.gananciaDinero || 0) - graGain;
    const pigGainPct = pigCost > 0 ? (pigGain / pigCost) * 100 : 0;
    if (graQty > 0) {
      gracielaActivos.push({
        ...activo,
        cantidad: graQty, valorizado: graValue, ppc: graAvgCost,
        gananciaDinero: graGain, gananciaPorcentaje: graGainPct,
      });
    }
    if (pigQty > 0) {
      pignusActivos.push({
        ...activo,
        cantidad: pigQty, valorizado: pigValue, ppc: pigPpc,
        gananciaDinero: pigGain, gananciaPorcentaje: pigGainPct,
      });
    }
  }
  return { graciela: gracielaActivos, pignus: pignusActivos };
}

/**
 * Divide el efectivo disponible de la cuenta IOL entre Graciela y Pignus.
 * El `total` de la cuenta lo corrige el frontend sumando activos + disponible.
 */
function splitAccountCash(iolAccount, gracielaCash) {
  const cuentas    = iolAccount?.cuentas || [];
  const pesoCuenta = cuentas.find(c => c.moneda === "peso_Argentino") || cuentas[0];
  const totalDisp  = pesoCuenta?.disponible || 0;
  // Pignus is fully invested with no idle cash. If Graciela has positive
  // computed cash she gets the full account balance; otherwise Pignus gets it.
  const graDisp = gracielaCash > 0 ? totalDisp : 0;
  const pigDisp = totalDisp - graDisp;
  const withDisp   = (disp) => ({
    ...iolAccount,
    cuentas: cuentas.map(c => c !== pesoCuenta ? c : { ...c, disponible: disp }),
  });
  return { graciela: withDisp(graDisp), pignus: withDisp(pigDisp) };
}

/**
 * GET /api/history?portfolio=pignus
 * Reconstruye el historial de Pignus restando la porción de Graciela de cada
 * snapshot combinado. Para fechas anteriores a las operaciones de Graciela,
 * Pignus = combinado (Graciela aún no tenía posiciones).
 */
async function handlePignusHistory(request, env) {
  const [ops, posHistory, portfolioHistory, spyPrices, deposits] = await Promise.all([
    kvGet(env, "graciela_operations", []),
    kvGet(env, "positions_history",   []),
    kvGet(env, "portfolio_history",   []),
    getSPYHistory(env),
    kvGet(env, "deposits",            []),
  ]);

  const posHistoryByDate = {};
  for (const p of posHistory) posHistoryByDate[p.date] = p;

  const gracielaDepositDates = new Set(
    ops.filter(op => op.type === "deposit" || op.type === "withdrawal").map(op => op.date)
  );
  const pignusDeposits = deposits.filter(d => !gracielaDepositDates.has(d.date));

  const spyByDate = {};
  for (const p of spyPrices) spyByDate[p.date] = p.price;
  const mepByDate = {};
  for (const s of portfolioHistory) { if (s.mep) mepByDate[s.date] = s.mep; }
  for (const dep of pignusDeposits) {
    const freshSpy = spyByDate[dep.date] || nearestSpyPrice(spyPrices, dep.date);
    if (freshSpy) dep.spyPrice = freshSpy;
    if (!dep.mep) dep.mep = mepByDate[dep.date] || null;
  }

  const sortedOps = [...ops].sort((a, b) => a.date.localeCompare(b.date));
  const snapshots = [];

  for (const combined of portfolioHistory) {
    const { date } = combined;
    const dayPos = posHistoryByDate[date];
    let gracielaTotalARS = 0, gracielaTotalGanancia = 0;
    if (dayPos) {
      const opsToDate = sortedOps.filter(op => op.date <= date);
      const holdings  = computeGracielaPositions(opsToDate);
      const unitPrice = {};
      for (const a of (dayPos.activos || [])) { if (a.q > 0) unitPrice[a.s] = a.v / a.q; }
      for (const [symbol, pos] of Object.entries(holdings)) {
        const qty = Math.max(0, pos.qty);
        if (qty === 0 || !unitPrice[symbol]) continue;
        const value = qty * unitPrice[symbol];
        gracielaTotalARS      += value;
        gracielaTotalGanancia += value - qty * pos.avgCost;
      }
      gracielaTotalARS += Math.max(0, computeGracielaCash(opsToDate));
    }
    snapshots.push({
      date,
      totalARS:      Math.round(Math.max(0, combined.totalARS - gracielaTotalARS)),
      totalGanancia: Math.round((combined.totalGanancia || 0) - gracielaTotalGanancia),
      mep:   combined.mep   || null,
      mpVcp: combined.mpVcp || null,
    });
  }

  snapshots.sort((a, b) => a.date.localeCompare(b.date));
  return jsonResponse({ snapshots, spyPrices, deposits: pignusDeposits }, { origin: request.headers.get("Origin") || "" });
}

/**
 * GET /api/history?portfolio=graciela
 * Reconstruye el historial de Graciela combinando sus operaciones con
 * los precios históricos almacenados en positions_history.
 */
async function handleGracielaHistory(request, env) {
  const [ops, posHistory, portfolioHistory, spyPrices] = await Promise.all([
    kvGet(env, "graciela_operations", []),
    kvGet(env, "positions_history",   []),
    kvGet(env, "portfolio_history",   []),
    getSPYHistory(env),
  ]);

  const mepByDate   = {};
  const mpVcpByDate = {};
  for (const s of portfolioHistory) {
    if (s.mep)   mepByDate[s.date]   = s.mep;
    if (s.mpVcp) mpVcpByDate[s.date] = s.mpVcp;
  }

  // Depósitos / retiros de Graciela para el benchmark
  const deposits = ops
    .filter(op => op.type === "deposit" || op.type === "withdrawal")
    .map(op => ({
      date:     op.date,
      amount:   op.type === "withdrawal" ? -(op.amount || 0) : (op.amount || 0),
      note:     op.note || (op.type === "deposit" ? "Depósito Graciela" : "Retiro Graciela"),
      auto:     false,
      mep:      mepByDate[op.date]   || null,
      mpVcp:    mpVcpByDate[op.date] || null,
      spyPrice: nearestSpyPrice(spyPrices, op.date),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Un snapshot por cada entrada en positions_history
  const sortedOps = [...ops].sort((a, b) => a.date.localeCompare(b.date));
  const snapshots = [];
  for (const dayPos of posHistory) {
    const { date, activos } = dayPos;
    const opsToDate  = sortedOps.filter(op => op.date <= date);
    const holdings   = computeGracielaPositions(opsToDate);
    const unitPriceMap = {};
    for (const a of (activos || [])) {
      if (a.q > 0) unitPriceMap[a.s] = a.v / a.q;
    }
    let totalARS = 0, totalGanancia = 0;
    for (const [symbol, pos] of Object.entries(holdings)) {
      const qty = Math.max(0, pos.qty);
      if (qty === 0 || !unitPriceMap[symbol]) continue;
      const value = qty * unitPriceMap[symbol];
      totalARS      += value;
      totalGanancia += value - qty * pos.avgCost;
    }
    totalARS += Math.max(0, computeGracielaCash(opsToDate));
    if (totalARS > 0) {
      snapshots.push({
        date,
        totalARS:      Math.round(totalARS),
        totalGanancia: Math.round(totalGanancia),
        mep:   mepByDate[date]   || null,
        mpVcp: mpVcpByDate[date] || null,
      });
    }
  }
  snapshots.sort((a, b) => a.date.localeCompare(b.date));
  return jsonResponse({ snapshots, spyPrices, deposits }, { origin: request.headers.get("Origin") || "" });
}

/** GET /api/graciela/operations */
async function handleGetGracielaOps(request, env) {
  const ops = await kvGet(env, "graciela_operations", []);
  return jsonResponse(ops, { origin: request.headers.get("Origin") || "" });
}

/** POST /api/graciela/operations — agrega una operación */
async function handleAddGracielaOp(request, env) {
  const op = await request.json();
  if (!op.date || !op.type) {
    return jsonResponse({ error: "date y type requeridos" }, { status: 400, origin: request.headers.get("Origin") || "" });
  }
  const ops = await kvGet(env, "graciela_operations", []);
  op.id = crypto.randomUUID();
  ops.push(op);
  ops.sort((a, b) => a.date.localeCompare(b.date));
  await env.TOKEN_CACHE.put("graciela_operations", JSON.stringify(ops));
  return jsonResponse({ ok: true, id: op.id }, { origin: request.headers.get("Origin") || "" });
}

/** DELETE /api/graciela/operations/:id */
async function handleDeleteGracielaOp(request, env, id) {
  const ops = await kvGet(env, "graciela_operations", []);
  await env.TOKEN_CACHE.put("graciela_operations", JSON.stringify(ops.filter(op => op.id !== id)));
  return jsonResponse({ ok: true }, { origin: request.headers.get("Origin") || "" });
}

/** PUT /api/graciela/operations/import — reemplaza todo el listado */
async function handleImportGracielaOps(request, env) {
  const ops = await request.json();
  if (!Array.isArray(ops)) {
    return jsonResponse({ error: "Array esperado" }, { status: 400, origin: request.headers.get("Origin") || "" });
  }
  for (const op of ops) if (!op.id) op.id = crypto.randomUUID();
  ops.sort((a, b) => a.date.localeCompare(b.date));
  await env.TOKEN_CACHE.put("graciela_operations", JSON.stringify(ops));
  return jsonResponse({ ok: true, count: ops.length }, { origin: request.headers.get("Origin") || "" });
}

// ─── Informes ─────────────────────────────────────────────────────────────────

/**
 * GET /api/report-data?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Devuelve todos los datos numéricos necesarios para generar el informe del período.
 */
async function handleReportData(request, env) {
  const url  = new URL(request.url);
  const from = url.searchParams.get("from");
  const to   = url.searchParams.get("to");
  if (!from || !to) {
    return jsonResponse({ error: "from y to requeridos" }, { status: 400, origin: request.headers.get("Origin") || "" });
  }

  const [snapshots, deposits, posHistory, spyPrices] = await Promise.all([
    kvGet(env, "portfolio_history", []),
    kvGet(env, "deposits", []),
    kvGet(env, "positions_history", []),
    getSPYHistory(env),
  ]);

  // SPY por fecha
  const spyByDate = {};
  for (const p of spyPrices) spyByDate[p.date] = p.price;

  // Snapshot más reciente antes del inicio del período → valor inicial
  const startSnap = [...snapshots]
    .filter(s => s.date < from)
    .sort((a, b) => b.date.localeCompare(a.date))[0] || null;
  const startValue  = startSnap?.totalARS  ?? 0;
  const startMpVcp  = startSnap?.mpVcp     ?? null;
  const startSpyPx  = nearestSpyPrice(spyPrices, startSnap?.date ?? from);

  // Snapshot más reciente hasta el fin del período → valor final
  const endSnap = [...snapshots]
    .filter(s => s.date <= to)
    .sort((a, b) => b.date.localeCompare(a.date))[0] || null;
  const endValue    = endSnap?.totalARS ?? 0;
  const endMpVcp    = endSnap?.mpVcp    ?? null;
  const endSpyPx    = nearestSpyPrice(spyPrices, endSnap?.date ?? to);

  // Depósitos del período (fecha > inicio del período, fecha ≤ fin)
  const periodDeps      = deposits.filter(d => d.date > from && d.date <= to);
  const periodDepsTotal = periodDeps.reduce((s, d) => s + d.amount, 0);

  // Rendimiento del período
  const netGain    = endValue - startValue - periodDepsTotal;
  const returnBase = startValue + periodDepsTotal;
  const returnPct  = returnBase > 0 ? (netGain / returnBase) * 100 : 0;

  // Rendimiento acumulado total (desde el primer depósito hasta `to`)
  const allDepsToDate  = deposits.filter(d => d.date <= to);
  const totalCapital   = allDepsToDate.reduce((s, d) => s + d.amount, 0);
  const totalGain      = endValue - totalCapital;
  const totalReturnPct = totalCapital > 0 ? (totalGain / totalCapital) * 100 : 0;
  const inceptionDate  = allDepsToDate[0]?.date ?? from;

  // Benchmarks
  const spyReturnPct = startSpyPx && endSpyPx
    ? ((endSpyPx - startSpyPx) / startSpyPx) * 100
    : null;
  const mpReturnPct = startMpVcp && endMpVcp
    ? ((endMpVcp - startMpVcp) / startMpVcp) * 100
    : null;

  // Posiciones al cierre del período
  const latestPos = [...posHistory]
    .filter(p => p.date <= to)
    .sort((a, b) => b.date.localeCompare(a.date))[0]?.activos || [];

  const positions = latestPos.map(p => ({
    symbol:  p.s,
    type:    p.t,
    qty:     p.q,
    ppc:     p.ppc,
    value:   p.v,
    gain:    p.g,
    gainPct: p.gp,
    sector:  SECTOR_MAP[p.s] || "Otros",
  })).sort((a, b) => b.value - a.value);

  // Asignación por sector
  const totalPositionsValue = positions.reduce((s, p) => s + p.value, 0);
  const sectorTotals = {};
  for (const p of positions) {
    sectorTotals[p.sector] = (sectorTotals[p.sector] || 0) + p.value;
  }
  const allocation = Object.entries(sectorTotals)
    .map(([sector, value]) => ({
      sector,
      value,
      pct: totalPositionsValue > 0 ? (value / totalPositionsValue) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value);

  // Historial para el gráfico (desde inception hasta to)
  const history = snapshots
    .filter(s => s.date >= inceptionDate && s.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));

  // Precios SPY para el gráfico (mismo rango)
  const spyHistory = spyPrices
    .filter(p => p.date >= inceptionDate && p.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));

  // Depósitos para marcadores en el gráfico
  const depositsForChart = deposits.filter(d => d.date >= inceptionDate && d.date <= to);

  return jsonResponse({
    period: { from, to },
    account: {
      startValue,
      endValue,
      deposits:        periodDepsTotal,
      depositsDetail:  periodDeps,
      withdrawals:     0,
      netGain,
      returnPct,
      totalReturnPct,
      totalGain,
      totalCapital,
      inceptionDate,
    },
    benchmarks: {
      spy: { startPrice: startSpyPx, endPrice: endSpyPx, returnPct: spyReturnPct },
      mp:  { startVcp:   startMpVcp, endVcp:   endMpVcp, returnPct: mpReturnPct  },
    },
    positions,
    allocation,
    history,
    spyHistory,
    deposits: depositsForChart,
  }, { origin: request.headers.get("Origin") || "" });
}

/** GET /api/reports — lista los informes generados (metadatos). */
async function handleGetReports(request, env) {
  const reports = await kvGet(env, "reports_list", []);
  return jsonResponse(reports, { origin: request.headers.get("Origin") || "" });
}

/** POST /api/reports — guarda metadatos de un informe recién generado. */
async function handleSaveReport(request, env) {
  const { from, to, label } = await request.json();
  if (!from || !to) {
    return jsonResponse({ error: "from y to requeridos" }, { status: 400, origin: request.headers.get("Origin") || "" });
  }
  const reports = await kvGet(env, "reports_list", []);
  const entry = {
    id:          Date.now().toString(),
    generatedAt: new Date().toISOString(),
    from,
    to,
    label:       label || formatPeriodLabel(from, to),
  };
  reports.unshift(entry);
  await env.TOKEN_CACHE.put("reports_list", JSON.stringify(reports));
  return jsonResponse({ ok: true, id: entry.id }, { origin: request.headers.get("Origin") || "" });
}

/** Genera una etiqueta legible para un rango de fechas, ej: "Marzo 2026" o "Mar–Abr 2026" */
function formatPeriodLabel(from, to) {
  const MONTHS = ["Enero","Febrero","Marzo","Abril","Mayo","Junio",
                  "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  const f = new Date(from + "T12:00:00Z");
  const t = new Date(to   + "T12:00:00Z");
  if (f.getUTCMonth() === t.getUTCMonth() && f.getUTCFullYear() === t.getUTCFullYear()) {
    return `${MONTHS[f.getUTCMonth()]} ${f.getUTCFullYear()}`;
  }
  return `${MONTHS[f.getUTCMonth()]}–${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

/**
 * Obtiene el VCP de "Mercado Fondo - Clase A" para una fecha dada.
 * Fuente: api.argentinadatos.com (sin auth, datos de CAFCI).
 * Devuelve null si no hay datos para esa fecha (feriados, weekends).
 */
async function fetchMercadoFondoVCP(date) {
  try {
    const [year, month, day] = date.split("-");
    const response = await fetch(
      `https://api.argentinadatos.com/v1/finanzas/fci/mercadoDinero/${year}/${month}/${day}`
    );
    if (!response.ok) return null;
    const data  = await response.json();
    const entry = (Array.isArray(data) ? data : [])
      .find(d => d.fondo === "Mercado Fondo - Clase A");
    return entry?.vcp || null;
  } catch {
    return null;
  }
}

function getReporterEmail(request) {
  const header = request.headers.get('CF-Access-Authenticated-User-Email');
  if (header) return header;
  const jwt = request.headers.get('CF-Access-Jwt-Assertion');
  if (!jwt) return 'unknown';
  try {
    let b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - b64.length % 4) % 4);
    return JSON.parse(atob(b64)).email ?? 'unknown';
  } catch { return 'unknown'; }
}

async function sendFeedbackEmail(apiKey, { to, subject, html }) {
  if (!apiKey || !to || to === "unknown" || !to.includes("@")) return;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Pignus <noreply@pignuslabs.com.ar>", to, subject, html }),
    });
    if (!res.ok) console.error(`[email] Resend error ${res.status}`);
  } catch (err) {
    console.error("[email] Failed:", err.message);
  }
}

function buildReceivedHtml({ type, screen, tried, expected, happened, impact, proposed_change, justification }) {
  const esc = (s) => s ? String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : "";
  const row = (label, val) => val ? `<tr><td style="padding:8px 0;border-bottom:1px solid #e8e2d9;font-size:13px;color:#6b7280;width:150px;vertical-align:top">${label}</td><td style="padding:8px 0;border-bottom:1px solid #e8e2d9;font-size:13px;color:#1c1814;white-space:pre-wrap">${esc(val)}</td></tr>` : "";
  const typeLabel = type === "bug" ? "Problema" : "Mejora";
  const detailRows = type === "bug"
    ? row("¿Qué intentaste?", tried) + row("¿Qué esperabas?", expected) + row("¿Qué pasó?", happened) + row("Impacto", impact)
    : row("Cambio propuesto", proposed_change) + row("Justificación", justification);
  const tableRows = row("Tipo", typeLabel) + row("Pantalla", screen) + detailRows;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f5f0e8;font-family:Georgia,serif;color:#1c1814;"><table style="max-width:600px;margin:32px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);" cellpadding="0" cellspacing="0" width="100%"><tr><td style="background:#1c1814;padding:24px 32px;"><p style="margin:0;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#a89880;">Pignus Inversiones</p><h1 style="margin:4px 0 0;font-size:22px;font-weight:500;color:#f5f0e8;">Reporte recibido</h1></td></tr><tr><td style="padding:24px 32px;"><p style="margin:0 0 16px;font-size:15px;">Tu reporte fue recibido y será revisado próximamente.</p><table cellpadding="0" cellspacing="0" width="100%">${tableRows}</table></td></tr><tr><td style="padding:0 32px 32px;"><a href="https://inversiones.pignuslabs.com.ar" style="display:inline-block;background:#1BBFA1;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:13px;font-family:sans-serif;font-weight:600;">Abrir Inversiones</a></td></tr><tr><td style="padding:16px 32px;background:#f5f0e8;border-top:1px solid #e8e2d9;"><p style="margin:0;font-size:11px;color:#9ca3af;font-family:sans-serif;">Este correo fue enviado automáticamente en respuesta a tu reporte.</p></td></tr></table></body></html>`;
}

/** Lee una clave de KV, devuelve fallback si no existe. */
async function handleFeedback(request, env, origin) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "INVALID_JSON" }, { status: 400, origin }); }

  const { type, screen, tried, expected, happened, impact, proposed_change, justification } = body;
  const reportedBy = getReporterEmail(request);

  if (type !== "bug" && type !== "feature_request") {
    return jsonResponse({ error: "VALIDATION_ERROR", message: "type must be bug or feature_request" }, { status: 400, origin });
  }
  if (type === "bug") {
    if (!tried?.trim() || !expected?.trim() || !happened?.trim()) {
      return jsonResponse({ error: "VALIDATION_ERROR", message: "tried, expected and happened are required" }, { status: 400, origin });
    }
  } else {
    if (!proposed_change?.trim() || !justification?.trim()) {
      return jsonResponse({ error: "VALIDATION_ERROR", message: "proposed_change and justification are required" }, { status: 400, origin });
    }
  }

  const id  = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.TOKEN_CACHE.put(
    `feedback:${id}`,
    JSON.stringify({ id, type, screen: screen ?? null, tried: tried ?? null, expected: expected ?? null, happened: happened ?? null, impact: impact ?? null, proposed_change: proposed_change ?? null, justification: justification ?? null, reported_by: reportedBy, app: "inversiones", created_at: now }),
  );

  await sendFeedbackEmail(env.RESEND_API_KEY, {
    to: reportedBy,
    subject: "Reporte recibido — Pignus Inversiones",
    html: buildReceivedHtml({ type, screen, tried, expected, happened, impact, proposed_change, justification }),
  });

  return jsonResponse({ ok: true }, { origin });
}

async function kvGet(env, key, fallback) {
  const val = await env.TOKEN_CACHE.get(key, { type: "json" });
  return val ?? fallback;
}

// ─── Gestión del token IOL con KV ──────────────────────────────────────────────

/**
 * Devuelve un access_token válido de IOL.
 *
 * Estrategia (en orden):
 *   1. Lee el token cacheado en KV.
 *   2. Si sigue vigente (no vence en menos de TOKEN_REFRESH_MARGIN_SEC):
 *      → lo devuelve directamente (camino rápido, sin llamar a IOL).
 *   3. Si tiene refresh_token y el token está próximo a vencer:
 *      → lo renueva con el endpoint de refresh.
 *   4. Si no hay nada cacheado o el refresh falló:
 *      → autentica desde cero con usuario/contraseña.
 */
async function getValidToken(env) {
  // Leer lo que hay en KV (puede ser null si es la primera vez)
  const cached = await env.TOKEN_CACHE.get("iol_token", { type: "json" });

  const nowSec = Date.now() / 1000;

  // ¿Tenemos token y todavía le queda tiempo?
  if (cached && cached.expires_at > nowSec + TOKEN_REFRESH_MARGIN_SEC) {
    return cached.access_token;
  }

  // ¿Podemos usar el refresh_token?
  if (cached && cached.refresh_token) {
    try {
      return await refreshToken(env, cached.refresh_token);
    } catch (err) {
      // El refresh_token puede expirar o quedar inválido.
      // Si falla, caemos a la autenticación completa.
      console.warn("Refresh token failed, re-authenticating:", err.message);
    }
  }

  // Autenticación completa con usuario y contraseña
  return await authenticateFresh(env);
}

/**
 * Autentica con usuario y contraseña. Guarda el resultado en KV.
 * Solo se llama cuando no hay token cacheado o el refresh falló.
 */
async function authenticateFresh(env) {
  const response = await fetch(`${IOL_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: env.IOL_USERNAME,
      password: env.IOL_PASSWORD,
      grant_type: "password",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`IOL auth failed (${response.status}): ${text}`);
  }

  const tokens = await response.json();
  await saveTokenToKV(env, tokens);
  return tokens.access_token;
}

/**
 * Renueva el token usando el refresh_token (sin pedir usuario/contraseña).
 * IOL acepta grant_type=refresh_token en el mismo endpoint /token.
 */
async function refreshToken(env, refreshTokenValue) {
  const response = await fetch(`${IOL_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshTokenValue,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    throw new Error(`Refresh failed (${response.status})`);
  }

  const tokens = await response.json();
  await saveTokenToKV(env, tokens);
  return tokens.access_token;
}

/**
 * Guarda el token en KV con un TTL de 24 horas.
 * Guardamos también el refresh_token y el timestamp de expiración
 * para poder renovar sin re-autenticar.
 *
 * @param {object} tokens — respuesta JSON de IOL con access_token, refresh_token, expires_in
 */
async function saveTokenToKV(env, tokens) {
  const nowSec = Date.now() / 1000;
  const payload = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    // expires_in está en segundos. Calculamos el timestamp absoluto de expiración.
    expires_at: nowSec + (tokens.expires_in || 1200),
  };

  // TTL de 24h en KV para que el entry se limpie automáticamente.
  // El control de expiración real lo hacemos nosotros con expires_at.
  await env.TOKEN_CACHE.put("iol_token", JSON.stringify(payload), {
    expirationTtl: 86400,
  });
}

// ─── Helpers de HTTP ───────────────────────────────────────────────────────────

/**
 * Hace un GET autenticado a la API de IOL.
 * @param {string} endpoint — path relativo, ej: "/api/v2/portafolio/argentina"
 * @param {string} token    — access_token válido
 */
async function iolGet(endpoint, token, env, retried = false) {
  const response = await fetch(`${IOL_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // Si IOL devuelve 401, el token cacheado quedó inválido (sesión cerrada, rotación, etc.).
  // Limpiamos el KV y reintentamos una sola vez con credenciales frescas.
  if (response.status === 401 && !retried) {
    console.warn("Token rechazado por IOL (401), re-autenticando...");
    await env.TOKEN_CACHE.delete("iol_token");
    const freshToken = await authenticateFresh(env);
    return iolGet(endpoint, freshToken, env, true);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`IOL API error ${response.status} en ${endpoint}: ${text}`);
  }

  return response.json();
}

/**
 * Crea una Response JSON con los headers de CORS correctos.
 * @param {object} data        — objeto a serializar como JSON
 * @param {object} options
 * @param {number} options.status  — código HTTP (default 200)
 * @param {string} options.origin  — valor del header Access-Control-Allow-Origin
 */
function jsonResponse(data, { status = 200, origin = "*" } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      "Access-Control-Allow-Origin": origin || "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Responde a un CORS preflight (OPTIONS) con los headers necesarios.
 * El navegador envía este request antes de un fetch cross-origin para verificar
 * que el servidor acepta requests desde ese origen.
 */
function corsPreflightResponse(allowedOrigin) {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": allowedOrigin || "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

/*
 * NOTA — Cálculo alternativo del dólar MEP:
 * ─────────────────────────────────────────
 * Una alternativa más precisa para el tipo de cambio MEP es tomar el precio
 * del bono AL30 en pesos (mercado BCBA) y dividirlo por el precio del AL30D
 * en dólares (también BCBA). Ambos están disponibles en la API de IOL via el
 * endpoint de cotizaciones:
 *   GET /api/v2/cotizaciones/titulos/bCBA/AL30
 *   GET /api/v2/cotizaciones/titulos/bCBA/AL30D
 *
 * MEP_implicito = precio_AL30_ARS / precio_AL30D_USD
 *
 * Esto elimina la dependencia de dolarapi.com y da el MEP real tal como lo
 * liquida el mercado. Implementación futura.
 */
