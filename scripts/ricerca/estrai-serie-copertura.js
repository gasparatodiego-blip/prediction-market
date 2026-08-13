'use strict';

/**
 * ESTRAZIONE DELLE SERIE STORICHE DI COPERTURA — sola lettura, nessun effetto sul bot.
 *
 * Scrive in `data/ricerca/`. Non importa niente da `lib/maker`, non apre socket, non firma niente.
 *
 * ══ LE QUATTRO SERIE, E DA DOVE VENGONO DAVVERO ═══════════════════════════════════════════════
 *
 * A · ORDINI APERTI TOTALI — **osservazione diretta**, non ricostruzione.
 *     Fonte: `polymarket-maker-audit.jsonl`, righe `op:'manual-list'` con `requested.marketId === null`
 *     (cioè l'elenco NON filtrato per mercato): `response.count` È il numero di ordini vivi sul venue
 *     in quell'istante. È la serie più affidabile che esista qui dentro, perché non somma nascite e
 *     morti: legge il totale.
 *
 * B · MERCATI COPERTI e C · NOZIONALE A BOOK — **ricostruite per mercato**, con una fonte sola.
 *     Fonte: le righe `op:'auto-reprice'` che portano `observed.esposizioneOrdiniUsd`, cioè quanto
 *     capitale QUEL mercato ha in ordini a riposo, misurato dal ciclo che sta per decidere. Si tiene
 *     l'ULTIMA osservazione per mercato dentro una finestra, e si somma. Non si interpola: un mercato
 *     non osservato nella finestra semplicemente non contribuisce, e il campione dichiara quanti
 *     mercati ha visto.
 *
 * D · PnL — **osservazione diretta**, cadenza 30 s.
 *     Fonte: il log pm2 di `agent43-guardian`, che a ogni giro scrive «PnL ±X USD (±Y%)». È la stessa
 *     misura su cui il guardiano decide, quindi è LA serie giusta per capire perché ha deciso.
 *
 * ⚠ COSA NON SI PUÒ RICOSTRUIRE, E VA DETTO INVECE DI INVENTARLO. Il ciclo di vita ordine-per-ordine
 * (nascita → morte) NON è ricostruibile su tutto lo storico: delle cancellazioni, **651 righe
 * `manual-cancel/ok` non portano `orderId`** (solo `order-vanished` lo porta). Sommare nascite e
 * sottrarre le morti note produrrebbe una serie che DERIVA verso l'alto in modo sistematico, e
 * sembrerebbe un dato. Per questo A è un'osservazione diretta e non una somma.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'ricerca');
const GIORNALE = path.join(ROOT, 'data', 'polymarket-maker-audit.jsonl');
const LOG_GUARDIAN = '/root/.pm2/logs/agent43-guardian-out.log';
const EXEC = path.join(ROOT, 'data', 'execution-audit.jsonl');

const CHUNK = 64 * 1024 * 1024;

/** Scorre un file grande a blocchi, senza mai costruire una stringa oltre il limite di V8. */
function perRiga(file, fn) {
  const st = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  let pos = 0; let resto = '';
  while (pos < st.size) {
    const n = Math.min(CHUNK, st.size - pos);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, pos);
    pos += n;
    const testo = resto + buf.toString('utf8');
    const righe = testo.split('\n');
    resto = righe.pop();
    for (const r of righe) fn(r);
  }
  if (resto) fn(resto);
  fs.closeSync(fd);
}

// ── A · ORDINI APERTI, osservazione diretta ─────────────────────────────────────────────────────
// ── B/C · per mercato, dalla stessa passata ─────────────────────────────────────────────────────
const serieA = [];
const espo = [];           // {ts, m, usd}
let righeLette = 0;

perRiga(GIORNALE, (l) => {
  if (l.length < 20) return;
  righeLette++;
  // Filtro grezzo prima di JSON.parse: il giornale ha 170 MB e parsarlo tutto costa minuti.
  const haList = l.indexOf('"manual-list"') >= 0;
  const haEspo = l.indexOf('esposizioneOrdiniUsd') >= 0;
  if (!haList && !haEspo) return;
  let j; try { j = JSON.parse(l); } catch { return; }
  if (haList && j.op === 'manual-list') {
    const mid = j.requested ? j.requested.marketId : undefined;
    const c = j.response ? Number(j.response.count) : NaN;
    // `marketId` nullo = elenco NON filtrato = il totale vero. Con un marketId è il conteggio di UN
    // mercato, e sommarli fra loro darebbe doppi conteggi (lo stesso mercato è elencato più volte).
    if ((mid === null || mid === undefined) && Number.isFinite(c)) serieA.push({ ts: j.ts, n: c });
  }
  if (haEspo && j.observed && Number.isFinite(j.observed.esposizioneOrdiniUsd)) {
    const m = String(j.marketRef || '').replace(/^cid_/, '');
    if (m) espo.push({ ts: j.ts, m, usd: j.observed.esposizioneOrdiniUsd });
  }
});

serieA.sort((a, b) => a.ts - b.ts);
espo.sort((a, b) => a.ts - b.ts);

