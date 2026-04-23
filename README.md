# Inversiones

Repositorio de trabajo para investigación y gestión de inversiones personales.

## Objetivos

### Investigación de mercado
Análisis y seguimiento del mercado de inversiones: instrumentos a incorporar, momentos de entrada/salida, diversificación de cartera.

### Resúmenes de cuenta de inversión
Generación de resúmenes periódicos del estado de las cuentas de inversión, con métricas de rendimiento, composición de cartera y evolución patrimonial.

## Cuentas

### Inviu (cuenta 184318)
Cuenta de referencia. Los resúmenes históricos en `Inviu/` sirven como base de formato y contexto para la generación de nuevos resúmenes.

### Pignus
Cuenta administrada en **IOL (InvertirOnline)**, titulares: **Graciela y Fiorella**.

#### Workflow mensual
1. Subir a `Pignus/` el **Detalle de Operaciones** y el **Estado de Cuenta** del período, exportados desde IOL.
2. Solicitar la generación del resumen mensual.
3. El resumen incluye análisis de la cartera y una lista de **accionables** para el mes.

---

## Dashboard web — Pignus

Dashboard mobile-first para ver el portafolio en tiempo real. Accesible desde cualquier navegador sin instalar nada.

**URLs de producción:**
- Frontend: https://inversiones-3f4.pages.dev/
- Worker API: https://pignus-api.garcia-javier-alejandro.workers.dev

### Arquitectura

```
Navegador
(Cloudflare Pages — auto-deploy en push a master)
    │
    │  fetch /api/portfolio, /api/account, /api/history, /api/snapshot
    ▼
Cloudflare Worker  "pignus-api"
(dashboard/worker/src/index.js)
    │                         │                        │
    │ Bearer token + proxy    │ GET SPY histórico      │ GET VCP fondo MP
    ▼                         ▼                        ▼
api.invertironline.com   api.invertironline.com  api.argentinadatos.com
(portafolio, cuenta)     (CEDEAR SPY bCBA)       (Mercado Fondo Clase A)
```

**Stack frontend:** HTML + Alpine.js v3 + Tailwind CSS (CDN) + Chart.js v4 + chartjs-plugin-datalabels + chartjs-chart-treemap + chartjs-plugin-annotation. Sin build step, sin bundler.

**Stack backend:** Cloudflare Worker (ES modules). KV Namespace `TOKEN_CACHE` para persistencia.

---

### Decisiones de diseño

#### Autenticación IOL
- El Worker obtiene un token IOL con `grant_type=password` y lo cachea en KV con TTL de 24h.
- Antes de cada request verifica si el token vence en menos de 60s: si es así usa el `refresh_token`.
- Si recibe un 401 (token invalidado remotamente): borra el KV, re-autentica desde cero y reintenta una sola vez (`retried` flag para evitar loops).

#### Protección de datos en mantenimiento
- IOL retorna valores en cero durante su ventana de mantenimiento (~00:00–00:10 UTC-3).
- El frontend detecta esto con `isValidPortfolio()` — verifica que `Σ(valorizado) > 0`.
- Si los datos son inválidos, conserva el estado anterior y muestra un banner ámbar.

#### Snapshots diarios
- Cada vez que el dashboard carga datos válidos, el frontend llama a `POST /api/snapshot` con `{ totalARS, mep, totalGanancia }`.
- El Worker guarda un snapshot por día (ignora duplicados de la misma fecha).
- `totalGanancia = Σ(activo.gananciaDinero)` — ganancia no realizada total, usada para inferir depósitos.
- Cada snapshot también incluye `mpVcp` (Valor Cuota Patrimonial del Mercado Fondo Clase A, obtenido de CAFCI via argentinadatos.com) y `mep`.

**Estructura de un snapshot:**
```json
{
  "date": "2026-04-16",
  "totalARS": 12350000,
  "totalGanancia": 250000,
  "mep": 1185.50,
  "mpVcp": 1423.67
}
```

