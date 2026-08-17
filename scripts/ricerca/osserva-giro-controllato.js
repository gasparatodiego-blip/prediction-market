#!/usr/bin/env node
'use strict';
/**
 * L'OSSERVATORE DEL GIRO CONTROLLATO — sola lettura, un mercato solo.
 *
 * LA RICHIESTA (operatore, 17 agosto 2026): «un secondo osservatore che registra ogni evento sulle due
 * gambe: nascita, riprezzo, morte con motivo, fill totale o parziale, e ogni decisione della scala con
 * il gradino e il prezzo. Voglio poter ricostruire tutto dopo senza chiedertelo.»
 *
 * ⚠ NON E' UN SECONDO GIUDIZIO: non ricalcola niente, non decide niente, non tocca il venue. Legge il
 * giornale del maker in coda (`tail -f` logico) e riscrive gli eventi che riguardano UN mercato in una
 * riga leggibile, in ordine di tempo, su un file suo. Se un giorno il suo racconto e quello del bot
 * divergessero, ha ragione il bot: questo file e' una vista, non una fonte.
 *
 * ⚠ PERCHE' SERVE, VISTO CHE IL GIORNALE C'E' GIA': perche' il giornale del 16 agosto porta 92.863
 * righe di cui l'immensa maggioranza non riguarda le due gambe, e la ricostruzione di ieri ha richiesto
 * uno script dedicato scritto DOPO. Qui si scrive DURANTE, su un mercato solo, cosi' che «cosa e'
 * successo alle 14:32» sia una riga da leggere invece di un'analisi da rifare.
 *
 * ⚠ E REGISTRA ANCHE I NON-EVENTI CHE CONTANO: `auto-close` con `urgenzaLivello` (la scala e' stata
 * VALUTATA, e a quale gradino), `sorveglianza-valutazione` (la scala NON e' stata valutata),
 * `presa-di-profitto`, `ripristino-gamba`. Il 16 agosto la domanda a cui non si e' potuto rispondere
 * era proprio «quando e' stata valutata la scala?», perche' nessuno lo scriveva in un posto solo.
 *
 * Uso:
 *   node scripts/ricerca/osserva-giro-controllato.js <conditionId>            # segue in continuo
 *   node scripts/ricerca/osserva-giro-controllato.js <conditionId> --da-capo  # rilegge tutto il giorno
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const GIORNALE = path.join(DATA, 'polymarket-maker-audit.jsonl');

const MERCATO = String(process.argv[2] || '').trim().toLowerCase();
const DA_CAPO = process.argv.includes('--da-capo');
if (!/^0x[0-9a-f]{64}$/.test(MERCATO)) {
  console.error('uso: node scripts/ricerca/osserva-giro-controllato.js <conditionId 0x…64hex> [--da-capo]');
  process.exit(2);
}
const CID = `cid_${MERCATO.replace(/^0x/, '')}`;
const OUT = path.join(DATA, 'ricerca', `giro-controllato-${MERCATO.slice(0, 10)}.jsonl`);
const VISTA = path.join(DATA, 'ricerca', `giro-controllato-${MERCATO.slice(0, 10)}.md`);

const ora = (ts) => new Date(ts).toISOString().slice(11, 23);
const c = (p) => (typeof p === 'number' && Number.isFinite(p) ? `${(p * 100).toFixed(2)}¢` : '—');

/** Le famiglie che riguardano le due gambe. Tutto il resto si ignora, ed e' il punto. */
function classifica(o) {
  const op = String(o.op || ''); const es = String(o.outcome || '');
  const req = o.requested || {}; const obs = o.observed || {};

  if (op === 'manual-place' && es === 'sent') {
    return { tipo: 'NASCITA', gamba: req.book, testo: `${req.side} ${req.book} ${req.size} @ ${c(req.price)} ($${req.notionalUsd})`, orderId: o.orderId };
  }
  if (op === 'manual-place' && es === 'dry-run-validated') {
    // ⚠ NON E' UN RIFIUTO, ed etichettarlo cosi' renderebbe illeggibile la fase di prova: l'ordine e'
    // stato costruito, firmato e fatto validare dal venue, poi scartato prima della POST.
    return { tipo: 'PROVA (dry-run)', gamba: req.book, testo: `${req.side} ${req.book} ${req.size} @ ${c(req.price)} — costruito e validato, NON inviato` };
  }
  if (op === 'manual-place' && /^reject/.test(es)) {
    return { tipo: 'RIFIUTO', gamba: req.book, testo: `${o.gate || es} — ${String(o.reason || '').slice(0, 120)}` };
  }
  if (op === 'manual-replace' && es === 'sent') {
    return { tipo: 'RIPREZZO', gamba: req.book, testo: `${c(req.price)} × ${req.size}`, orderId: (o.response || {}).newOrderId, da: req.orderId };
  }
  if (op === 'manual-replace' && o.response && o.response.oldCancelled === true && o.response.replaced === false) {
    // ⚠ LA RIGA PIU' IMPORTANTE DI TUTTE, ed e' la causa del 68% dei minuti di gamba singola di ieri
    // (§5.2 p.38): il riprezzo ha CANCELLATO e non ha ripiazzato. Si marca a parte per non doverla
    // cercare fra i riprezzi riusciti.
    return { tipo: '⚠ CANCELLA-E-NON-RIPIAZZA', gamba: req.book, testo: `gate ${o.response.gate || es} — la gamba e' USCITA dal libro` };
  }
  if (op === 'manual-cancel' && es === 'ok') return { tipo: 'MORTE', testo: `cancellata da ${o.source}`, orderId: (o.requested || {}).orderId };
  if (op === 'order-vanished') return { tipo: 'MORTE', testo: `${es} — ${String(o.reason || '').slice(0, 100)}`, orderId: o.orderId };

  if (op === 'auto-close') {
    // La scala: si registra SEMPRE che e' stata valutata, con il gradino e il prezzo. E' la domanda a
    // cui il 16 agosto non si e' potuto rispondere.
    const g = obs.urgenzaLivello != null ? obs.urgenzaLivello : o.urgenzaLivello;
    const pezzi = [];
    if (g != null) pezzi.push(`gradino ${g}${obs.urgenzaMin != null ? ` (${obs.urgenzaMin} min scoperta)` : ''}`);
    if (o.price != null || obs.price != null) pezzi.push(`prezzo ${c(o.price != null ? o.price : obs.price)}`);
    if (obs.peggiorativa === true) pezzi.push('PEGGIORATIVA');
    return { tipo: 'SCALA', gamba: obs.book || o.book, testo: `${es}${pezzi.length ? ' · ' + pezzi.join(' · ') : ''} — ${String(o.reason || '').slice(0, 110)}` };
  }
  if (op === 'sorveglianza-valutazione') {
    return { tipo: '⚠ NON VALUTATA', testo: `${es} — ${String(o.reason || '').slice(0, 140)}` };
  }
  if (op === 'rimpiazzo-gamba' || op === 'ripristino-gamba') {
    return { tipo: 'RIPRISTINO', testo: `${es} — ${String(o.reason || '').slice(0, 130)}` };
  }
  if (op === 'ritenta-residuo') return { tipo: 'RESIDUO', testo: `${es} — ${String(o.reason || '').slice(0, 110)}` };
  return null;
}

