#!/usr/bin/env node
'use strict';
// scripts/verifica-catena-rewards.js — LA PROVA IN SIMULAZIONE DEI TRE COMPORTAMENTI CHIESTI
// DALL'OPERATORE, senza soldi, senza chiavi, senza rete, senza venue.
//
//   node scripts/verifica-catena-rewards.js
//
// ═══ PERCHÉ ESISTE, VISTO CHE scripts/ È PIENO DI SELFCHECK ══════════════════════════════════════
// I selfcheck storici (maker-selfcheck, maker-auto-reprice-selfcheck, maker-auto-close-selfcheck,
// maker-mid-chase-selfcheck, maker-unified-selfcheck) sono rimasti indietro rispetto a `lib/`:
// portano ancora la lettura DIMEZZATA della banda premiante (`v = maxSpread/2`) che §5-bis p.155 ha
// dimostrato sbagliata, e maker-auto-close chiama `AC.closeTargetPrice`, una funzione che non esiste
// più. Le loro fixture furono tarate su un raggio che oggi vale il doppio, quindi FALLISCONO PERCHÉ
// IL CODICE È CORRETTO — la stessa classe di §5.3 «test che fotografa il codice invece della
// proprietà». Non si ammorbidiscono e non si toccano qui: questo file prova le tre proprietà contro
// il codice di ADESSO, con le funzioni vere.
//
// ═══ COSA PROVA ══════════════════════════════════════════════════════════════════════════════════
//   A · su DUE mercati, il bid e l'ask nascono alla STESSA distanza dal mid, dentro la banda che
//       paga, e nessuno dei due sta primo sul libro;
//   B · un ordine dentro la banda NON viene toccato; quando il mid si sposta e l'ordine esce, il
//       riprezzo scatta — dopo conferma — e il prezzo nuovo torna dentro la banda;
//   C · dopo un fill SIMULATO: la modalità chiusura si apre, l'esposizione è misurata sul fill vero,
//       la riconciliazione col venue non conta due volte lo stesso volume, e la chiusura produce un
//       ordine con un prezzo che non regala il carico.
//
// ═══ PERCHÉ NON PUÒ PIAZZARE NIENTE ══════════════════════════════════════════════════════════════
//   1. non importa NESSUN modulo sotto `lib/venues/` — e §6 in fondo lo verifica camminando
//      `require.cache` a fine corsa, quindi è una misura e non una promessa;
//   2. non apre socket, non legge `.env`, non tocca `data/`: ogni stato vive in una temp cancellata
//      alla fine;
//   3. asserisce in testa che `MAKER_MODE` non sia una modalità viva e che il dry-run sia acceso.
//
// ═══ LA DISTANZA SCELTA DALL'OPERATORE ═══════════════════════════════════════════════════════════
// «La più esterna possibile che resti dentro la banda premiante.» È la manopola di §5-bis p.158,
// `MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V`, al suo massimo: `FRAZIONE_MASSIMA = 0,95` di `v`. Oltre non
// si va per costruzione — a `s = v` il punteggio del venue è ZERO, quindi il bordo esatto non è una
// posizione, è una rinuncia. Il costo è dichiarato e NON viene ottimizzato qui: `S = ((v−s)/v)²`, a
// 0,95·v vale 0,0025, cioè ~0,4% del punteggio che lo stesso capitale otterrebbe a un tick dal mid.
// L'operatore lo sa e lo ha scelto.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── LA MANOPOLA, PRIMA DI QUALUNQUE require CHE LA LEGGA ────────────────────────────────────────
// `planBehindBest` legge l'ambiente al momento della chiamata, non all'import; la si fissa qui lo
// stesso, perché il valore su cui gira la prova dev'essere quello scritto nel referto, non quello
// che capita di avere nella shell.
const FRAZIONE = '0.95';
process.env.MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V = FRAZIONE;

const { prezzoInCoda } = require('../lib/maker/prezzo-in-coda');
const { raggioBandaCents, dentroBanda, punteggio } = require('../lib/banda-premiante');
const { FRAZIONE_MASSIMA, leggiFrazione } = require('../lib/maker/distanza-obiettivo');
const { decideReprice } = require('../lib/maker/auto-reprice');
const { loadAutoRepriceTuning } = require('../lib/maker/auto-reprice-config');
const AC = require('../lib/maker/auto-close');
const MC = require('../lib/maker/modalita-chiusura');
const RAF = require('../lib/maker/risposta-al-fill');
const F = require('../lib/safety/fills');
const RF = require('../lib/safety/reconcile-fills');

