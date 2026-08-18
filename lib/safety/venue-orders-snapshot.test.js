'use strict';
// lib/safety/venue-orders-snapshot.test.js
//
// LA PROPRIETA' DIFESA: «un mercato con capitale a libro non esce mai dal perimetro».
//
// E il caso da cui nasce, riprodotto per intero nel BLOCCO E: il 18 agosto 2026 il bot ha piazzato due
// ordini veri su 0x1f1c6390, il mercato e' uscito dal BOARD dieci minuti dopo, la selezione l'ha
// rilasciato e nessuno ha piu' rinnovato: GTD scaduta, bot armato e fuori dal libro per 52 minuti.
//
// ⚠ NESSUNA ASSERZIONE TOCCA `data/` DI PRODUZIONE. Sia lo snapshot sia il file di configurazione sono
// iniettati in una cartella temporanea. Non e' pignoleria: poche ore prima, in questa stessa sessione,
// un mio test ha scritto quattro record finti nel giornale vero e azzerato un'ancora del presidio,
// perche' la funzione che pilotava non aveva un percorso iniettabile. Un test che per girare deve
// toccare lo stato vero non lo si esegue mai — ed e' il motivo per cui il gemello delle posizioni
// aveva gia' `snapshotFile` fra le sue deps.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const S = require('./venue-orders-snapshot');
const C = require('../maker/auto-reprice-config');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'venue-orders-'));
const FILE = path.join(TMP, 'venue-orders.json');
const CFG = path.join(TMP, 'maker-auto-reprice.json');

const A = '0xaaa1111111111111111111111111111111111111111111111111111111111111';
const B = '0xbbb2222222222222222222222222222222222222222222222222222222222222';
const OKLA = '0x1f1c63908f6c1e3b49559fa80ddef36baa9c5482d52e6a7852c90303807ee22e';

let passati = 0;
const ok = (cond, nome) => {
  assert.ok(cond, nome);
  passati += 1;
};
const reset = () => { try { fs.unlinkSync(FILE); } catch { /* non c'era */ } };
const scrivi = (lettura, now) => S.writeVenueOrders(lettura, { snapshotFile: FILE, now: () => now });
const leggi = (now, extra = {}) => S.readVenueOrders({ snapshotFile: FILE, now: () => now, ...extra });

// ══ BLOCCO A · LA FUSIONE, che e' la ragione per cui questo modulo non e' una copia del gemello ══════
{
  reset();
  const t0 = 1_000_000;
  scrivi({ guardati: [A], conOrdini: [A] }, t0);
  ok(leggi(t0).marketIds.includes(A), 'A · un mercato guardato e trovato con ordini entra nello snapshot');

  // Il giro dopo guarda SOLO B. A non e' stato guardato: il suo silenzio non e' una lettura.
  scrivi({ guardati: [B], conOrdini: [B] }, t0 + 10_000);
  const dopo = leggi(t0 + 10_000).marketIds;
  ok(dopo.includes(A), 'A · un mercato NON guardato conserva la sua voce — e questa e la correzione');
  ok(dopo.includes(B), 'A · e il mercato guardato in questo giro si aggiunge');

  // Guardato e trovato VUOTO: li' il vuoto e' un fatto osservato, quindi la voce se ne va.
  scrivi({ guardati: [A], conOrdini: [] }, t0 + 20_000);
  const dopoVuoto = leggi(t0 + 20_000).marketIds;
  ok(!dopoVuoto.includes(A), 'A · un mercato guardato e trovato VUOTO esce: li il vuoto e una lettura');
  ok(dopoVuoto.includes(B), 'A · e B, che non era in questo giro, resta');
}

