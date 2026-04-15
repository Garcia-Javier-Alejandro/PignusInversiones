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
  const data = await iolGet("/api/v2/portafolio/argentina", token);
  return jsonResponse(data, { origin: env.ALLOWED_ORIGIN });
}

/**
 * GET /api/account
 * Proxy a GET /api/v2/estadocuenta de IOL.
 * Devuelve el estado de cuenta con el saldo disponible en pesos.
 */
async function handleAccount(request, env) {
  const token = await getValidToken(env);
  const data = await iolGet("/api/v2/estadocuenta", token);
  return jsonResponse(data, { origin: env.ALLOWED_ORIGIN });
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
async function iolGet(endpoint, token) {
  const response = await fetch(`${IOL_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

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
      "Access-Control-Allow-Methods": "GET, OPTIONS",
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