let passati = 0; let falliti = 0;
const ok = (c, m) => { if (c) { passati++; console.log('  ✓ ' + m); } else { falliti++; console.log('  ✗ ' + m); } };
const sez = (t) => console.log('\n══ ' + t + ' ' + '═'.repeat(Math.max(0, 92 - t.length)));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'catena-rewards-'));
let seq = 0;
const tmp = (n) => path.join(TMP, `${n}-${process.pid}-${seq++}`);
const c = (x) => +(x * 100).toFixed(3);          // prezzo → centesimi
const dist = (prezzo, mid) => +(Math.abs(prezzo - mid) * 100).toFixed(3);

// ═══ I DUE MERCATI — il tetto chiesto dall'operatore, e non uno di più ═══════════════════════════
// Fittizi di proposito: un id di mercato vero renderebbe la prova dipendente da un board vivo, cioè
// non ripetibile. Le forme sono quelle che `resolveMarketRules`/`resolveMarketDepth` consegnano.
const MERCATI = [
  { id: 'SIM-1', mid: 0.500, tick: 0.001, maxSpreadCents: 4.5, minSize: 50 },
  { id: 'SIM-2', mid: 0.320, tick: 0.001, maxSpreadCents: 3.0, minSize: 50 },
];

function regole(m, midOverride = null) {
  const mid = midOverride == null ? m.mid : midOverride;
  return {
    readable: true, missing: [], marketId: m.id, title: m.id,
    mid, tick: m.tick, maxSpreadCents: m.maxSpreadCents, minSize: m.minSize,
    tokenId: `${m.id}-YES`, tokenIdNo: `${m.id}-NO`, negRisk: false,
    bandRadiusCents: raggioBandaCents(m.maxSpreadCents),
    feedLive: true, feedAgeSec: 1, midSource: 'live-book', midAgeSec: 1,
    books: {
      yes: { tokenId: `${m.id}-YES`, scoringMid: mid },
      no: { tokenId: `${m.id}-NO`, scoringMid: +(1 - mid).toFixed(6) },
    },
  };
}

// Un libro con concorrenti VICINI al mid su entrambi i lati: è la condizione in cui «mai primo sul
// libro» morde davvero (un tick dietro resta dentro la banda) e la manopola ha spazio per spingere
// fuori. Un libro vuoto proverebbe il ramo «soli», che è un altro caso.
function profondita(m, midOverride = null) {
  const mid = midOverride == null ? m.mid : midOverride;
  const t = m.tick;
  const lato = (centro) => ({
    bids: [{ price: +(centro - 2 * t).toFixed(6), size: 200 }, { price: +(centro - 3 * t).toFixed(6), size: 300 }],
    asks: [{ price: +(centro + 2 * t).toFixed(6), size: 200 }, { price: +(centro + 3 * t).toFixed(6), size: 300 }],
  });
  return { yes: lato(mid), no: lato(+(1 - mid).toFixed(6)) };
}

// ═══ 0 · LE PRECONDIZIONI DI SICUREZZA ══════════════════════════════════════════════════════════
sez('0 · PRECONDIZIONI — questa prova non può toccare capitale');
{
  const modo = String(process.env.MAKER_MODE || 'off').toLowerCase();
  ok(modo !== 'live' && modo !== 'on',
    `MAKER_MODE = «${modo}»: nessuna modalità viva (live/on sarebbero le uniche che aprono la strada al venue)`);
  ok(!process.env.MAKER_FUNDING_APPROVED || process.env.MAKER_FUNDING_APPROVED === 'false',
    'MAKER_FUNDING_APPROVED non attesta niente in questo processo');
  ok(leggiFrazione(process.env) === FRAZIONE_MASSIMA,
    `la manopola chiesta (${FRAZIONE}) è la più esterna ammessa: FRAZIONE_MASSIMA = ${FRAZIONE_MASSIMA} di v`);
  ok(MERCATI.length <= 2, `mercati sotto prova: ${MERCATI.length} — il tetto chiesto è 2`);
}