let scritte = 0;
const fluss = fs.createWriteStream(OUT, { flags: 'a' });

function emetti(o, k) {
  const riga = { ts: o.ts, ora: ora(o.ts), tipo: k.tipo, gamba: k.gamba || null,
    testo: k.testo, orderId: k.orderId || null, da: k.da || null, op: o.op, outcome: o.outcome };
  fluss.write(JSON.stringify(riga) + '\n');
  scritte++;
  const testo = `${riga.ora}  ${k.tipo.padEnd(26)} ${String(k.gamba || '').padEnd(4)} ${k.testo}`;
  // Il rosso solo dove serve: se lo si mette ovunque smette di voler dire qualcosa.
  console.log(k.tipo.startsWith('⚠') ? `\x1b[31m${testo}\x1b[0m` : testo);
}

/** Una passata sul file dal byte `da` in poi. Restituisce il nuovo offset. */
async function passata(da) {
  const st = fs.statSync(GIORNALE);
  if (st.size <= da) return da;                       // niente di nuovo (o rotazione: vedi sotto)
  const rl = readline.createInterface({ input: fs.createReadStream(GIORNALE, { start: da }), crlfDelay: Infinity });
  for await (const l of rl) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (!Number.isFinite(o.ts)) continue;
    // Il filtro sul mercato: `marketRef` in chiaro, o l'orderId di una gamba che conosciamo gia'.
    const ref = String(o.marketRef || '');
    const suoMercato = ref === CID || ref.includes(MERCATO.replace(/^0x/, ''));
    if (!suoMercato && !nostriOrdini.has(String((o.requested || {}).orderId || o.orderId || ''))) continue;
    const k = classifica(o);
    if (!k) continue;
    if (k.orderId) nostriOrdini.add(String(k.orderId));
    emetti(o, k);
  }
  return st.size;
}

// Gli orderId che appartengono a questo mercato: molte righe (cancellazioni, sparizioni) portano
// l'orderId ma NON il marketId, che nel giornale del venue e' redatto. Si impara chi e' nostro dalle
// nascite e lo si usa per attribuire le morti — la stessa tecnica della ricostruzione del 16 agosto.
const nostriOrdini = new Set();

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  console.log(`osservatore sul mercato ${MERCATO}`);
  console.log(`giornale ${path.relative(ROOT, GIORNALE)} → ${path.relative(ROOT, OUT)}`);
  console.log(`${DA_CAPO ? 'rilettura DA CAPO' : 'si parte dalla coda: solo gli eventi da adesso'}\n`);

  let off = DA_CAPO ? 0 : fs.statSync(GIORNALE).size;
  if (DA_CAPO) off = await passata(0);

  const tic = async () => {
    try {
      const st = fs.statSync(GIORNALE);
      // ⚠ LA ROTAZIONE: il giornale ruota sopra i 400 MB (§4.10). Se il file si e' ACCORCIATO, e'
      // ruotato e si riparte da zero — altrimenti l'osservatore resterebbe muto per sempre senza
      // dirlo, che e' il modo peggiore di fallire per un osservatore.
      if (st.size < off) { console.log('— giornale ruotato: si riparte dall inizio del file nuovo —'); off = 0; }
      off = await passata(off);
    } catch (e) { console.error(`lettura fallita (si riprova): ${e.message}`); }
  };
  setInterval(tic, 2_000);

  const chiudi = () => {
    const testa = `# Giro controllato · ${MERCATO}\n\nOsservatore avviato ${new Date().toISOString()},`
      + ` ${scritte} eventi registrati.\nRighe grezze in \`${path.basename(OUT)}\`.\n`;
    try { fs.writeFileSync(VISTA, testa); } catch { /* nulla */ }
    console.log(`\n${scritte} eventi scritti in ${path.relative(ROOT, OUT)}`);
    process.exit(0);
  };
  process.on('SIGINT', chiudi);
  process.on('SIGTERM', chiudi);
})();