// ══ BLOCCO B · LA FRESCHEZZA, sui due livelli, e sempre verso «non lo so» ════════════════════════════
{
  reset();
  ok(leggi(1_000_000).readable === false, 'B · mai scritto ⇒ NON leggibile');
  ok(leggi(1_000_000).marketIds.length === 0, 'B · e la lista e vuota, che il consumatore deve leggere come «non lo so»');

  const t0 = 2_000_000;
  scrivi({ guardati: [A], conOrdini: [A] }, t0);
  ok(leggi(t0 + S.MAX_AGE_MS - 1).readable === true, 'B · dentro MAX_AGE_MS lo snapshot e leggibile');
  const vecchio = leggi(t0 + S.MAX_AGE_MS + 1);
  ok(vecchio.readable === false, 'B · oltre MAX_AGE_MS lo snapshot NON e leggibile: chi scrive non gira');
  ok(vecchio.marketIds.length === 0, 'B · e non restituisce mercati — «vecchio» non diventa «nessun ordine»');

  // La valvola per-voce, col file tenuto fresco da un altro mercato.
  reset();
  scrivi({ guardati: [A], conOrdini: [A] }, t0);
  scrivi({ guardati: [B], conOrdini: [B] }, t0 + S.ENTRY_MAX_AGE_MS + 1_000);
  const conValvola = leggi(t0 + S.ENTRY_MAX_AGE_MS + 1_000).marketIds;
  ok(!conValvola.includes(A), 'B · una voce oltre ENTRY_MAX_AGE_MS cade: non tiene un mercato dentro per sempre');
  ok(conValvola.includes(B), 'B · mentre la voce fresca resta');

  // File corrotto: non leggibile, e non deve far esplodere lo scrittore.
  fs.writeFileSync(FILE, '{ questo non e JSON');
  ok(leggi(t0).readable === false, 'B · file corrotto ⇒ NON leggibile');
  const r = scrivi({ guardati: [A], conOrdini: [A] }, t0);
  ok(r.ok === true, 'B · e lo scrittore riparte da zero voci invece di rifiutarsi di scrivere');
}

// ══ BLOCCO C · LA VALVOLA STA SOPRA LA GTD, e si asserisce la RELAZIONE, non il numero ═══════════════
{
  // Se ENTRY_MAX_AGE_MS scendesse sotto la GTD, la valvola potrebbe far uscire dal perimetro un mercato
  // con un ordine ANCORA VIVO — cioe' ricreerebbe esattamente il guasto che questo modulo chiude.
  // Si asserisce la relazione: un test che fotografasse `1_800_000` sarebbe verde anche dopo aver
  // portato la GTD a un'ora.
  const GTD_MS = 1380 * 1000;   // il TTL che il bot chiede davvero sugli ordini di coppia
  ok(S.ENTRY_MAX_AGE_MS > GTD_MS,
    'C · ENTRY_MAX_AGE_MS sta SOPRA la GTD: la valvola non puo accorciare la vita di un ordine vivo');
  ok(S.MAX_AGE_MS < S.ENTRY_MAX_AGE_MS,
    'C · la freschezza del FILE e piu stretta di quella della VOCE: un processo fermo si nota subito');
}

// ══ BLOCCO D · LO SCRITTORE NON DISTRUGGE SU UN INGRESSO MALFATTO ════════════════════════════════════
{
  reset();
  const t0 = 3_000_000;
  scrivi({ guardati: [A], conOrdini: [A] }, t0);
  for (const cattivo of [null, undefined, {}, { guardati: 'A' }, { conOrdini: [A] }]) {
    const r = S.writeVenueOrders(cattivo, { snapshotFile: FILE, now: () => t0 });
    ok(r.ok === false && r.written === false, `D · ingresso malfatto (${JSON.stringify(cattivo)}) ⇒ non si scrive`);
  }
  ok(leggi(t0).marketIds.includes(A), 'D · e la voce buona di prima e ancora li: un ingresso rotto non cancella niente');
}