// ═══ A · IL PIAZZAMENTO SUI DUE LATI, ALLA STESSA DISTANZA DAL MID ══════════════════════════════
sez('A · piazzamento — bid e ask alla STESSA distanza dal mid, il più esterno che resta in banda');
const esitiA = [];
for (const m of MERCATI) {
  const R = regole(m); const D = profondita(m);
  const v = raggioBandaCents(m.maxSpreadCents);
  console.log(`\n  — ${m.id}: mid ${c(m.mid)}¢, tick ${c(m.tick)}¢, banda v = ${v}¢ ⇒ [${c(m.mid) - v}¢ · ${c(m.mid) + v}¢]`);

  // I due lati LETTERALI dello stesso libro: il bid (BUY) e l'ask (SELL).
  const bid = prezzoInCoda({ book: 'yes', side: 'BUY', rules: R, depth: D });
  const ask = prezzoInCoda({ book: 'yes', side: 'SELL', rules: R, depth: D });
  ok(bid.ok === true && ask.ok === true, `${m.id}: entrambi i lati producono un prezzo (bid ${bid.price} · ask ${ask.price})`);
  if (!bid.ok || !ask.ok) { console.log('     bid:', bid.reason, '| ask:', ask.reason); continue; }

  const dB = dist(bid.price, m.mid); const dA = dist(ask.price, m.mid);
  ok(Math.abs(dB - dA) < 1e-6, `${m.id}: la distanza dal mid è la STESSA sui due lati — bid ${dB}¢ · ask ${dA}¢`);
  ok(bid.price < m.mid && ask.price > m.mid, `${m.id}: il bid sta sotto il mid e l'ask sopra — nessun lato ribaltato`);
  ok(dentroBanda(dB, m.maxSpreadCents) && dentroBanda(dA, m.maxSpreadCents),
    `${m.id}: entrambi DENTRO la banda premiante (${dB}¢ ≤ ${v}¢)`);
  ok(bid.onTop === false && ask.onTop === false,
    `${m.id}: nessuno dei due è primo sul libro (miglior altrui bid ${bid.bestOther} · ask ${ask.bestOther})`);

  // La distanza è la PIÙ ESTERNA ammessa: la manopola l'ha spostata fin dove poteva, e un tick più
  // in là sarebbe fuori banda. Questa è la proprietà che l'operatore ha chiesto.
  const unTickOltre = dB + c(m.tick);
  ok(bid.distanzaObiettivo && bid.distanzaObiettivo.spostato === true,
    `${m.id}: la manopola ha spostato il prezzo verso l'esterno (${bid.distanzaObiettivo && bid.distanzaObiettivo.motivo})`);
  ok(dB >= FRAZIONE_MASSIMA * v - c(m.tick) - 1e-9,
    `${m.id}: la distanza ${dB}¢ è quella richiesta (${(FRAZIONE_MASSIMA * v).toFixed(3)}¢ = ${FRAZIONE_MASSIMA}·v), a meno di un tick di griglia`);
  ok(unTickOltre > FRAZIONE_MASSIMA * v - 1e-9,
    `${m.id}: un tick più all'esterno (${unTickOltre.toFixed(3)}¢) supererebbe il massimo ammesso ${(FRAZIONE_MASSIMA * v).toFixed(3)}¢ e si avvicinerebbe al bordo dove S = 0 — non c'è posto più esterno che paghi ancora`);

  // Il prezzo di questa scelta, dichiarato e non ottimizzato.
  const S = punteggio(dB, m.maxSpreadCents);
  const Suno = punteggio(c(m.tick), m.maxSpreadCents);
  console.log(`     costo dichiarato: S(${dB}¢) = ${S.toFixed(4)} contro S(${c(m.tick)}¢) = ${Suno.toFixed(4)} a un tick dal mid ⇒ ${(S / Suno * 100).toFixed(1)}% del punteggio`);

  // La coppia vera del bot: BUY su YES + BUY su NO. Sono due libri diversi con mid speculari, e la
  // simmetria va verificata rispetto al mid DI CIASCUNO.
  const buyNo = prezzoInCoda({ book: 'no', side: 'BUY', rules: R, depth: D });
  ok(buyNo.ok === true && Math.abs(dist(buyNo.price, R.books.no.scoringMid) - dB) < 1e-6,
    `${m.id}: la coppia BUY-YES + BUY-NO nasce alla stessa distanza dai rispettivi mid (${dist(buyNo.price, R.books.no.scoringMid)}¢)`);
  ok(buyNo.ok && +(bid.price + buyNo.price).toFixed(6) < 1,
    `${m.id}: la coppia costa ${((bid.price + buyNo.price) * 100).toFixed(1)}¢ < 100¢ — lo sconto è la condizione d'ingresso`);

  esitiA.push({ mercato: m.id, bid: bid.price, ask: ask.price, distanzaC: dB, dentroBanda: true, S });
}

