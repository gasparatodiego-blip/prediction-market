'use strict';
// lib/safety/catena-sostituzioni.test.js — IL TETTO DELLA CATENA NON DEVE MURARE UNA GAMBA VIVA.
//
// ═══ IL DIFETTO, MISURATO ═══════════════════════════════════════════════════════════════════════════
// Il fix di idempotenza del 9 agosto 2026 (§5 punto 42) fa sì che una gamba CANCELLATA non bruci più la
// sua chiave: il piazzamento che la sostituisce ne riceve una nuova, derivata dall'id dell'ordine morto.
// Le sostituzioni formano quindi una CATENA, e la catena aveva un tetto di 64 anelli.
//
// Alle 08:10 dello stesso giorno la gamba di uscita su Dallas (SELL 39,7 @ 0,54) aveva una catena di
// ESATTAMENTE 64 anelli — misurata sul giornale vero — cioè murata contro il tetto:
//
//   AUTO-CLOSE FALLITA · NO SELL 39.7 @ 0.54 su carico 0.53 (+1c/share)
//   gate=idempotent-duplicate … (catena di sostituzioni oltre 64 anelli)
//
// Il riposizionamento del punto 54 lo calcolava correttamente — +1% dal carico, dentro banda, sopra il
// carico — e veniva rifiutato per la lunghezza della catena, non per un motivo di sicurezza.
//
// PERCHÉ CRESCE COSÌ IN FRETTA: un'uscita a riposo viene ricancellata e ripiazzata a ogni giro di
// auto-close (~65 s) quando il mid si muove. Un anello al minuto: 64 anelli sono poco più di un'ora.
//
// ═══ COSA SI VERIFICA ═══════════════════════════════════════════════════════════════════════════════
//   1 · una catena lunga come quella vera si percorre fino in fondo, e il piazzamento passa
//   2 · IL BUG ORIGINALE NON SI RIAPRE: un ordine ancora VIVO blocca, a qualunque profondità
//   3 · il tetto esiste ancora e continua a RIFIUTARE quando lo si supera (fail-closed)
//   4 · tutti gli altri rifiuti fail-closed sono intatti
//   5 · il costo di una catena lunga è misurato, non supposto

const path = require('path');
const EA = require('./execution-audit');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

// La gamba VERA dell'incidente: l'uscita su Dallas che il riposizionamento voleva piazzare.
const TOKEN_NO = '91433698379664200222360577652614060123582985715518781251848783830290055752665';
const GAMBA = { userId: 'operator', venue: 'polymarket', tokenId: TOKEN_NO, market: TOKEN_NO,
  side: 'SELL', price: 0.54, size: 39.7 };
const BASE = EA.deriveIdempotencyKey(GAMBA);

/**
 * Costruisce un giornale finto con una catena di `anelli` sostituzioni, tutte MORTE tranne — se
 * `ultimoVivo` — l'ultima. Restituisce le righe e l'insieme degli ordini vivi sul venue.
 */
function giornale(anelli, { ultimoVivo = false } = {}) {
  const righe = [];
  const vivi = new Set();
  let k = BASE;
  for (let i = 0; i < anelli; i++) {
    const orderId = `0xord${String(i).padStart(6, '0')}`;
    righe.push({ kind: 'intent', idempotencyKey: k });
    righe.push({ kind: 'outcome', idempotencyKey: k, ok: true, orderId });
    if (ultimoVivo && i === anelli - 1) vivi.add(orderId);
    k = EA.chiaveDopoOrdineMorto(k, orderId);
  }
  return { righe, vivi, codaAttesa: k };
}

/** `risolviDuplicato` con il giornale iniettato: nessun file, nessuna rete. */
function risolvi(righe, vivi) {
  return EA.risolviDuplicato(BASE, { vivi }, {
    fs: { readFileSync: () => righe.map((r) => JSON.stringify(r)).join('\n') },
    auditFile: path.join('/non/esiste', 'execution-audit.jsonl'),
  });
}

console.log('── 1 · UNA CATENA LUNGA COME QUELLA VERA SI PERCORRE FINO IN FONDO');
{
  // 64 anelli: esattamente la lunghezza che alle 08:10 murava Dallas.
  const g = giornale(64);
  const r = risolvi(g.righe, g.vivi);
  ok('con 64 anelli il piazzamento passa', r.superabile === true, r.motivo);
  ok('  e la chiave è la coda della catena, non una inventata', r.chiave === g.codaAttesa, String(r.chiave).slice(0, 22));

  // E molto oltre: due settimane di ricambio continuo a un anello al minuto.
  for (const n of [500, 5000, 19_999]) {
    const gg = giornale(n);
    const rr = risolvi(gg.righe, gg.vivi);
    ok(`con ${n} anelli passa ancora`, rr.superabile === true && rr.chiave === gg.codaAttesa, rr.motivo.slice(0, 60));
  }
}

