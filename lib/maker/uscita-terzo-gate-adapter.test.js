'use strict';
// lib/maker/uscita-terzo-gate-adapter.test.js
// ═══ IL TERZO GATE — 24 agosto 2026 ══════════════════════════════════════════════════════════════
//
// IL DIFETTO, MISURATO SU CAPITALE REALE. §4.6 dichiarava «CORRETTI ENTRAMBI I GATE, NON UNO» dopo il
// difetto del 17 agosto. I gate sono TRE:
//   ① `auto-close.decideClose`  — validava con `uscita:true` (corretto da f0394fa)
//   ② `placeManualOrder`        — validava con `uscita:true` e derogava (corretto da f0394fa)
//   ③ `adapter.postOrder`       — rivalidava SENZA `uscita`, ricostruiva il verdetto vecchio, RIFIUTAVA
// La deroga di ① e ② non veniva quindi mai raggiunta. Il 24/08, con f0394fa gia' in servizio dalle
// 14:19:17Z, la vendita in profitto su 0x65109969 (15,4 share, carico 21c contro 36-45c correnti,
// minimo d'ordine vero 5, pavimento premiante 20) e' stata rifiutata 93 volte in 30 minuti con
// `BELOW_MIN_SIZE: size 15.4 is below min_incentive_size 20`, mentre la riga di `manual-place` portava
// gia' `uscita:{prezzoDeciso:0.43}` e l'avviso «il venue lo accetta perche' supera minimum_order_size 5».
//
// COSA SI DIFENDE — la PROPRIETA', non il caso: che i tre gate diano lo STESSO verdetto sullo stesso
// ordine. Un gate a valle che rivalida con meno informazione di quello a monte e' la forma «protezione
// presente su un percorso e assente sul gemello», terza occorrenza.

const assert = require('assert');
let p = 0;
const ok = (nome, cond, extra) => { assert.ok(cond, `${nome}${extra ? ' — ' + extra : ''}`); p += 1; console.log(`  ✓ ${nome}`); };

const CID = '0x65109969538f6c3302999c293cbdcd73036faa624cd46378a82fea5fd1c7a7fa';
const TOK = '73705561568066631104036259922811537210904377929581020241762836310455446902384';
const TOK_OPP = '11111111111111111111111111111111111111111111111111111111111111111111111111111';

// ── LO SNAPSHOT POSIZIONI, INIETTATO NEL MODULO E NON SU DISCO ──────────────────────────────────
// `esenzione-chiusura.leggiCoppiaDetenuta` fa `deps.snapshot || require('../safety/venue-positions-snapshot')`
// DENTRO la funzione, quindi sostituire l'export nel require.cache basta e non tocca nessun file di
// produzione (§5.3: un test che scrive nello stato vero e' un difetto a sua volta).
const snapMod = require('../safety/venue-positions-snapshot');
const originale = snapMod.readVenuePositions;
const conPosizione = (size) => () => ({ readable: true, ageMs: 0, positions: [{ tokenId: TOK, size, avgPrice: 0.21 }] });

const { createMakerAdapter } = require('../venues/polymarket-clob-maker/adapter');

const REGOLE = (scoringMid) => ({ tick: 0.01, scoringMid, maxSpreadCents: 4.5, minSize: 20, minOrderSize: 5, marketId: CID });

function piazza({ size, price, scoringMid, uscita, chiudePosizione }) {
  const righe = [];
  const ad = createMakerAdapter({
    mode: 'paper', dryRun: false, auditSink: (r) => righe.push(r),
    funder: { address: '0x0000000000000000000000000000000000000001', signatureType: 3 },
  });
  const spec = {
    marketId: CID, tokenId: TOK, tokenIdOpposto: TOK_OPP, side: 'SELL',
    price, size, tickSize: 0.01, venueRules: REGOLE(scoringMid),
    ...(uscita ? { uscita: true } : {}),
    ...(chiudePosizione ? { chiudePosizione: true } : {}),
  };
  return ad.postOrder(spec).then((res) => ({ res, righe }));
}