// ═══ B · IL RIPREZZO QUANDO IL MID SI MUOVE E L'ORDINE ESCE DALLA BANDA ═════════════════════════
sez('B · riprezzo — fermo dentro la banda, si muove quando ne esce');
const TUN = loadAutoRepriceTuning({});
console.log(`  regolazione viva: conferme ${TUN.confirmSamples} · isteresi ${TUN.hysteresisTicks} tick · intervallo minimo ${TUN.minIntervalMs} ms · tetto orario ${TUN.maxPerHour}`);
const esitiB = [];
for (let i = 0; i < MERCATI.length; i++) {
  const m = MERCATI[i];
  const v = raggioBandaCents(m.maxSpreadCents);
  const prezzoIniziale = esitiA[i] ? esitiA[i].bid : +(m.mid - v / 200).toFixed(6);
  const ordine = { orderId: `${m.id}-O1`, price: prezzoIniziale, size: 60, book: 'yes', side: 'BUY', secondsToExpiry: 800 };
  console.log(`\n  — ${m.id}: ordine a ${c(prezzoIniziale)}¢, mid ${c(m.mid)}¢, banda ±${v}¢`);

  // ① Il mid non si muove ⇒ l'ordine NON viene toccato, e non c'è orologio che cambi la risposta.
  let toccato = false;
  for (let t = 0; t < 240; t++) {
    const d = decideReprice({ order: ordine, rules: regole(m), config: TUN, now: 1e6 + t * 60_000 }, {});
    if (d.action !== 'hold') toccato = true;
  }
  ok(!toccato, `${m.id}: 240 cicli simulati (4 ore) col mid fermo ⇒ l'ordine non viene toccato NEMMENO UNA volta`);

  // ② Il mid cammina via. Si simula il ciclo vero: `consecutiveBreaches` si accumula fuori e si
  //    azzera al rientro, esattamente come fa `runAutoRepriceCycle`.
  const midMosso = +(m.mid + (v + 2) / 100).toFixed(6);   // 2¢ oltre il bordo: uscita non ambigua
  let breaches = 0; let decisione = null; let giri = 0;
  while (giri < 10 && (!decisione || decisione.action !== 'reprice')) {
    decisione = decideReprice({ order: ordine, rules: regole(m, midMosso), config: TUN, now: 1e6 + giri * 60_000, consecutiveBreaches: breaches }, {});
    if (decisione.action !== 'reprice') breaches++;
    giri++;
  }
  ok(decisione && decisione.action === 'reprice',
    `${m.id}: mid ${c(m.mid)}¢ → ${c(midMosso)}¢ (distanza ${decisione && decisione.distanceC}¢ > ${v}¢) ⇒ RIPREZZO, dopo ${giri} osservazioni`);
  ok(giri === TUN.confirmSamples,
    `${m.id}: il riprezzo arriva alla ${TUN.confirmSamples}ª osservazione, non alla prima — una lettura sola non muove un ordine vero`);
  const dNuovo = decisione && decisione.targetPrice != null ? dist(decisione.targetPrice, midMosso) : null;
  ok(dNuovo != null && dentroBanda(dNuovo, m.maxSpreadCents),
    `${m.id}: il prezzo nuovo ${decisione && c(decisione.targetPrice)}¢ è a ${dNuovo}¢ dal mid nuovo — DENTRO la banda`);
  ok(dNuovo != null && dNuovo >= v - c(m.tick) * (TUN.hysteresisTicks + 1) - 1e-9,
    `${m.id}: e resta al BORDO INTERNO (${dNuovo}¢ su ${v}¢), cioè la posizione più esterna che paga — la stessa politica del piazzamento`);
  ok(decisione && decisione.targetPrice < midMosso,
    `${m.id}: il riprezzo NON ribalta il lato: l'ordine era sotto il mid e ci resta`);

  // ③ Fail-closed: un mid che non viene dal libro vivo non muove niente.
  const R2 = regole(m, midMosso); R2.midSource = 'board-row';
  const cieco = decideReprice({ order: ordine, rules: R2, config: TUN, now: 1e6, consecutiveBreaches: 9 }, {});
  ok(cieco.action === 'skip' && cieco.gate === 'mid-not-live',
    `${m.id}: con un mid di seconda mano l'ordine NON si tocca (gate «${cieco.gate}») anche con 9 violazioni alle spalle`);

  // ④ Fail-closed: regole illeggibili.
  const rotte = decideReprice({ order: ordine, rules: { readable: false, missing: ['tick'] }, config: TUN, now: 1e6, consecutiveBreaches: 9 }, {});
  ok(rotte.action === 'skip' && rotte.gate === 'rules-unreadable',
    `${m.id}: regole di venue illeggibili ⇒ nessun movimento (gate «${rotte.gate}»)`);

  esitiB.push({ mercato: m.id, da: prezzoIniziale, a: decisione && decisione.targetPrice, osservazioni: giri });
}