console.log('\n── 2 · IL BUG ORIGINALE NON SI RIAPRE: UN ORDINE VIVO BLOCCA, A QUALUNQUE PROFONDITÀ');
{
  // È LA PARTE CHE CONTA. Alzare il tetto non deve rendere ripiazzabile niente che prima non lo fosse:
  // la protezione non è il tetto, è la verifica che l'ordine precedente sia MORTO — e vale a ogni anello.
  for (const n of [1, 64, 500, 5000]) {
    const g = giornale(n, { ultimoVivo: true });
    const r = risolvi(g.righe, g.vivi);
    ok(`catena di ${n} con l'ultimo ordine VIVO ⇒ rifiuto`, r.superabile === false && r.chiave === null, r.motivo.slice(0, 70));
    ok('  e il motivo dice che sarebbe un doppio invio', /doppio invio/.test(r.motivo));
  }

  // Due tentativi che superano lo STESSO ordine morto restano duplicati fra loro: la protezione
  // anti-doppio-invio sopravvive intera anche dentro una catena lunga.
  const g = giornale(100);
  const primo = risolvi(g.righe, g.vivi);
  const conPrimo = g.righe.concat([{ kind: 'intent', idempotencyKey: primo.chiave }]);
  const secondo = EA.risolviDuplicato(BASE, { vivi: g.vivi }, {
    fs: { readFileSync: () => conPrimo.map((r) => JSON.stringify(r)).join('\n') }, auditFile: 'x',
  });
  ok('due tentativi sullo stesso anello non producono la stessa chiave due volte',
    secondo.chiave !== primo.chiave, `${String(primo.chiave).slice(0, 16)} vs ${String(secondo.chiave).slice(0, 16)}`);
  // Il secondo non trova un esito per la chiave appena registrata ⇒ invio ambiguo ⇒ fail-closed.
  ok('  e senza un esito leggibile si rifiuta', secondo.superabile === false, secondo.motivo.slice(0, 60));
}

console.log('\n── 3 · IL TETTO ESISTE ANCORA, E CONTINUA A RIFIUTARE');
{
  const g = giornale(20_001);
  const r = risolvi(g.righe, g.vivi);
  ok('oltre il tetto si RIFIUTA, non si passa', r.superabile === false && r.chiave === null);
  ok('  e il motivo dice cosa fare davvero', /giornale va ruotato/.test(r.motivo), r.motivo.slice(0, 90));
  // Il tetto è un guard contro un giornale corrotto, non contro il costo: va dichiarato quanto vale.
  ok('il tetto è dichiarato e realistico', EA.MAX_CATENA === 20_000, String(EA.MAX_CATENA));
}

console.log('\n── 4 · GLI ALTRI RIFIUTI FAIL-CLOSED SONO INTATTI');
{
  const g = giornale(70);
  const senzaVivi = EA.risolviDuplicato(BASE, {}, { fs: { readFileSync: () => '' }, auditFile: 'x' });
  ok('senza l\'insieme degli ordini vivi ⇒ rifiuto', senzaVivi.superabile === false, senzaVivi.motivo.slice(0, 62));
  const arrayNonSet = EA.risolviDuplicato(BASE, { vivi: [] }, { fs: { readFileSync: () => '' }, auditFile: 'x' });
  ok('  un array invece di un Set non basta', arrayNonSet.superabile === false);

  // Un esito senza orderId = invio ambiguo: non si sa se sia partito, quindi non si supera.
  const ambiguo = g.righe.slice(0, 2);
  ambiguo[1] = { kind: 'outcome', idempotencyKey: BASE, ok: true, orderId: null };
  const r = risolvi(ambiguo, new Set());
  ok('un esito senza orderId ⇒ rifiuto (invio ambiguo)', r.superabile === false, r.motivo.slice(0, 62));

  // Nessun intento sulla chiave base: non c'è niente da superare, si usa la chiave così com'è.
  const pulito = risolvi([], new Set());
  ok('senza intenti la chiave base è libera', pulito.superabile === true && pulito.chiave === BASE);
}

console.log('\n── 5 · IL CONFINE ESATTO, E IL COSTO MISURATO');
{
  // IL CONFINE È MAX_CATENA − 1, e vale la pena scriverlo invece di scoprirlo: il ciclo spende
  // un'iterazione per ogni anello TROVATO, e gliene serve una in più per accertare che la coda sia
  // libera. Con esattamente MAX_CATENA anelli le iterazioni finiscono prima di quella conferma, quindi
  // si rifiuta — che è il verso giusto in cui sbagliare, ma non è «passa fino a 20.000».
  const alLimite = giornale(EA.MAX_CATENA);
  ok(`esattamente ${EA.MAX_CATENA} anelli ⇒ ancora rifiuto (il confine utile è ${EA.MAX_CATENA - 1})`,
    risolvi(alLimite.righe, alLimite.vivi).superabile === false);

  const g = giornale(EA.MAX_CATENA - 1);
  const t0 = process.hrtime.bigint();
  const r = risolvi(g.righe, g.vivi);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(`${EA.MAX_CATENA - 1} anelli si percorrono in meno di 2 secondi`, ms < 2000, `${ms.toFixed(0)} ms`);
  ok('  e il risultato è corretto', r.superabile === true && r.chiave === g.codaAttesa);
}

console.log(`\n${falliti === 0 ? 'TUTTI VERDI' : 'ROSSI'}: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);