#### Detección automática de depósitos y retiros
- No hay endpoint en IOL para obtener movimientos de dinero.
- **Algoritmo:** para dos snapshots consecutivos, `depósito = Δ(totalARS) − Δ(totalGanancia)`. El delta de `gananciaDinero` refleja el movimiento de mercado; el remanente es capital nuevo o retirado.
- Umbral mínimo: ARS 500.000 (evita falsos positivos por variaciones normales de mercado).
- No duplica depósitos: si ya hay uno registrado en ese período, omite la inferencia.
- Los depósitos se persisten en KV (key `deposits`) con `{ date, amount, note, auto: true, mpVcp, spyPrice }`.
- Limitación conocida: ventas grandes de posiciones con ganancias no realizadas importantes pueden generar falsos positivos.

#### Benchmarks: SPY y Mercado Pago
- **SPY (CEDEAR):** precios históricos obtenidos de IOL (`/api/v2/cotizaciones/titulos/bCBA/SPY/historico/ajustada`, sin ajuste). Usa el mismo token del Worker. Caché de 24h en KV (`spy_history_cache_iol`).
- **Mercado Pago:** rendimiento del "Mercado Fondo - Clase A" (fondo money market de MP, datos CAFCI via argentinadatos.com). Se guarda el VCP por fecha en cada snapshot.
- **Lógica de benchmarks con depósitos:** cada depósito "compra" unidades adicionales de SPY y cuotas adicionales del fondo MP al precio de ese día. Así la comparación es justa: *¿qué hubiera pasado si cada peso aportado se hubiera puesto en SPY o en MP?*
- **Comisión SPY:** cada compra hipotética de SPY descuenta un 0,3% de comisión (`amount × 0,997 / precio`), reflejando el costo real de operar CEDEARs en IOL.

#### Cálculo de rendimiento total
- Fórmula: `(valor actual − Σ depósitos) / Σ depósitos × 100`.
- Si no hay depósitos registrados, cae a ganancia sobre costo por PPC (menos preciso).

#### Cálculo de rendimiento 30d
- Base: snapshot más reciente con ≥ 30 días de antigüedad. Si no existe ninguno, usa el más antiguo disponible.
- Fórmula: `(valorHoy − Σ depósitos) / valorBase − 1`.
- **Decisión de diseño:** se evaluaron tres alternativas:
  - *TWRR* — elimina el efecto de timing de los depósitos. Descartado porque el timing de cuándo ingresar capital se considera parte de la estrategia y se quiere que quede reflejado en la métrica.
  - *Modified Dietz / MWR* — correcto para medir crecimiento real de riqueza, pero el denominador ponderado no es comparable directamente con retornos simples de benchmarks (SPY, MP).
  - *Fórmula actual* — captura el timing y es intuitiva: "¿cuánto vale mi capital original después de descontar lo que puse yo?". Denominador fijo en `valorBase`; tiene el sesgo conocido de que depósitos tempranos inflan el resultado (los depósitos también generan retorno pero no aparecen en el denominador), efecto aceptado conscientemente.

#### Tipos y sectores
- IOL devuelve `activo.titulo.tipo` con strings propios (`"CEDEARS"`, `"ACCIONES"`, `"TitulosPublicos"`, `"FondoComundeInversion"`).
- `TIPO_MAP` normaliza esos strings a los nombres de display.
- `SECTORES` es un mapa hardcodeado `símbolo → sector`. Al incorporar un activo nuevo hay que agregarlo manualmente y hacer push.
- El CASH disponible se trata como un activo sintético del sector "Liquidez".

---

### Funcionalidades actuales

#### Cards de resumen
- **Total cartera:** calculado desde `cuenta.total` de IOL (incluye títulos + disponible).
- **Rendimiento total:** sobre capital aportado (ver fórmula arriba).
- **Rendimiento 30d:** pendiente (requiere historial suficiente).

#### Gráfico histórico
- Tres líneas: Pignus (área rellena), S&P 500, Mercado Pago.
- Anotaciones verticales punteadas en fechas de depósito/retiro detectados.
- Los depósitos se anclan al snapshot más cercano en o después de su fecha (el eje X solo tiene fechas de snapshot).
- Selector de período: 1M / 3M / 6M / Todo. Los benchmarks siempre se acumulan desde el inicio; el filtro solo recorta el rango visible.
- Toggle ARS / USD MEP: celeste = ARS, verde = MEP.

#### Panel "Composición y Rendimiento"
- **Treemap (default):** tamaño de bloque = peso en cartera. Color = rendimiento del sector/tipo desde PPC (paleta estilo Finviz: charcoal oscuro en 0%, rojo saturado en −10%, verde brillante en +10%). Labels muestran el rendimiento %, no el peso.
- **Donut:** composición por peso, con % dentro de los segmentos ≥ 6%.
- Toggle sector / tipo aplica a ambos tipos de gráfico.
- Leyenda de color (solo treemap por sector): barra de gradiente con escala −10% a +10%.