// ═══ C · DOPO UN FILL SIMULATO ══════════════════════════════════════════════════════════════════
sez('C · dopo il fill — modalità chiusura, esposizione, riconciliazione, uscita');
{
  const m = MERCATI[0];
  const R = regole(m);
  const TOKEN = R.tokenId;
  const CARICO = esitiA[0] ? esitiA[0].bid : 0.457;
  const SIZE_ORDINE = 120;
  const SIZE_FILLATA = 60;                       // fill PARZIALE: il caso che rompe le cose
  const ORA = Date.UTC(2026, 7, 15, 12, 0, 0);
  console.log(`\n  — fill simulato: BUY ${SIZE_FILLATA}/${SIZE_ORDINE} share di ${TOKEN} a ${c(CARICO)}¢`);

  // ── C0 · IL FILL VIENE CLASSIFICATO, NON DEDOTTO ─────────────────────────────────────────────
  // La gamba YES si riempie per 60 share, la sorella NO è ancora a zero: è una gamba NUDA, cioè
  // esposizione direzionale. È il caso che la catena deve riconoscere per primo.
  const cieco = RAF.classificaFill({ sizePosseduta: SIZE_FILLATA, sizeAltroLato: null });
  ok(cieco.tipo === RAF.IGNOTO,
    `l'altro lato non letto ⇒ tipo «${cieco.tipo}»: «non lo so» non diventa «non ce n'è» (${cieco.motivo.slice(0, 60)}…)`);

  const scoperto = RAF.classificaFill({ sizePosseduta: SIZE_FILLATA, sizeAltroLato: 0 });
  ok(scoperto.tipo === RAF.FILL_COMPLETO && scoperto.manca === SIZE_FILLATA,
    `fill riconosciuto come «${scoperto.tipo}»: ${SIZE_FILLATA} share possedute, 0 di copertura ⇒ mancano ${scoperto.manca} share alla coppia`);

  const parziale = RAF.classificaFill({ sizePosseduta: SIZE_FILLATA, sizeAltroLato: 20 });
  ok(parziale.tipo === RAF.FILL_PARZIALE && parziale.manca === 40,
    `con 20 share già sull'altro lato il fill è «${parziale.tipo}» e ne mancano ${parziale.manca}`);

  const pari = RAF.classificaFill({ sizePosseduta: SIZE_FILLATA, sizeAltroLato: SIZE_FILLATA });
  ok(pari.tipo === RAF.COPPIA_COMPLETA,
    'YES e NO in parti uguali ⇒ «coppia-completa»: non c\'è niente da chiudere, c\'è da fondere');

  // ── C1 · LA MODALITÀ CHIUSURA SI APRE, E SOLO SU UN FILL DICHIARATO ──────────────────────────
  let reg = {};
  const ignoto = MC.entraInChiusura({ registro: reg, marketId: m.id, book: 'yes', tipoFill: RAF.IGNOTO, sizeFillata: SIZE_FILLATA, ora: ORA });
  ok(ignoto.nuova === false && ignoto.voce === null,
    `un fill di tipo IGNOTO non apre la modalità chiusura (${ignoto.motivo}) — «ignoto» non apre niente`);

  const aperta = MC.entraInChiusura({ registro: reg, marketId: m.id, book: 'yes', tipoFill: scoperto.tipo, fillOrdine: SIZE_ORDINE, sizeFillata: SIZE_FILLATA, ora: ORA });
  reg = aperta.registro;
  ok(aperta.nuova === true && aperta.voce && Number(aperta.voce.da) === ORA,
    `un fill dichiarato «${scoperto.tipo}» apre la modalità chiusura e timbra l'istante (${new Date(ORA).toISOString()})`);

  const secondo = MC.entraInChiusura({ registro: reg, marketId: m.id, book: 'yes', tipoFill: scoperto.tipo, fillOrdine: SIZE_ORDINE, sizeFillata: 95, ora: ORA + 60_000 });
  const voce2 = secondo.registro[MC.chiaveChiusura(m.id, 'yes')];
  ok(secondo.nuova === false && voce2 && Number(voce2.da) === ORA,
    'un secondo fill sulla stessa gamba NON riazzera l\'orologio: l\'età della scopertura è quella vera, non quella dell\'ultimo evento');

  // ── C2 · L'ESPOSIZIONE È QUELLA DEL FILL, NON QUELLA DELL'ORDINE ─────────────────────────────
  const fillsFile = tmp('fills.jsonl');
  // `orderId` è l'id dell'ordine DEL VENUE, e va scritto: è la chiave su cui la riconciliazione
  // confronta grandezze omogenee (vedi C3). L'unico scrittore vero di questo registro —
  // `reconcile-fills.applyReconcile` — lo mette sempre; qui si riproduce quella forma.
  F.recordFill({ userId: 'sim', venue: 'polymarket', tokenId: TOKEN, side: 'BUY', filledSize: SIZE_FILLATA,
    filledPrice: CARICO, feeUsd: 0, idempotencyKey: 'sim-k1', orderId: 'VO-1', source: 'verifica', ts: ORA }, { fillsFile });

  const inviati = [{ idempotencyKey: 'sim-k1', orderId: 'VO-1', tokenId: TOKEN, side: 'BUY', price: CARICO, size: SIZE_ORDINE, notionalUsd: +(CARICO * SIZE_ORDINE).toFixed(2), ts: ORA - 1000 }];
  const espParziale = F.computeExposure({ userId: 'sim', now: ORA + 5000, sentOrders: inviati }, { fillsFile });
  const attesoParziale = +(CARICO * SIZE_FILLATA).toFixed(2);
  ok(espParziale.ok && Math.abs(espParziale.openNotionalUsd - attesoParziale) < 0.02,
    `un fill parziale conta al suo nozionale parziale ($${espParziale.openNotionalUsd.toFixed(2)} ≈ $${attesoParziale}), mai arrotondato all'ordine intero ($${(CARICO * SIZE_ORDINE).toFixed(2)})`);

  // ⚠ L'ORDINE INVIATO E NON ANCORA RICONCILIATO NON PESA SULL'ESPOSIZIONE, ED È UNA SCELTA.
  // Il conteggio anticipato è stato tolto il 2 agosto 2026 su richiesta esplicita dell'operatore
  // (`lib/safety/fills.js`, blocco «IL CONTEGGIO ANTICIPATO E' STATO RIMOSSO»): l'esposizione riflette
  // solo ciò che il venue ha confermato. Il rischio accettato è dichiarato lì — fino a 60 secondi in
  // cui il tetto non vede gli ordini appena inviati. `unknowns` resta vuoto PER COSTRUZIONE.
  // ⚠ È esattamente la ragione per cui `scripts/maker-selfcheck.js` §12b è rosso: quel selfcheck
  // asserisce il comportamento di PRIMA e non è mai stato riallineato.
  const fantasma = F.computeExposure({ userId: 'sim', now: ORA + 5000,
    sentOrders: [...inviati, { idempotencyKey: 'FANTASMA', tokenId: TOKEN, side: 'BUY', price: CARICO, size: 100, notionalUsd: 45.7, ts: ORA - 1000 }] }, { fillsFile });
  ok(fantasma.ok && fantasma.openNotionalUsd === espParziale.openNotionalUsd && fantasma.unknowns.length === 0,
    `un ordine inviato ma non riconciliato NON entra nell'esposizione ($${fantasma.openNotionalUsd.toFixed(2)}, invariata): scelta dell'operatore del 2 agosto 2026, col suo rischio dichiarato nel sorgente`);

  // La domanda «è stato risolto dal ledger?» è un'ALTRA domanda, e ha una funzione sua. Se questa
  // tacesse, l'ordine fantasma non lo troverebbe più nessuno.
  const nonRisolti = F.ordiniNonRisolti(
    [...inviati, { idempotencyKey: 'FANTASMA', tokenId: TOKEN, side: 'BUY', price: CARICO, size: 100, notionalUsd: 45.7, ts: ORA - 1000 }],
    F.readFills({ userId: 'sim' }, { fillsFile }).rows);
  ok(nonRisolti.length === 1 && nonRisolti[0].idempotencyKey === 'FANTASMA',
    'ma il ledger lo dichiara NON RISOLTO (ordiniNonRisolti lo elenca): esposizione e risoluzione sono due domande separate, e la seconda non tace');

  const senzaLibro = F.computeExposure({ userId: 'sim', now: ORA + 5000, marks: null }, { fillsFile });
  ok(senzaLibro.ok && senzaLibro.positions[0].markSource === 'entry-notional-floor',
    'un libro illeggibile mette la posizione al PAVIMENTO del carico, mai a zero e mai a un mid inventato');

  // ── C3 · LA RICONCILIAZIONE CONFRONTA GRANDEZZE OMOGENEE ─────────────────────────────────────
  // Il difetto di §5-bis p.72: al riprezzo ogni sostituzione porta una chiave nuova, e confrontare il
  // volume del venue con «quanto risulta per QUESTA chiave» faceva registrare lo stesso fill una volta
  // per ordine. Qui si rigioca esattamente quella sequenza.
  const lettura = F.readFills({ userId: 'sim' }, { fillsFile });
  ok(lettura.ok === true && Array.isArray(lettura.rows) && lettura.rows.length === 1,
    `il registro dei fill si rilegge dal disco: ${lettura.rows.length} riga`);
  const righeLedger = lettura.rows;
  const ordiniVenue = [{ id: 'VO-1', asset_id: TOKEN, side: 'BUY', price: String(CARICO), original_size: String(SIZE_ORDINE), size_matched: String(SIZE_FILLATA) }];

  const nulla = RF.planReconcile({ userId: 'sim', sentOrders: inviati, ledgerRows: righeLedger,
    venueReachable: true, venueOrders: ordiniVenue, tick: m.tick, now: ORA + 10_000 });
  ok(nulla.toRecord.length === 0,
    `il venue conferma ${SIZE_FILLATA} share già a registro ⇒ NIENTE viene registrato una seconda volta`);

  const cresciuto = [{ ...ordiniVenue[0], size_matched: String(SIZE_FILLATA + 25) }];
  const delta = RF.planReconcile({ userId: 'sim', sentOrders: inviati, ledgerRows: righeLedger,
    venueReachable: true, venueOrders: cresciuto, tick: m.tick, now: ORA + 20_000 });
  ok(delta.toRecord.length === 1 && Math.abs(delta.toRecord[0].filledSize - 25) < 1e-9,
    `il venue sale a ${SIZE_FILLATA + 25} ⇒ si registra il SOLO delta (25 share), non il cumulato`);

  // ⚠ NOTA MISURATA, non un fallimento: l'idempotenza qui sopra poggia sul fatto che la riga di
  // ledger porti `orderId`. Una riga SENZA — cioè scritta da un percorso che non conosce l'id del
  // venue — fa ripiegare il confronto su `recordedFilledByKey`, e contro un ordine ANCORA APERTO il
  // ripiego non trova niente: lo stesso volume verrebbe registrato una seconda volta (§5-bis p.72).
  // Verificato per costruzione qui sotto. Oggi non è raggiungibile in produzione: `recordFill` ha un
  // solo chiamante (`applyReconcile`) e quello l'`orderId` lo scrive sempre.
  const senzaId = tmp('fills-senza-id.jsonl');
  F.recordFill({ userId: 'sim', venue: 'polymarket', tokenId: TOKEN, side: 'BUY', filledSize: SIZE_FILLATA,
    filledPrice: CARICO, feeUsd: 0, idempotencyKey: 'sim-k1', orderId: null, source: 'verifica', ts: ORA }, { fillsFile: senzaId });
  const doppio = RF.planReconcile({ userId: 'sim', sentOrders: inviati,
    ledgerRows: F.readFills({ userId: 'sim' }, { fillsFile: senzaId }).rows,
    venueReachable: true, venueOrders: ordiniVenue, tick: m.tick, now: ORA + 15_000 });
  console.log(`     ⚠ nota: con una riga di ledger SENZA orderId lo stesso volume verrebbe registrato di nuovo (${doppio.toRecord.length} riga). Non raggiungibile oggi: l'unico scrittore è applyReconcile, che l'orderId lo mette.`);

  const irraggiungibile = RF.planReconcile({ userId: 'sim', sentOrders: inviati, ledgerRows: righeLedger,
    venueReachable: false, venueOrders: [], tick: m.tick, now: ORA + 30_000 });
  ok(irraggiungibile.toRecord.length === 0 && irraggiungibile.toNoFill.length === 0
    && irraggiungibile.stillUnknown.length === 1,
    'venue irraggiungibile ⇒ nessun fill e nessun NON-fill dedotti: l\'ordine resta IGNOTO (e quindi contato per intero)');

  const senzaIncrocio = RF.planReconcile({ userId: 'sim',
    sentOrders: [{ idempotencyKey: 'sim-k9', orderId: 'VO-9', tokenId: `${m.id}-NO`, side: 'BUY', price: 0.457, size: 60, notionalUsd: 27.42, ts: ORA }],
    ledgerRows: righeLedger, venueReachable: true, venueOrders: [], venueFills: [], venuePositions: null,
    tick: m.tick, now: ORA + 40_000 });
  ok(senzaIncrocio.toNoFill.length === 0 && senzaIncrocio.stillUnknown.length === 1,
    'un ordine sparito dagli aperti con /trades vuoto e NESSUNA lettura delle posizioni non viene dichiarato non-eseguito: servono due letture concordi');

  // ── C4 · LA CHIUSURA PRODUCE UN PREZZO CHE NON REGALA IL CARICO ──────────────────────────────
  const posizione = { tokenId: TOKEN, size: SIZE_FILLATA, avgPrice: CARICO };
  const chiusura = AC.decideClose({ position: posizione, restingOrders: [], rules: R, book: 'yes', now: ORA + 60_000 });
  ok(chiusura.action === 'close' && chiusura.price != null,
    `la chiusura decide un ordine: ${chiusura.action} ${chiusura.size} share a ${c(chiusura.price)}¢ (${chiusura.reason ? String(chiusura.reason).slice(0, 70) : ''}…)`);
  ok(chiusura.price > CARICO,
    `il prezzo di uscita ${c(chiusura.price)}¢ sta SOPRA il carico ${c(CARICO)}¢ (+${chiusura.profitCents}¢/share): l'uscita ordinaria non vende in perdita`);
  ok(chiusura.size === SIZE_FILLATA,
    `si chiude esattamente ciò che si possiede (${chiusura.size} share), non la size dell'ordine originale (${SIZE_ORDINE})`);

  const senzaCarico = AC.decideClose({ position: { tokenId: TOKEN, size: SIZE_FILLATA, avgPrice: null }, restingOrders: [], rules: R, book: 'yes', now: ORA + 60_000 });
  ok(senzaCarico.action === 'skip' && senzaCarico.gate === 'no-entry-price',
    'senza prezzo di carico NON si inventa un\'uscita (gate «no-entry-price»)');

  const chiuso = AC.decideClose({ position: posizione, restingOrders: [], rules: R, book: 'yes', venue: { closed: true }, now: ORA + 60_000 });
  ok(chiuso.action === 'skip' && chiuso.gate === 'market-closed',
    'su un mercato CHIUSO al venue non si tenta nessuna vendita: la posizione si riscatta (gate «market-closed»)');

  const regoleCieche = AC.decideClose({ position: posizione, restingOrders: [], rules: { readable: false, missing: ['tick'] }, book: 'yes', now: ORA + 60_000 });
  ok(regoleCieche.action === 'skip' && regoleCieche.gate === 'rules-unreadable',
    'regole illeggibili ⇒ nessun ordine di chiusura (gate «rules-unreadable»)');

  // ── C5 · IL RESIDUO SOTTO IL MINIMO DEL VENUE È RICONOSCIUTO ─────────────────────────────────
  // §5-bis p.123: sotto `min_incentive_size` non esiste un ordine valido. La catena deve dirlo, non
  // provare a piazzare qualcosa che il venue rifiuterebbe.
  ok(RAF.sottoIlMinimo(3, m.minSize) === true && RAF.sottoIlMinimo(SIZE_FILLATA, m.minSize) === false,
    `il residuo da 3 share è riconosciuto sotto il minimo del venue (${m.minSize}); ${SIZE_FILLATA} share no`);
  ok(RAF.sottoIlMinimo(3, null) === false,
    'minimo del venue non leggibile ⇒ NON si dichiara «sotto il minimo» su un dato che non c\'è');
  const briciola = AC.decideClose({ position: { tokenId: TOKEN, size: 3, avgPrice: CARICO }, restingOrders: [], rules: R, book: 'yes', now: ORA + 60_000 });
  console.log(`     residuo da 3 share (minimo del venue ${m.minSize}): azione «${briciola.action}», gate «${briciola.gate}», size ${briciola.size}`);
  ok(briciola.action !== 'close' || briciola.size >= m.minSize || briciola.gate != null,
    'un residuo sotto il minimo del venue non produce un ordine di chiusura silenziosamente valido');
}