// ══ BLOCCO E · IL CASO DEL 18 AGOSTO, RIPRODOTTO ════════════════════════════════════════════════════
// «Se il mercato sparisce dal board mentre ho ordini a libro, il bot continua a gestirli.»
{
  reset();
  const t0 = 4_000_000;

  // ① Lo stato delle 16:32: interruttore generale acceso, Oklahoma abilitato, due ordini a libro.
  fs.writeFileSync(CFG, JSON.stringify({
    global: { enabled: true },
    markets: { [OKLA]: { enabled: true, by: 'selezione', reason: 'giro di prova' } },
  }));
  scrivi({ guardati: [OKLA], conOrdini: [OKLA] }, t0);

  const prima = C.readAutoRepriceConfig({ configFile: CFG, ordini: leggi(t0), posizioni: { readable: true, positions: [] } });
  ok(prima.liveMinMarketIds.includes(OKLA), 'E · 16:32 — il mercato e nel perimetro (era abilitato)');

  // ② Le ~16:42: il mercato ESCE DAL BOARD, la selezione lo rilascia, `setAutoReprice` lo spegne.
  //    Nessuna posizione aperta — solo ordini a riposo, che e' precisamente il caso scoperto.
  fs.writeFileSync(CFG, JSON.stringify({
    global: { enabled: true },
    markets: { [OKLA]: { enabled: false, by: 'riallocatore', reason: 'riga-assente: nessuna riga di board' } },
  }));

  // ③ E il giro dopo NON guarda Oklahoma — perche' `cadenza-adattiva` lo salta, che e' cio' che e'
  //    successo davvero. Lo snapshot deve conservarne la voce proprio in questo giro.
  scrivi({ guardati: [B], conOrdini: [B] }, t0 + 10_000);

  const dopo = C.readAutoRepriceConfig({
    configFile: CFG, ordini: leggi(t0 + 10_000), posizioni: { readable: true, positions: [] },
  });
  ok(dopo.liveMinMarketIds.includes(OKLA),
    'E · ⚑ USCITO DAL BOARD E SPENTO, MA RESTA NEL PERIMETRO — e la proprieta chiesta');
  ok(dopo.enabledDaOrdini.includes(OKLA),
    'E · e il perimetro dichiara PERCHE: ci abbiamo ordini a libro');
  ok(!dopo.enabledMarketIds.includes(OKLA),
    'E · mentre `enabledMarketIds` NON lo contiene: il piano non lo vuole piu quotare, e non lo si riapre');

  // ④ La prova che il difetto era reale: senza lo snapshot — cioe' col codice di ieri — sparisce.
  const senza = C.readAutoRepriceConfig({
    configFile: CFG, ordini: { readable: false, marketIds: [] }, posizioni: { readable: true, positions: [] },
  });
  ok(!senza.liveMinMarketIds.includes(OKLA),
    'E · ⚑ CONTROPROVA: senza lo snapshot il mercato esce dal perimetro — e cosa e successo il 18 agosto');

  // ⑤ Quando gli ordini finiscono davvero (guardato e vuoto), il mercato esce. La regola non e'
  //    «entra e non esce piu'»: e' «non esce finche' c'e' capitale a libro».
  scrivi({ guardati: [OKLA], conOrdini: [] }, t0 + 20_000);
  const chiuso = C.readAutoRepriceConfig({
    configFile: CFG, ordini: leggi(t0 + 20_000), posizioni: { readable: true, positions: [] },
  });
  ok(!chiuso.liveMinMarketIds.includes(OKLA),
    'E · e quando gli ordini non ci sono piu (letto, non dedotto) il mercato esce');
}

// ══ BLOCCO F · FAIL-CLOSED, e subordinazione all'interruttore generale ══════════════════════════════
{
  const t0 = 5_000_000;
  reset();
  scrivi({ guardati: [A], conOrdini: [A] }, t0);

  fs.writeFileSync(CFG, JSON.stringify({ global: { enabled: false }, markets: {} }));
  const spento = C.readAutoRepriceConfig({ configFile: CFG, ordini: leggi(t0), posizioni: { readable: true, positions: [] } });
  ok(spento.liveMinMarketIds.length === 0,
    'F · interruttore generale SPENTO ⇒ perimetro vuoto, ordini o no: la nuova componente non lo scavalca');

  fs.writeFileSync(CFG, JSON.stringify({ global: { enabled: true }, markets: { [B]: { enabled: true } } }));
  const cieco = C.readAutoRepriceConfig({
    configFile: CFG, ordini: { readable: false, marketIds: [] }, posizioni: { readable: true, positions: [] },
  });
  ok(cieco.liveMinMarketIds.length === 1 && cieco.liveMinMarketIds.includes(B),
    'F · snapshot illeggibile ⇒ nessuna aggiunta, e il perimetro resta quello di prima (fail-closed)');
  ok(cieco.enabledDaOrdini.length === 0, 'F · e non si inventa nessuna provenienza');

  // Monotonia: la componente nuova puo' solo AGGIUNGERE. Non esiste configurazione in cui tolga un
  // mercato che prima era nel perimetro.
  const conOrdini = C.readAutoRepriceConfig({ configFile: CFG, ordini: leggi(t0), posizioni: { readable: true, positions: [] } });
  ok(cieco.liveMinMarketIds.every((id) => conOrdini.liveMinMarketIds.includes(id)),
    'F · MONOTONA: tutto cio che era nel perimetro senza lo snapshot ci resta anche con lo snapshot');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
console.log(`venue-orders-snapshot: ${passati}/${passati} verdi, 0 rossi`);