#### Tabla de posiciones
- 7 columnas: Activo, Tipo, Sector, PPC, Valorizado, Rend %, Rend $.
- Colapsada por defecto a 3 columnas (Activo, Valorizado, Rend %). Botón "Expandir detalles".
- Ordenamiento por cualquier columna, con toggle asc/desc.
- Colores verde/rojo en columnas de rendimiento.

---

### KV Namespace — claves y estructuras

| Clave | Tipo | Descripción |
|-------|------|-------------|
| `iol_token` | objeto | `{ access_token, refresh_token, expires_at }` |
| `portfolio_history` | array | Snapshots diarios `{ date, totalARS, totalGanancia, mep, mpVcp }` |
| `positions_history` | array | Posiciones diarias `{ date, activos: [{s,t,q,ppc,v,g,gp}] }` — campos: s=símbolo, t=tipo, q=cantidad, ppc, v=valorizado, g=gananciaDinero, gp=gananciaPorcentaje |
| `deposits` | array | Depósitos/retiros `{ date, amount, note, auto, mpVcp, spyPrice }` |
| `spy_history_cache_iol` | objeto | `{ fetchedAt, prices: [{date, price}] }` — precios CEDEAR SPY desde IOL bCBA, TTL 24h |
| `mep_cache` | objeto | `{ mep, al30Ars, al30dUsd, fetchedAt }` — MEP implícito AL30/AL30D, TTL 15 min |
| `mp_rates` | array | Tasas diarias manuales MP `{ date, dailyPct }` (legado, no usado activamente) |

#### Límites de almacenamiento KV (estimación)

Con ~20 posiciones por día y ~70 bytes/posición comprimida:
- **~1.4 KB/día** en `positions_history`
- **~500 KB/año** — a este ritmo se tardan **~48 años en alcanzar el límite de 25 MB por clave**.
- Si la cartera crece mucho (>50 posiciones), el horizonte se reduce proporcionalmente.
- Solución cuando llegue: rotar a claves anuales (`positions_history_2050`, etc.).

**KV Namespace:** `TOKEN_CACHE` — id: `8c1461c1de29450ba42172257fcfdeda`

---

### Endpoints del Worker

| Método | Path | Descripción |
|--------|------|-------------|
| GET | `/api/portfolio` | Proxy a IOL `/api/v2/portafolio/argentina` |
| GET | `/api/account` | Proxy a IOL `/api/v2/estadocuenta` |
| GET | `/api/history` | Snapshots + precios SPY + depósitos (con backfill e inferencia automática) |
| POST | `/api/snapshot` | Guarda snapshot del día `{ totalARS, mep, totalGanancia, activos }` — escribe en `portfolio_history` y `positions_history` |
| GET | `/api/positions` | Historial completo de posiciones por día |
| GET | `/api/mep` | MEP implícito `{ mep, al30Ars, al30dUsd }` calculado desde precios IOL (caché 15 min) |
| GET | `/api/deposits` | Lista de depósitos registrados |
| POST | `/api/deposit` | Registra depósito manual `{ date, amount, note }` (legado) |
| POST | `/api/mp-rate` | Registra tasa diaria MP manual (legado) |

---

### Setup — primera vez

**Requisitos:** Node.js v18+, cuenta de Cloudflare, Wrangler CLI.

```bash
npm install -g wrangler
wrangler login
```

**Deploy del Worker:**
```bash
cd dashboard/worker

# Crear KV Namespace
wrangler kv namespace create TOKEN_CACHE
# → Copiar el id resultante a wrangler.toml

# Secrets
wrangler secret put IOL_USERNAME
wrangler secret put IOL_PASSWORD
wrangler secret put ALLOWED_ORIGIN   # URL de Pages

wrangler deploy
```

**Configurar Pages:**
1. Cloudflare Dashboard → Pages → Create project → Connect to Git → repo `Inversiones`
2. Build settings: framework = None, build command = vacío, output = `dashboard/frontend`
3. Cada push a `master` deploya automáticamente.

**Editar `dashboard/frontend/app.js`:** reemplazar `WORKER_URL` con la URL real del Worker.

