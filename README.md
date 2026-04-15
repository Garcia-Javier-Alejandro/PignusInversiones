# Inversiones

Repositorio de trabajo para investigación y gestión de inversiones personales.

## Objetivos

### Investigación de mercado
Análisis y seguimiento del mercado de inversiones con el fin de definir estrategias de inversión: instrumentos a incorporar, momentos de entrada/salida, diversificación de cartera, etc.

### Resúmenes de cuenta de inversión
Generación de resúmenes periódicos del estado de las cuentas de inversión, con métricas de rendimiento, composición de cartera y evolución patrimonial.

## Cuentas

### Inviu (cuenta 184318)
Cuenta de referencia. Los resúmenes históricos ubicados en la carpeta `Inviu/` sirven como base, formato y contexto para la generación de nuevos resúmenes.

### Pignus
Cuenta administrada en la plataforma **IOL (InvertirOnline)**, cuyos titulares son **Graciela y Fiorella**. Los resúmenes de esta cuenta se generan tomando como modelo el formato establecido por los resúmenes de Inviu.

#### Workflow mensual
1. Subir a `Pignus/` el **Detalle de Operaciones** y el **Estado de Cuenta** del período, exportados desde IOL.
2. Solicitar la generación del resumen mensual.
3. El resumen incluye análisis de la cartera y una lista de **accionables** para trabajar durante el mes.

## Dashboard web

Dashboard mobile-first para ver el portafolio en tiempo real. Accesible desde cualquier navegador sin instalar nada.

### Arquitectura

```
Navegador (Cloudflare Pages)
    │  fetch /api/portfolio, /api/account
    ▼
Cloudflare Worker (pignus-api)
    │  Bearer token, proxy autenticado
    ▼
API de IOL (api.invertironline.com)
```

- **Frontend** (`dashboard/frontend/`): HTML + Alpine.js + Tailwind + Chart.js, todo via CDN. Sin build step. Cada push a `main` dispara un deploy automático en Cloudflare Pages.
- **Worker** (`dashboard/worker/`): proxy JS que maneja la autenticación con IOL y cachea el token en KV Store para no autenticar en cada request.

### Funcionalidades
- Toggle ARS / USD MEP (cotización via dolarapi.com)
- Cards de resumen: total cartera, disponible, rendimiento %
- Dos gráficos de torta: por tipo de activo y por sector económico
- Tabla de posiciones ordenada por valorizado, con badge de tipo y rendimiento en color

### Setup — primera vez

**Requisitos:** Node.js v18+, cuenta de Cloudflare.

```bash
# 1. Instalar Wrangler (CLI de Cloudflare)
npm install -g wrangler
wrangler login   # abre el browser para autenticar
```

**Deploy del Worker:**

```bash
cd dashboard/worker

# Crear el KV Namespace para cachear el token de IOL
wrangler kv namespace create TOKEN_CACHE
# → Copiar el "id" que devuelve y pegarlo en wrangler.toml

# Configurar credenciales como secrets (nunca van en el repo)
wrangler secret put IOL_USERNAME   # email de IOL
wrangler secret put IOL_PASSWORD   # contraseña de IOL

# Deploy
wrangler deploy
# → Anota la URL resultante: https://pignus-api.TU_USUARIO.workers.dev
```

**Configurar Pages en Cloudflare Dashboard:**
1. Pages → Create project → Connect to Git → repo `Inversiones`
2. Build settings:
   - Framework preset: **None**
   - Build command: *(vacío)*
   - Build output directory: `dashboard/frontend`
3. Deploy → copiar la URL asignada (ej: `https://pignus.pages.dev`)

**Conectar Worker con Pages:**

```bash
cd dashboard/worker
wrangler secret put ALLOWED_ORIGIN   # pegar la URL de Pages
wrangler deploy
```

Editar `dashboard/frontend/app.js` y reemplazar `WORKER_URL` con la URL real del Worker.
Este cambio se sube a `main` y Cloudflare Pages lo deploya automáticamente.

### Actualizar sectores del gráfico

El mapa de sectores está hardcodeado en `dashboard/frontend/app.js` (objeto `SECTORES`).
Para agregar un activo nuevo: agregar una línea con el símbolo (exactamente como aparece en IOL) y el sector, y hacer push a `main`.

### Nota: cálculo alternativo del MEP

El dashboard obtiene el MEP desde `dolarapi.com`. Una alternativa más precisa es calcularlo directamente desde los precios de IOL: dividir el precio del bono AL30 en pesos (mercado BCBA) por el precio del AL30D en dólares (BCBA). Esto da el MEP implícito real. Implementación futura.

## Estructura

```
Inversiones/
├── dashboard/
│   ├── worker/
│   │   ├── src/index.js          ← Worker: auth IOL, cache KV, endpoints
│   │   └── wrangler.toml         ← config Wrangler
│   └── frontend/
│       ├── index.html            ← UI del dashboard (Alpine.js + Tailwind + Chart.js)
│       ├── app.js                ← lógica JS (fetch, render, formateo, gráficos)
│       └── _headers              ← headers de seguridad HTTP para Cloudflare Pages
├── scripts/
│   └── test_iol_api.py           ← test de conexión a la API de IOL
├── Pignus/
│   ├── datos/                    ← CSVs exportados desde IOL
│   └── resumenes/                ← PDFs de resúmenes generados
├── Inviu/                        ← resúmenes históricos de referencia
├── secrets.env                   ← credenciales locales (gitignoreado)
└── secrets_example               ← ejemplo de formato de secrets.env
```
