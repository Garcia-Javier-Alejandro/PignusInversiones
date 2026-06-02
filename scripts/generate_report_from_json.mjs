import fs from 'fs/promises';
import path from 'path';

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

function fmt(n) {
  if (n == null) return "-";
  return n >= 1000 ? n.toLocaleString('es-AR') : String(n);
}
function money(n) {
  if (n == null) return "-";
  return `$${Number(n).toLocaleString('es-AR', {maximumFractionDigits:2, minimumFractionDigits:2})}`;
}

async function loadJson(file) {
  try {
    const txt = await fs.readFile(file, 'utf8');
    return JSON.parse(txt);
  } catch (err) {
    console.error(`No pude leer ${file}:`, err.message);
    return null;
  }
}

function isoDate(d) { return new Date(d).toISOString().split('T')[0]; }

function nearestBeforeOrEqual(list, targetDate) {
  const sorted = list.filter(x => x.date).sort((a,b)=>a.date.localeCompare(b.date));
  let best = null;
  for (const s of sorted) {
    if (s.date <= targetDate) best = s;
  }
  return best;
}

function firstOnOrAfter(list, targetDate) {
  const sorted = list.filter(x => x.date).sort((a,b)=>a.date.localeCompare(b.date));
  for (const s of sorted) if (s.date >= targetDate) return s;
  return null;
}