// B e C: finestra di 5 minuti, ultima osservazione per mercato dentro la finestra.
const FIN = 5 * 60e3;
const serieBC = [];
if (espo.length) {
  const t0 = Math.floor(espo[0].ts / FIN) * FIN;
  const t1 = espo[espo.length - 1].ts;
  let i = 0;
  const ultimo = new Map();   // m -> {ts, usd}
  for (let t = t0; t <= t1; t += FIN) {
    while (i < espo.length && espo[i].ts < t + FIN) { ultimo.set(espo[i].m, espo[i]); i++; }
    // Solo le osservazioni fresche: oltre 15 minuti quel mercato non lo sta guardando più nessuno,
    // e trascinarlo avanti sarebbe inventare copertura che non è stata misurata.
    let mercati = 0; let usd = 0; let visti = 0;
    for (const [, v] of ultimo) {
      if (t + FIN - v.ts > 3 * FIN) continue;
      visti++;
      if (v.usd > 0) { mercati++; usd += v.usd; }
    }
    if (visti > 0) serieBC.push({ ts: t + FIN, mercati, usd: +usd.toFixed(2), osservati: visti });
  }
}

// ── D · PnL dal log del guardiano ───────────────────────────────────────────────────────────────
const seriePnl = [];
{
  const RE = /^(\S+Z) \[agent43-guardian\] ok — PnL ([+-][\d.]+) USD \(([+-][\d.]+)%\) · baseline \$([\d.]+) → \$([\d.]+)/;
  // ⚠ SI LEGGONO I VALORI ESPLICITI, non si ricalcolano da baseline/adesso: sono i numeri su cui il
  // guardiano ha DECISO, e sono già nella riga. Ricavarli per differenza aggiunge un passaggio che può
  // sbagliare senza dirlo — la prima stesura di questo script lo faceva e produceva `null`.
  const RES = /^(\S+Z) \[agent43-guardian\] SCATTO: superate: .*?\(([+-][\d.]+)% .*?\(([+-][\d.]+)USD/;
  perRiga(LOG_GUARDIAN, (l) => {
    let m = RE.exec(l);
    if (m) {
      seriePnl.push({ ts: Date.parse(m[1]), pnl: Number(m[2]), pct: Number(m[3]),
        baseline: Number(m[4]), totale: Number(m[5]), scatto: false });
      return;
    }
    m = RES.exec(l);
    if (m) {
      const bt = /Baseline \$([\d.]+) → adesso \$([\d.]+)/.exec(l);
      seriePnl.push({ ts: Date.parse(m[1]), pnl: Number(m[3]), pct: Number(m[2]),
        baseline: bt ? Number(bt[1]) : null, totale: bt ? Number(bt[2]) : null, scatto: true });
    }
  });
  seriePnl.sort((a, b) => a.ts - b.ts);
}

// ── E · NASCITE con nozionale, da execution-audit (18 giorni) ───────────────────────────────────
// Serve solo a dire quanto indietro va la STRUMENTAZIONE, non a ricostruire il book.
const nascite = [];
perRiga(EXEC, (l) => {
  if (l.indexOf('"intent"') < 0) return;
  let j; try { j = JSON.parse(l); } catch { return; }
  if (j.kind !== 'intent') return;
  const n = Number(j.notionalUsd);
  nascite.push({ ts: j.ts, usd: Number.isFinite(n) ? n : null,
    src: (j.decision && j.decision.source) || null,
    byHand: j.decision ? j.decision.byHand === true : null });
});
nascite.sort((a, b) => a.ts - b.ts);

const meta = {
  generatoIso: new Date().toISOString(),
  righeGiornaleLette: righeLette,
  serieA: { n: serieA.length, da: serieA.length ? new Date(serieA[0].ts).toISOString() : null,
    a: serieA.length ? new Date(serieA[serieA.length - 1].ts).toISOString() : null,
    fonte: 'polymarket-maker-audit.jsonl · manual-list con requested.marketId null · response.count',
    tipo: 'osservazione diretta' },
  serieBC: { n: serieBC.length, finestraMs: FIN,
    da: serieBC.length ? new Date(serieBC[0].ts).toISOString() : null,
    a: serieBC.length ? new Date(serieBC[serieBC.length - 1].ts).toISOString() : null,
    fonte: 'polymarket-maker-audit.jsonl · auto-reprice · observed.esposizioneOrdiniUsd per mercato',
    tipo: 'ricostruzione per mercato, ultima osservazione fresca entro 15 min' },
  seriePnl: { n: seriePnl.length,
    da: seriePnl.length ? new Date(seriePnl[0].ts).toISOString() : null,
    a: seriePnl.length ? new Date(seriePnl[seriePnl.length - 1].ts).toISOString() : null,
    fonte: 'pm2 agent43-guardian-out.log · riga «ok — PnL …»', tipo: 'osservazione diretta, 30 s' },
  nascite: { n: nascite.length,
    da: nascite.length ? new Date(nascite[0].ts).toISOString() : null,
    a: nascite.length ? new Date(nascite[nascite.length - 1].ts).toISOString() : null,
    fonte: 'execution-audit.jsonl · kind=intent', tipo: 'solo NASCITE: non ricostruisce il book' },
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'serie-copertura.json'),
  JSON.stringify({ meta, serieA, serieBC, seriePnl, nascite }, null, 0));
console.log(JSON.stringify(meta, null, 1));