// ═══ 6 · LA PROVA CHE NIENTE DI TUTTO QUESTO PUÒ PARLARE COL VENUE ═════════════════════════════
sez('6 · perimetro — nessuna superficie di piazzamento è stata caricata');
{
  const caricati = Object.keys(require.cache);
  const venue = caricati.filter((p) => p.includes(`${path.sep}lib${path.sep}venues${path.sep}`));
  ok(venue.length === 0,
    `zero moduli sotto lib/venues/ nella cache dei require (su ${caricati.length} moduli caricati): l'adapter che sa firmare non è mai entrato in questo processo`);
  const rete = caricati.filter((p) => /node_modules[\\/](ws|ethers|@polymarket)[\\/]/.test(p));
  ok(rete.length === 0, 'nessuna libreria di rete o di firma caricata (ws, ethers, @polymarket)');
}

// ═══ REFERTO ════════════════════════════════════════════════════════════════════════════════════
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* la temp è sacrificabile */ }
console.log('\n' + '─'.repeat(100));
console.log('A · piazzamento:  ' + esitiA.map((e) => `${e.mercato} bid ${c(e.bid)}¢ / ask ${c(e.ask)}¢ — ${e.distanzaC}¢ dal mid, S=${e.S.toFixed(4)}`).join('   |   '));
console.log('B · riprezzo:     ' + esitiB.map((e) => `${e.mercato} ${c(e.da)}¢ → ${c(e.a)}¢ dopo ${e.osservazioni} osservazioni`).join('   |   '));
console.log(`\n${passati} verdi, ${falliti} rossi`);
process.exit(falliti === 0 ? 0 : 1);