async function main() {
  const [historyFile='history_may.json', positionsFile='positions_may.json', depositsFile='deposits_may.json', startDate='2026-05-01', endDate='2026-05-31', outFile] = process.argv.slice(2);
  const outputFileName = outFile || `datos_informe_${endDate.replace(/-/g, '')}.md`;
  const defaultBase = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'Pignusdocs', 'datos');
  const outPath = path.isAbsolute(outputFileName)
    ? outputFileName
    : outFile
      ? path.resolve(process.cwd(), outputFileName)
      : path.join(defaultBase, outputFileName);

  const history = await loadJson(historyFile);
  const positions = await loadJson(positionsFile);
  const depositsFileData = await loadJson(depositsFile);

  if (!history || !positions) {
    console.error('Faltan archivos necesarios. Asegurate de exportar history y positions.');
    process.exit(1);
  }

  const snapshots = history.snapshots || history || [];
  const spyPrices = history.spyPrices || [];
  const deposits = depositsFileData || history.deposits || [];

  const startSnap = firstOnOrAfter(snapshots, startDate) || nearestBeforeOrEqual(snapshots, startDate) || snapshots[0];
  const endSnap   = nearestBeforeOrEqual(snapshots, endDate) || snapshots[snapshots.length-1];

  const totalStart = startSnap?.totalARS ?? 0;
  const totalEnd   = endSnap?.totalARS ?? 0;

  const capitalAportadoTotal = (deposits || []).reduce((s,d)=>s + (d.amount||0), 0);
  const gananciaAbsoluta = totalEnd - capitalAportadoTotal;
  const rendimiento = capitalAportadoTotal ? (gananciaAbsoluta / capitalAportadoTotal) * 100 : 0;

  // Latest positions for end date
  const posDay = nearestBeforeOrEqual(positions, endDate) || positions[positions.length-1] || { activos: [] };
  const activos = posDay.activos || [];

  const portRows = activos.map(a => {
    const simbolo = a.s || '';
    const cant = a.q || 0;
    const precio = a.v && a.q ? Math.round(a.v / a.q) : (a.ppc || 0);
    return {
      simbolo,
      descripcion: simbolo,
      tipo: a.t || '',
      cant,
      precio,
      ppc: a.ppc || 0,
      valorizado: a.v || 0,
      rend_pct: a.gp != null ? a.gp : null,
      rend_monto: a.g || 0,
      var_hoy: '-' // not available
    };
  });

  const sumaGanancias = activos.reduce((s,a)=>s + (a.g||0),0);

  // Composición por sector
  const bySector = {};
  for (const p of portRows) {
    const sector = SECTOR_MAP[p.simbolo] || 'Otros';
    bySector[sector] = (bySector[sector]||0) + (p.valorizado||0);
  }

  const totalVal = Object.values(bySector).reduce((s,v)=>s+v,0) || totalEnd;

  // Ranking
  const ranking = [...portRows].sort((a,b)=> (b.rend_pct||0) - (a.rend_pct||0));

  // SPY benchmark
  const spyByDate = Object.fromEntries((spyPrices||[]).map(p=>[p.date, p.price]));
  const spyStart = spyByDate[startSnap?.date] || nearestPrice(spyPrices, startSnap?.date);
  const spyEnd = spyByDate[endSnap?.date] || nearestPrice(spyPrices, endSnap?.date);
  const spyRend = (spyStart && spyEnd) ? ((spyEnd - spyStart)/spyStart)*100 : null;

  // Evolución mayo
  const maySnaps = snapshots.filter(s => s.date >= startDate && s.date <= endDate).sort((a,b)=>a.date.localeCompare(b.date));

  // Build markdown
  let md = '';
  md += `# Datos en vivo — Pignus al ${endDate}\n\n`;
  md += `> Fuente: API IOL (portafolio y cuenta) + KV Cloudflare (snapshots, depósitos).\n`;
  md += `> Fecha/hora de consulta: ${endDate}.\n\n---\n\n`;

  md += `## RESUMEN EJECUTIVO\n\n`;
  md += `| Concepto | Valor |\n|----------|-------|\n`;
  md += `| **Total cartera (snapshot)** | **${money(totalEnd)}** |\n`;
  md += `| Títulos valorizados | ${money(totalVal)} |\n`;
  md += `| Efectivo disponible | ${money((endSnap?.efectivoDisponible)||0)} |\n`;
  md += `| Capital aportado total | ${money(capitalAportadoTotal)} |\n`;
  md += `| **Ganancia absoluta** | **${money(gananciaAbsoluta)}** |\n`;
  md += `| **Rendimiento sobre capital** | **${rendimiento.toFixed(2)}%** |\n`;
  md += `| Período completo | ${startDate} → ${endDate} |\n`;
  md += `| Dólar MEP | ${endSnap?.mep ?? 'no disponible hoy'} |\n\n`;

  md += `---\n\n`;
  md += `## PUNTO DE PARTIDA: ESTADO AL ${startDate}\n\n`;
  md += `| Concepto | Valor |\n|----------|-------|\n`;
  md += `| Total cartera al ${startDate} | ${money(totalStart)} |\n`;
  md += `| Capital activo entonces | ${money(capitalAportadoTotal)} |\n`;
  md += `| Ganancia al ${startDate} | ${money(startSnap?.totalGanancia||0)} |\n`;
  md += `| Posiciones activas | ${maySnaps.length>0?'ver tabla de posiciones':'-'} |\n`;
  md += `| Capital no desplegado | ~$0 |\n\n`;

  md += `---\n\n`;
  md += `## DEPÓSITOS\n\n`;
  md += `| Fecha | Monto | Nota |\n|-------|-------|------|\n`;
  for (const d of deposits.filter(d=>d.date>=startDate && d.date<=endDate)) {
    md += `| ${d.date} | ${money(d.amount)} | ${d.note||''} |\n`;
  }
  const totalDepositosPeriodo = deposits.filter(d=>d.date>=startDate && d.date<=endDate).reduce((s,d)=>s+(d.amount||0),0);
  md += `| **Total periodo** | **${money(totalDepositosPeriodo)}** | |\n\n`;

  md += `---\n\n`;
  md += `## OPERACIONES DE MAYO (entre ${startDate} y hoy)\n\n`;
  md += `| Fecha | Tipo | Activo | Cant. | Precio ($) | Monto ($) |\n|-------|------|--------|-------|------------|-----------|\n`;
  md += `| (las operaciones no están en KV; agregalas manualmente si querés) | | | | | |\n\n`;

  md += `---\n\n`;
  md += `## PORTAFOLIO AL ${endDate} (snapshot)\n\n`;
  md += `| Activo | Descripción | Tipo | Cant. | Precio ($) | PPC ($) | Valorizado ($) | Rend. (%) | Rend. ($) | Var. hoy (%) |\n`;
  md += `|--------|-------------|------|-------|------------|---------|----------------|-----------|-----------|--------------|\n`;
  for (const r of portRows) {
    md += `| ${r.simbolo} | ${r.descripcion} | ${r.tipo} | ${r.cant} | ${fmt(r.precio)} | ${fmt(r.ppc)} | ${fmt(r.valorizado)} | ${r.rend_pct!=null?`+${Number(r.rend_pct).toFixed(2)}%`:'-'} | ${fmt(r.rend_monto)} | ${r.var_hoy} |\n`;
  }
  md += `\n**Suma ganancias no realizadas: ${money(sumaGanancias)}**\n\n`;

  md += `---\n\n`;
  md += `## COMPOSICIÓN POR SECTOR\n\n`;
  md += `| Sector | Activos | Valorizado ($) | Peso (%) |\n|--------|---------|----------------|----------|\n`;
  for (const [sec, val] of Object.entries(bySector)) {
    md += `| ${sec} | - | ${fmt(val)} | ${((val/totalVal)*100).toFixed(2)}% |\n`;
  }
  md += `| **Total** | | **~${fmt(totalVal)}** | **100%** |\n\n`;

  md += `---\n\n`;
  md += `## RANKING POR RENDIMIENTO (desde compra)\n\n`;
  md += `| Activo | Rend. (%) | Rend. ($) |\n|--------|-----------|-----------|\n`;
  for (const r of ranking) md += `| ${r.simbolo} | ${r.rend_pct!=null?`+${Number(r.rend_pct).toFixed(2)}%`:'-'} | ${money(r.rend_monto)} |\n`;
  md += `\n`;

  md += `---\n\n`;
  md += `## EVOLUCIÓN MAYO 2026 (snapshots KV)\n\n`;
  md += `| Fecha | Total ARS | Ganancia | Evento |\n|-------|-----------|----------|--------|\n`;
  for (const s of maySnaps) md += `| ${s.date} | ${money(s.totalARS)} | ${money(s.totalGanancia)} | ${s.evento||''} |\n`;
  md += `\n`;

  md += `---\n\n`;
  md += `## BENCHMARKS (desde ${startDate})\n\n`;
  md += `### SPY CEDEAR\n\n`;
  md += `| Fecha | Precio |\n|-------|--------|\n`;
  md += `| ${startSnap?.date||startDate} | ${spyStart?money(spyStart):'-'} |\n`;
  md += `| ${endSnap?.date||endDate} | ${spyEnd?money(spyEnd):'-'} |\n\n`;
  md += `**Rendimiento SPY en mayo:** ${spyRend!=null?`${spyRend.toFixed(2)}%`:'-'}\n\n`;

  md += `---\n\n`;
  md += `## DATOS ADICIONALES\n\n`;
  md += `**Cuenta IOL:** (no disponible)\n`;
  md += `**Operaciones en mayo (últimos 30 días):** (no disponible)\n`;
  md += `**Dashboard:** https://pignusinversiones.pages.dev/\n`;

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, md, 'utf8');
  console.log('Informe generado en', outPath);
}

function nearestPrice(prices, targetDate) {
  if (!prices || prices.length===0) return null;
  let best = null;
  for (const p of prices) {
    if (!p.date) continue;
    if (p.date <= targetDate) best = p;
  }
  return best?.price ?? null;
}

main().catch(err => { console.error(err); process.exit(1); });
