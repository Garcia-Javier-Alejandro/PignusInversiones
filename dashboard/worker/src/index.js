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
 *   ALLOWED_ORIGIN  — URL exacta del frontend (ej: https://pignus.pages.dev)
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
    if (request.method === "OPTIONS") {
      return corsPreflightResponse(env.ALLOWED_ORIGIN);
    }

    // ── Verificar origen ────────────────────────────────────────────────────────
    // Solo aceptamos requests del frontend autorizado. Esto evita que terceros
    // usen nuestro Worker como proxy gratuito hacia IOL.
    const origin = request.headers.get("Origin") || "";
    if (env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) {
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
      return new Response("Not found", { status: 404 });
    } catch (err) {
      // Si algo falla (IOL caído, token inválido, etc.), devolvemos el error
      // en formato JSON para que el frontend lo pueda mostrar.
      console.error("Worker error:", err.message);
      return jsonResponse(
        { error: err.message },
        { status: 502, origin: env.ALLOWED_ORIGIN }
      );
    }
  },
};

// ─── Handlers de endpoints ─────────────────────────────────────────────────────

/**
 * GET /api/portfolio
 * Proxy a GET /api/v2/portafolio/argentina de IOL.
 * Devuelve el portafolio completo con todas las posiciones valorizadas.
 */
async function handlePortfolio(request, env) {
  const token = await getValidToken(env);
  const data = await iolGet("/api/v2/portafolio/argentina", token, env);
  return jsonResponse(data, { origin: env.ALLOWED_ORIGIN });
}

/**
 * GET /api/account
 * Proxy a GET /api/v2/estadocuenta de IOL.
 * Devuelve el estado de cuenta con el saldo disponible en pesos.
 */
async function handleAccount(request, env) {
  const token = await getValidToken(env);
  const data = await iolGet("/api/v2/estadocuenta", token, env);
  return jsonResponse(data, { origin: env.ALLOWED_ORIGIN });
}

// ─── Historial y benchmarks ───────────────────────────────────────────────────

/**
 * GET /api/history
 * Devuelve snapshots de la cartera y precios históricos de SPY.
 * Cada snapshot ya incluye mpVcp (Valor Cuota Patrimonial de Mercado Fondo - Clase A).
 * Si algún snapshot no tiene VCP (guardado antes de esta feature), lo backfilla y persiste.
 */