---

### Actualizar sectores

El mapa `SECTORES` en `app.js` es hardcodeado. Para un activo nuevo: agregar `SÍMBOLO: "Sector"` y hacer push.

---

## To Do

### Dashboard — corto plazo
- [x] **Rendimiento 30d:** `calcReturn30d()` — base: snapshot más reciente ≥ 30 días atrás, ajustado por depósitos en el período. La card muestra la fecha base para que quede claro el período real.
- [x] **Snapshot completo de posiciones:** `POST /api/snapshot` ahora acepta `activos` y los persiste compactos en `positions_history`. Accesibles via `GET /api/positions`.
- [ ] **Gráfico histórico normalizado:** opción de ver las curvas indexadas a 100 en el punto inicial del período seleccionado, en lugar de valores absolutos en ARS/USD.
- [x] **MEP desde AL30/AL30D:** `GET /api/mep` calcula `precio_AL30_ARS / precio_AL30D_USD` vía IOL. El frontend ya no depende de dolarapi.com.

### Mobile / UX — bugs y mejoras detectadas
- [x] **Alto del gráfico histórico:** `h-72` en mobile, `h-56` en sm+.
- [x] **Tooltip al tap:** `onClick` en Chart.js — segundo tap sobre el gráfico cierra el tooltip.
- [x] **Botones treemap/rueda en mobile:** `flex-wrap` en headers de "Historial" y "Composición"; controles bajan a segunda línea si no entran.
- [x] **Toggle ARS/MEP en mobile:** dos causas. (1) `touch-action: manipulation` en el botón elimina el delay de 300ms de iOS/Android. (2) `$watch('moneda')` ahora usa `$nextTick` para que Alpine flushee los `x-text` del DOM antes de que el re-render del canvas del historial bloquee el hilo.

### Dashboard — mediano plazo
- [ ] **Reporte mensual generado automáticamente:** requiere snapshot completo de posiciones. El reporte incluiría: valor inicio/fin de mes, depósitos del período, rendimiento ajustado, performance por posición, atribución por sector, comparación vs benchmarks, efecto moneda.
- [ ] **Selector de fecha de inicio personalizado** para el cálculo de rendimiento (algunos activos pueden haberse comprado después del primer snapshot).
- [ ] **Vista mobile optimizada:** colapsar el treemap a un resumen de texto en pantallas muy chicas.
- [ ] **Modo offline / PWA:** cachear el último estado válido para ver sin conexión.

### Datos y fuentes
- [ ] **Historial de operaciones:** IOL no expone compras/ventas vía API. Opciones: (a) scraping del PDF de estado de cuenta, (b) upload manual de CSV de operaciones, (c) endpoint no documentado.
- [ ] **Dividendos y distribuciones FCI:** no están registrados en ningún lugar. Distorsionan levemente el cálculo de rendimiento por PPC.
- [ ] **Nuevos activos → actualizar SECTORES:** cada vez que se incorpora un símbolo nuevo, agregarlo manualmente al mapa en `app.js`.

### Infraestructura
- [ ] **Tests de integración para el Worker:** verificar los endpoints críticos (token cache, snapshot, inferDeposits) contra el KV real.
- [ ] **Alertas de mantenimiento IOL:** notificación (push o email) cuando se detectan datos vacíos, en lugar de solo mostrar el banner.

---

## Estructura

```
Inversiones/
├── dashboard/
│   ├── worker/
│   │   ├── src/index.js          ← Worker: auth IOL, KV cache, todos los endpoints
│   │   └── wrangler.toml         ← config Wrangler (binding KV, nombre worker)
│   └── frontend/
│       ├── index.html            ← UI (Alpine.js + Tailwind + Chart.js, todo CDN)
│       ├── app.js                ← toda la lógica JS: fetch, cálculos, gráficos
│       └── _headers              ← headers de seguridad HTTP para Pages
├── scripts/
│   └── test_iol_api.py           ← test de conexión a la API de IOL
├── Pignus/
│   ├── datos/                    ← CSVs exportados desde IOL
│   └── resumenes/                ← PDFs de resúmenes generados
├── Inviu/                        ← resúmenes históricos de referencia (formato base)
├── secrets.env                   ← credenciales locales (gitignoreado)
└── secrets_example               ← ejemplo de formato de secrets.env
```
