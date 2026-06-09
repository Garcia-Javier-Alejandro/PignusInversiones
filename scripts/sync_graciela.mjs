/**
 * sync_graciela.mjs
 * Lee el archivo Gra_JSON (una operación JSON por línea) y lo sube al Worker
 * mediante PUT /api/graciela/operations/import, reemplazando el listado completo.
 *
 * Uso:
 *   node scripts/sync_graciela.mjs
 *
 * El WORKER_URL puede sobreescribirse con la variable de entorno WORKER_URL.
 * Por defecto apunta al worker de producción.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const GRA_JSON   = resolve(__dirname, "../Gra_JSON");
const WORKER_URL = process.env.WORKER_URL || "https://pignus-api.garcia-javier-alejandro.workers.dev";
const ORIGIN     = process.env.ORIGIN     || "https://pignusinversiones.pages.dev";

// Leer y parsear el archivo: una operación JSON por línea, ignorar líneas vacías
const raw  = readFileSync(GRA_JSON, "utf8");
const ops  = raw
  .split("\n")
  .map(l => l.trim())
  .filter(l => l.length > 0)
  .map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      console.error(`Línea ${i + 1} inválida: ${line}`);
      console.error(err.message);
      process.exit(1);
    }
  });

console.log(`Leyendo ${ops.length} operación(es) de Gra_JSON...`);

const res = await fetch(`${WORKER_URL}/api/graciela/operations/import`, {
  method:  "PUT",
  headers: { "Content-Type": "application/json", "Origin": ORIGIN },
  body:    JSON.stringify(ops),
});

if (!res.ok) {
  const text = await res.text();
  console.error(`Error ${res.status}: ${text}`);
  process.exit(1);
}

const json = await res.json();
console.log(`OK — ${json.count} operación(es) guardada(s) en KV.`);