(async () => {
  console.log('\n════ il terzo gate: l\'adapter giudica un\'uscita come un\'uscita ════');

  // ── ① IL CASO VERO: 15,4 share che CHIUDONO, minimo d'ordine 5, pavimento premiante 20 ──────────
  snapMod.readVenuePositions = conPosizione(15.4);
  {
    const { res, righe } = await piazza({ size: 15.4, price: 0.25, scoringMid: 0.25, uscita: true, chiudePosizione: true });
    ok('① la vendita da 15,4 share che CHIUDE non e\' piu\' rifiutata dall\'adapter',
      res.ok === true, `gate=${res.gate} reason=${res.reason}`);
    ok('  e il rifiuto NON e\' piu\' `venue-rules`', res.gate !== 'venue-rules');
    // ⚠ E LA DEROGA NON SERVE, ed e' giusto cosi': con il minimo d'ordine LETTO, `validateQuote`
    // declassa `BELOW_MIN_SIZE` ad avviso da solo. La deroga e' la rete per il minimo NON pubblicato.
    ok('  «non matura premio» sopravvive come AVVISO, non come divieto',
      righe.some((r) => r.outcome === 'band-advisory'
        && (r.reasons || []).some((x) => x.code === 'BELOW_MIN_SIZE')));
    ok('  e nessuna deroga e\' stata spesa, perche\' non serviva',
      !righe.some((r) => r.outcome === 'deroga-sotto-minimo-per-chiusura'));
  }

  // ── ①-bis IL MINIMO D'ORDINE NON PUBBLICATO: LI' LA DEROGA SERVE, E LASCIA LA RIGA ──────────────
  // E' lo stato di OGNI mercato finche' agent24 non riscrive il board col codice nuovo. Senza la
  // deroga il percorso d'uscita rifiuterebbe TUTTE le chiusure: curare 282 rifiuti creandone migliaia.
  {
    const righe = [];
    const ad = createMakerAdapter({ mode: 'paper', dryRun: false, auditSink: (r) => righe.push(r),
      funder: { address: '0x0000000000000000000000000000000000000001', signatureType: 3 } });
    const regole = { ...REGOLE(0.25), minOrderSize: null };
    const res = await ad.postOrder({ marketId: CID, tokenId: TOK, tokenIdOpposto: TOK_OPP, side: 'SELL',
      price: 0.25, size: 15.4, tickSize: 0.01, venueRules: regole, uscita: true, chiudePosizione: true });
    ok('①-bis minimo d\'ordine non pubblicato + chiusura PROVATA ⇒ l\'ordine passa',
      res.ok === true, `gate=${res.gate} reason=${res.reason}`);
    ok('  e la deroga lascia una riga, non passa muta',
      righe.some((r) => r.outcome === 'deroga-sotto-minimo-per-chiusura'));
    // ⚠ FAIL-CLOSED: senza la dichiarazione di chiusura la prova non si fa e il rifiuto resta.
    const righe2 = [];
    const ad2 = createMakerAdapter({ mode: 'paper', dryRun: false, auditSink: (r) => righe2.push(r),
      funder: { address: '0x0000000000000000000000000000000000000001', signatureType: 3 } });
    const res2 = await ad2.postOrder({ marketId: CID, tokenId: TOK, tokenIdOpposto: TOK_OPP, side: 'SELL',
      price: 0.25, size: 15.4, tickSize: 0.01, venueRules: regole, uscita: true });
    ok('  e senza `chiudePosizione` la prova non si fa e il rifiuto RESTA (fail-closed)',
      res2.ok === false && (res2.reasons || []).some((r) => r.code === 'MIN_ORDER_SIZE_UNREADABLE'),
      `gate=${res2.gate} reason=${res2.reason}`);
  }

  // ── ② E NIENTE E' STATO ALLENTATO PER CHI APRE ──────────────────────────────────────────────────
  // Lo stesso ordine SENZA il timbro resta rifiutato dal pavimento premiante, esattamente come ieri.
  {
    const { res } = await piazza({ size: 15.4, price: 0.25, scoringMid: 0.25, uscita: false, chiudePosizione: false });
    ok('② lo STESSO ordine senza il timbro `uscita` resta rifiutato: nessun pavimento allentato',
      res.ok === false && res.gate === 'venue-rules', `gate=${res.gate}`);
    ok('  e il codice e\' quello del pavimento premiante',
      (res.reasons || []).some((r) => r.code === 'BELOW_MIN_SIZE'), res.reason);
  }

  // ── ③ IL MINIMO D'ORDINE VERO NON SI DEROGA MAI, NEMMENO A UNA CHIUSURA PROVATA ─────────────────
  snapMod.readVenuePositions = conPosizione(2.01);
  {
    const { res } = await piazza({ size: 2.01, price: 0.10, scoringMid: 0.10, uscita: true, chiudePosizione: true });
    ok('③ 2,01 share che CHIUDONO sono rifiutate: sotto il minimo d\'ordine VERO',
      res.ok === false && res.gate === 'venue-rules', `gate=${res.gate}`);
    ok('  e col codice giusto — BELOW_MIN_ORDER_SIZE, non BELOW_MIN_SIZE',
      (res.reasons || []).some((r) => r.code === 'BELOW_MIN_ORDER_SIZE')
      && !(res.reasons || []).some((r) => r.code === 'BELOW_MIN_SIZE'), res.reason);
    ok('  e il motivo cita il minimo VERO (5), non il pavimento premiante (20)',
      /minimum_order_size 5/.test(String(res.reason)) && !/min_incentive_size 20/.test(String(res.reason)), res.reason);
  }

  // ── ④ IL GEMELLO A MONTE DA' LO STESSO VERDETTO SULLO STESSO ORDINE ─────────────────────────────
  // E' la proprieta' che il difetto violava: i due gate rispondevano diverso alla stessa domanda.
  {
    const VR = require('./venue-rules');
    const q = (size, uscita) => VR.splitVerdict(VR.validateQuote(REGOLE(0.25), { side: 'SELL', price: 0.25, size, uscita }), {});
    ok('④ a monte 15,4 con `uscita` NON e\' bloccante (declassato ad avviso)',
      q(15.4, true).valid === true);
    ok('  a monte 15,4 SENZA `uscita` e\' bloccante — la differenza la fa il timbro, non il gate',
      q(15.4, false).valid === false);
    const g = q(2.01, true);
    ok('  a monte 2,01 con `uscita` e\' bloccante col codice del minimo d\'ordine',
      g.valid === false && g.reasons.some((r) => r.code === 'BELOW_MIN_ORDER_SIZE'));
    ok('  e `sottoMinimo` NON marca il minimo d\'ordine come derogabile',
      VR.splitVerdict(VR.validateQuote(REGOLE(0.25), { side: 'SELL', price: 0.25, size: 2.01, uscita: true }),
        { allowBelowMinSize: true }).valid === false);
  }

  snapMod.readVenuePositions = originale;
  console.log(`\nuscita-terzo-gate-adapter: ${p} passati, 0 falliti`);
})().catch((e) => { snapMod.readVenuePositions = originale; console.error('FAIL:', e.message); process.exit(1); });