async function handleHistory(request, env) {
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

  // Backfill mep en snapshots que no lo tengan (p.ej. guardados fuera de horario de mercado).
  // Usa el valor cacheado más reciente como aproximación razonable.
  const mepCache = await kvGet(env, "mep_cache", null);
  if (mepCache?.mep) {
    for (const snap of snapshots) {
      if (snap.mep == null) {
        snap.mep = mepCache.mep;
        snapshotsChanged = true;
      }
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

  // Backfill mpVcp y spyPrice en depósitos que los necesiten
  let depositsChanged = inferred.length > 0;
  for (const dep of deposits) {
    if (dep.mpVcp == null) {
      dep.mpVcp = await fetchMercadoFondoVCP(dep.date);
      if (dep.mpVcp) depositsChanged = true;
    }
    if (dep.spyPrice == null) {
      const price = spyByDate[dep.date] || nearestSpyPrice(spyPrices, dep.date);
      if (price) { dep.spyPrice = price; depositsChanged = true; }
    }
  }
  if (depositsChanged) {
    await env.TOKEN_CACHE.put("deposits", JSON.stringify(deposits));
  }

  return jsonResponse({ snapshots, spyPrices, deposits }, { origin: env.ALLOWED_ORIGIN });
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

/**
 * POST /api/snapshot
 * Body: { totalARS, mep, totalGanancia, activos }
 * El frontend llama a esto cada vez que carga datos válidos (una vez por día).
 * Guarda el resumen del día en portfolio_history y las posiciones compactas en positions_history.
 */
async function handleSnapshot(request, env) {
  const { totalARS, mep, totalGanancia, activos } = await request.json();
  if (!totalARS || totalARS <= 0) {
    return jsonResponse({ error: "Invalid data" }, { status: 400, origin: env.ALLOWED_ORIGIN });
  }

  // Fecha en zona horaria de Argentina (UTC-3, sin DST). Usar UTC causaría que a las
  // 23:xx ARG el snapshot quede fechado al día siguiente.
  const today   = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Argentina/Buenos_Aires" });
  const history = await kvGet(env, "portfolio_history", []);

  if (history.some(s => s.date === today)) {
    return jsonResponse({ ok: true, skipped: true }, { origin: env.ALLOWED_ORIGIN });
  }

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

  return jsonResponse({ ok: true }, { origin: env.ALLOWED_ORIGIN });
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
  return jsonResponse(positions, { origin: env.ALLOWED_ORIGIN });
}

/**
 * GET /api/mep
 * Calcula el dólar MEP implícito como precio_AL30_ARS / precio_AL30D_USD.
 * AL30 y AL30D son el mismo bono soberano en distintas series de liquidación;
 * el cociente de precios da el tipo de cambio de mercado sin depender de
 * fuentes externas (solo IOL).
 * Caché KV de 15 minutos para no saturar el endpoint de cotizaciones.
 */
async function handleMEP(request, env) {
  const cached = await kvGet(env, "mep_cache", null);
  if (cached && (Date.now() - cached.fetchedAt) < 15 * 60_000) {
    return jsonResponse(cached, { origin: env.ALLOWED_ORIGIN });
  }

  // Fuera del horario de mercado (~17:00-11:00 ARG), IOL puede devolver precios cero
  // o el endpoint puede fallar. En ese caso devolvemos la caché aunque haya vencido
  // (stale: true) para que el frontend siempre tenga un MEP disponible.
  try {
    const token = await getValidToken(env);
    const [al30, al30d] = await Promise.all([
      iolGet("/api/v2/cotizaciones/titulos/bCBA/AL30",  token, env),
      iolGet("/api/v2/cotizaciones/titulos/bCBA/AL30D", token, env),
    ]);

    const precioARS = al30.ultimoPrecio  ?? al30.precio;
    const precioUSD = al30d.ultimoPrecio ?? al30d.precio;

    if (!precioARS || !precioUSD || precioUSD === 0) {
      // Precios fuera de horario — devolver caché anterior si existe
      if (cached) return jsonResponse({ ...cached, stale: true }, { origin: env.ALLOWED_ORIGIN });
      return jsonResponse({ error: "Precio AL30/AL30D no disponible" }, { status: 502, origin: env.ALLOWED_ORIGIN });
    }

    const result = {
      mep:       precioARS / precioUSD,
      al30Ars:   precioARS,
      al30dUsd:  precioUSD,
      fetchedAt: Date.now(),
    };
    await env.TOKEN_CACHE.put("mep_cache", JSON.stringify(result));
    return jsonResponse(result, { origin: env.ALLOWED_ORIGIN });

  } catch (err) {
    // IOL caído o error de red — devolver caché aunque esté vencida
    if (cached) return jsonResponse({ ...cached, stale: true }, { origin: env.ALLOWED_ORIGIN });
    return jsonResponse({ error: err.message }, { status: 502, origin: env.ALLOWED_ORIGIN });
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
    return jsonResponse({ error: "Invalid rate" }, { status: 400, origin: env.ALLOWED_ORIGIN });
  }

  const today = new Date().toISOString().split("T")[0];
  const rates = await kvGet(env, "mp_rates", []);
  const idx   = rates.findIndex(r => r.date === today);
  if (idx >= 0) rates[idx].dailyPct = dailyPct;
  else rates.push({ date: today, dailyPct });

  await env.TOKEN_CACHE.put("mp_rates", JSON.stringify(rates));
  return jsonResponse({ ok: true }, { origin: env.ALLOWED_ORIGIN });
}

/**
 * Obtiene precios históricos del CEDEAR SPY.BA desde Yahoo Finance (sin auth).
 * Caché de 24h en KV. Devuelve array de { date: "YYYY-MM-DD", price: number }.
 * Usa adjclose (precio ajustado por splits/dividendos).
 */
async function getSPYHistory(env) {
  const cached = await kvGet(env, "spy_history_cache_yf", null);
  if (cached && (Date.now() - cached.fetchedAt) < 86_400_000) {
    return cached.prices;
  }

  try {
    const response = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/SPY.BA?interval=1d&range=1y",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!response.ok) throw new Error(`Yahoo Finance ${response.status}`);

    const json   = await response.json();
    const result = json.chart?.result?.[0];
    if (!result) throw new Error("Yahoo Finance: sin datos");

    const timestamps = result.timestamp || [];
    const closes     = result.indicators?.adjclose?.[0]?.adjclose
                    || result.indicators?.quote?.[0]?.close
                    || [];

    const prices = timestamps
      .map((ts, i) => ({
        date:  new Date(ts * 1000).toISOString().split("T")[0],
        price: closes[i],
      }))
      .filter(p => p.date && p.price != null && p.price > 0);

    await env.TOKEN_CACHE.put("spy_history_cache_yf", JSON.stringify({ fetchedAt: Date.now(), prices }));
    return prices;
  } catch (err) {
    console.warn("No se pudo obtener historial SPY desde Yahoo Finance:", err.message);
    return cached?.prices || [];
  }
}

/**
 * GET /api/deposits — devuelve la lista de depósitos registrados.
 * POST /api/deposit — Body: { date: "YYYY-MM-DD", amount: number, note?: string }
 * Los depósitos se usan para calcular el rendimiento real sobre capital aportado.
 */
async function handleGetDeposits(request, env) {
  const deposits = await kvGet(env, "deposits", []);
  return jsonResponse(deposits, { origin: env.ALLOWED_ORIGIN });
}

async function handleDeposit(request, env) {
  const { date, amount, note } = await request.json();
  if (!date || !amount || amount <= 0) {
    return jsonResponse({ error: "date y amount requeridos" }, { status: 400, origin: env.ALLOWED_ORIGIN });
  }
  const deposits = await kvGet(env, "deposits", []);
  const idx = deposits.findIndex(d => d.date === date);
  const entry = { date, amount, note: note || "" };
  if (idx >= 0) deposits[idx] = entry;
  else deposits.push(entry);
  deposits.sort((a, b) => a.date.localeCompare(b.date));
  await env.TOKEN_CACHE.put("deposits", JSON.stringify(deposits));
  return jsonResponse({ ok: true }, { origin: env.ALLOWED_ORIGIN });
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
    return jsonResponse({ error: "from y to requeridos" }, { status: 400, origin: env.ALLOWED_ORIGIN });
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
  }, { origin: env.ALLOWED_ORIGIN });
}

/** GET /api/reports — lista los informes generados (metadatos). */
async function handleGetReports(request, env) {
  const reports = await kvGet(env, "reports_list", []);
  return jsonResponse(reports, { origin: env.ALLOWED_ORIGIN });
}

/** POST /api/reports — guarda metadatos de un informe recién generado. */
async function handleSaveReport(request, env) {
  const { from, to, label } = await request.json();
  if (!from || !to) {
    return jsonResponse({ error: "from y to requeridos" }, { status: 400, origin: env.ALLOWED_ORIGIN });
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
  return jsonResponse({ ok: true, id: entry.id }, { origin: env.ALLOWED_ORIGIN });
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

/** Lee una clave de KV, devuelve fallback si no existe. */
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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
