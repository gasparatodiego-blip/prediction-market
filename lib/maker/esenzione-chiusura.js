'use strict';
// lib/maker/esenzione-chiusura.js — QUANDO UN ORDINE CHIUDE, IL TETTO PER ORDINE NON LO RIGUARDA.
//
// ═══ IL PROBLEMA, MISURATO ═══════════════════════════════════════════════════════════════════════════
// Il tetto per ordine (`LIVE_MIN_ORDER_CAP_USD`, derivato da `MARKET_CAP_FIXED_USD / 2 + 5`) esiste per
// limitare quanto capitale una singola gamba di LIQUIDITÀ può impegnare. Dall'11 agosto 2026 il tetto
// per mercato è sceso a $65, quindi il tetto per ordine vale **$37,50**.
//
// Su un ordine che APRE è la cifra giusta. Su un ordine che CHIUDE è il difetto: la controparte da
// comprare per completare una coppia costa quanto costa — è la posizione già aperta a deciderlo, non
// noi — e a $37,50 una coppia da $65 non si chiude. Misurato sui due giornali maker: **40 rifiuti
// `chiusura-rapida-taker-reject-manual-order-cap`**, cioè il tetto che impedisce di ridurre esposizione.
//
// ═══ LA REGOLA, E PERCHÉ NON APRE NIENTE ═════════════════════════════════════════════════════════════
// È la stessa forma dell'eccezione di riduzione già in servizio nell'adapter (`evaluateReductionProof`,
// §5 punto 26): non una dichiarazione di cui fidarsi, ma una PROVA rifatta qui sull'ordine esatto.
//
//   · il chiamante deve dichiarare `chiudePosizione: true` — e lo fanno solo i quattro percorsi di
//     chiusura di `auto-close` (taker del merge, chiusura rapida, sorella in modalità chiusura, i due
//     rami della chiusura forzata pre-scadenza). Nessun percorso di liquidità lo dichiara;
//   · e la size deve stare dentro ciò che la posizione GIÀ APERTA giustifica, letto dallo snapshot del
//     venue — la stessa fonte dell'eccezione di riduzione, non una seconda lettura che può divergere.
//
// Le due prove, per lato:
//   SELL  `size ≤ share detenute su QUESTO token`. Vendere ciò che si ha non può aumentare esposizione.
//         È esattamente il predicato di `evaluateReductionProof`, e infatti quella funzione è IMPORTATA
//         invece che riscritta: due copie di questa aritmetica potrebbero divergere, e la divergenza
//         qui allargherebbe un limite di rischio.
//   BUY   `size ≤ (share detenute sul lato OPPOSTO) − (share già detenute su questo lato)`, cioè al più
//         `manca`. Un acquisto così può solo APPAIARE ciò che è già aperto: nel caso limite porta i due
//         lati in parti uguali, che è una coppia — esposizione direzionale ZERO — e mai oltre.
//
// ═══ IL CASO CHE SEMBRA UN BUCO E NON LO È ═══════════════════════════════════════════════════════════
// Sul BUY servono DUE letture: quanto teniamo sul lato opposto e quanto sul lato che stiamo comprando.
// Lo snapshot non elenca i token con posizione zero, quindi «token assente» e «snapshot illeggibile»
// arrivano entrambi come `null` — e trattarli allo stesso modo sarebbe sbagliato in una delle due
// direzioni, qualunque si scelga.
//
// La distinzione si ottiene senza un terzo stato, e senza chiedere allo snapshot niente di nuovo:
// **le due letture vengono dalla STESSA lettura** (`leggiCoppiaDetenuta`, una sola `readVenuePositions`).
// Se lo snapshot non è leggibile o è scaduto, `heldOpposto` è `null` e l'esenzione non scatta —
// nessuna aritmetica viene nemmeno tentata. Se `heldOpposto` è un numero finito e positivo, allora
// quello snapshot ERA leggibile e fresco: in quella stessa lettura un `held` assente significa
// davvero zero share. L'inferenza è valida perché le due letture non possono straddleare un refresh.
//
// ═══ COSA NON FA ═════════════════════════════════════════════════════════════════════════════════════
// Non tocca nessun altro gate. Restano davanti, identici, e li elenco perché è la ragione per cui
// questa esenzione è stretta: il KILL, la gestione manuale, la allowlist live-min, la banda premiante,
// «mai primo sul libro», il tetto della coppia (`completaCoppiaOk` rifà la sua aritmetica per conto
// suo), il tetto di esposizione aperta e i limiti di `safety-risk-limits`. Questa funzione risponde a
// UNA domanda sola — «il tetto PER ORDINE si applica a questo ordine?» — e a nient'altro.
//
// Non esenta mai dal tetto di safety un ordine che il tetto di safety rifiuterebbe per un motivo
// diverso dal cap live-min: chi legge il risultato deve continuare a valutare il resto.

const { evaluateReductionProof } = require('../venues/polymarket-clob-maker/prova-riduzione');

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * LA PROVA. Pura: gli ingressi arrivano già letti.
 *
 * @param a.side            'BUY' | 'SELL'
 * @param a.size            share dell'ordine che sta per partire
 * @param a.chiudePosizione dichiarazione del chiamante — senza, nessuna esenzione
 * @param a.heldSize        share detenute sul token che l'ordine tocca (`null` = non nello snapshot)
 * @param a.heldSizeOpposto share detenute sul token OPPOSTO dello stesso mercato
 * @returns {{esente:boolean, motivo:string|null}}
 */
function provaChiusura({ side = null, size = null, chiudePosizione = false,
  heldSize = null, heldSizeOpposto = null } = {}) {
  const no = (motivo) => ({ esente: false, motivo });
  // ── LA DICHIARAZIONE È NECESSARIA E NON SUFFICIENTE ────────────────────────────────────────────
  // `=== true` e non truthy: una stringa, un 1 o un oggetto non sono una dichiarazione, sono un dato
  // che è passato di lì per sbaglio. La stessa forma di `spec.completaCoppia === true`.
  if (chiudePosizione !== true) return no(null);
  const s = Number(size);
  if (!fin(s) || s <= 0) return no('size dell\'ordine non verificata: nessuna esenzione dal tetto per ordine');

  if (side === 'SELL') {
    // Stessa identica prova dell'eccezione di riduzione, IMPORTATA e non ricopiata.
    const rid = evaluateReductionProof({ side, size: s, heldSize });
    if (!rid.riduce) {
      return no(`vendita non provata come riduzione (${fin(Number(heldSize)) ? `${Number(heldSize)} share lette` : 'possesso non leggibile'}):`
        + ' il tetto per ordine resta applicato');
    }
    return { esente: true,
      motivo: `chiusura provata: SELL di ${s} share su ${Number(heldSize)} realmente detenute (snapshot del venue).`
        + ' Un ordine che TOGLIE esposizione non è vincolato al tetto per ordine, che governa quanto capitale'
        + ' una gamba di LIQUIDITÀ può impegnare.' };
  }

  if (side === 'BUY') {
    const opp = Number(heldSizeOpposto);
    // Il lato opposto è la prova che una posizione da appaiare esiste DAVVERO, ed è anche la prova che
    // lo snapshot era leggibile: se non lo fosse, questo numero non ci sarebbe.
    if (!fin(opp) || opp <= 0) {
      return no('nessuna posizione leggibile sul lato opposto: senza una coppia da completare un BUY APRE esposizione,'
        + ' quindi il tetto per ordine resta applicato');
    }
    // `Number(null)` vale 0 ed è la trappola già costata tre volte in questo repo. Qui però lo zero è la
    // risposta GIUSTA, e solo perché `opp` ha già provato che lo snapshot era leggibile e fresco: in
    // quella stessa lettura un token assente possiede davvero zero share. Si guarda comunque il valore
    // grezzo, così l'intenzione resta esplicita invece di dipendere da una coercizione.
    const mio = fin(Number(heldSize)) ? Number(heldSize) : 0;
    const manca = +(opp - mio).toFixed(6);
    if (!(manca > 0)) {
      return no(`la coppia è già completa o sovracoperta (${mio} share su questo lato contro ${opp} sull'opposto):`
        + ' non c\'è niente da appaiare, quindi il tetto per ordine resta applicato');
    }
    if (s > manca + 1e-9) {
      return no(`BUY di ${s} share oltre le ${manca} che mancano alla coppia (${opp} sull'opposto − ${mio} su questo lato):`
        + ' la parte eccedente APRIREBBE esposizione nuova, quindi il tetto per ordine resta applicato');
    }
    return { esente: true,
      motivo: `chiusura provata: BUY di ${s} share entro le ${manca} che mancano alla coppia`
        + ` (${opp} share detenute sul lato opposto, ${mio} su questo — snapshot del venue).`
        + ' Al più porta i due lati in parti uguali, cioè esposizione direzionale zero: non è un ordine che apre.' };
  }

  return no(`lato «${side}» non riconosciuto: nessuna esenzione dal tetto per ordine`);
}

/**
 * LE DUE LETTURE, DA UNA LETTURA SOLA. È il pezzo che rende valida l'inferenza «assente = zero».
 *
 * FAIL-CLOSED in ogni direzione: file assente, JSON rotto, snapshot SCADUTO ⇒ `{leggibile:false}` con
 * entrambe le size a `null`, e la prova non scatta. Un errore di lettura non può allargare un limite.
 * La soglia di scadenza è quella che lo snapshot stesso dichiara (`MAX_AGE_MS`), non una seconda
 * costante che potrebbe divergere.
 *
 * @returns {{leggibile:boolean, held:number|null, heldOpposto:number|null, motivo:string|null}}
 */
function leggiCoppiaDetenuta(tokenId, tokenIdOpposto, deps = {}) {
  const vuoto = (motivo) => ({ leggibile: false, held: null, heldOpposto: null, motivo });
  try {
    const mod = deps.snapshot || require('../safety/venue-positions-snapshot');
    const snap = mod.readVenuePositions();
    if (!snap || snap.readable !== true) return vuoto('snapshot posizioni non leggibile');
    if (fin(snap.ageMs) && fin(mod.MAX_AGE_MS) && snap.ageMs > mod.MAX_AGE_MS) {
      return vuoto(`snapshot posizioni scaduto (${Math.round(snap.ageMs / 1000)}s)`);
    }
    const cerca = (want) => {
      const w = String(want || '');
      if (!w) return null;
      const hit = (snap.positions || []).find((p) => String((p && (p.tokenId ?? p.asset)) || '') === w);
      if (!hit) return null;
      const n = Number(hit.size);
      return fin(n) ? Math.abs(n) : null;
    };
    return { leggibile: true, held: cerca(tokenId), heldOpposto: cerca(tokenIdOpposto), motivo: null };
  } catch (e) {
    return vuoto(`lettura dello snapshot fallita: ${e && e.message ? e.message : String(e)}`);
  }
}

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (nome, cond) => { if (cond) { p += 1; console.log(`  ✓ ${nome}`); } else { f += 1; console.log(`  ✗ ${nome}`); } };
  console.log('\n════ esenzione-chiusura ════');

  ok('senza dichiarazione non si esenta niente',
    provaChiusura({ side: 'SELL', size: 10, heldSize: 100 }).esente === false);
  ok('  e nemmeno con una dichiarazione truthy ma non `true`',
    provaChiusura({ side: 'SELL', size: 10, chiudePosizione: 'si', heldSize: 100 }).esente === false);

  ok('SELL entro il posseduto: esente',
    provaChiusura({ side: 'SELL', size: 100, chiudePosizione: true, heldSize: 100 }).esente === true);
  ok('SELL oltre il posseduto: NON esente',
    provaChiusura({ side: 'SELL', size: 101, chiudePosizione: true, heldSize: 100 }).esente === false);
  ok('SELL con possesso non letto: NON esente',
    provaChiusura({ side: 'SELL', size: 10, chiudePosizione: true, heldSize: null }).esente === false);

  ok('BUY entro `manca`: esente (il caso che il tetto bloccava)',
    provaChiusura({ side: 'BUY', size: 100, chiudePosizione: true, heldSize: null, heldSizeOpposto: 100 }).esente === true);
  ok('BUY oltre `manca`: NON esente — la parte eccedente aprirebbe',
    provaChiusura({ side: 'BUY', size: 101, chiudePosizione: true, heldSize: null, heldSizeOpposto: 100 }).esente === false);
  ok('BUY con copertura parziale già presente: `manca` è la differenza',
    provaChiusura({ side: 'BUY', size: 10, chiudePosizione: true, heldSize: 90, heldSizeOpposto: 100 }).esente === true);
  ok('  e un solo share oltre quella differenza NON passa',
    provaChiusura({ side: 'BUY', size: 11, chiudePosizione: true, heldSize: 90, heldSizeOpposto: 100 }).esente === false);
  ok('BUY senza posizione sul lato opposto: NON esente — sarebbe un ordine che APRE',
    provaChiusura({ side: 'BUY', size: 100, chiudePosizione: true, heldSize: null, heldSizeOpposto: null }).esente === false);
  ok('BUY su coppia già completa: NON esente',
    provaChiusura({ side: 'BUY', size: 5, chiudePosizione: true, heldSize: 100, heldSizeOpposto: 100 }).esente === false);
  ok('BUY su coppia sovracoperta: NON esente',
    provaChiusura({ side: 'BUY', size: 5, chiudePosizione: true, heldSize: 120, heldSizeOpposto: 100 }).esente === false);

  ok('size non verificata: NON esente',
    provaChiusura({ side: 'BUY', size: null, chiudePosizione: true, heldSizeOpposto: 100 }).esente === false);
  ok('lato non riconosciuto: NON esente',
    provaChiusura({ side: 'MAYBE', size: 10, chiudePosizione: true, heldSizeOpposto: 100 }).esente === false);

  // ── LA LETTURA UNICA ──────────────────────────────────────────────────────────────────────────
  const finto = (positions, ageMs = 0, readable = true) => ({
    MAX_AGE_MS: 180_000,
    readVenuePositions: () => ({ readable, ageMs, positions }),
  });
  const r1 = leggiCoppiaDetenuta('tokA', 'tokB', { snapshot: finto([{ tokenId: 'tokB', size: 100 }]) });
  ok('lettura unica: il token assente vale null, ma lo snapshot è leggibile',
    r1.leggibile === true && r1.held === null && r1.heldOpposto === 100);
  const r2 = leggiCoppiaDetenuta('tokA', 'tokB', { snapshot: finto([{ tokenId: 'tokB', size: 100 }], 999_999) });
  ok('snapshot scaduto: entrambe null e non leggibile',
    r2.leggibile === false && r2.held === null && r2.heldOpposto === null);
  const r3 = leggiCoppiaDetenuta('tokA', 'tokB', { snapshot: finto([], 0, false) });
  ok('snapshot illeggibile: entrambe null', r3.leggibile === false && r3.heldOpposto === null);
  ok('e uno snapshot illeggibile NON produce esenzione su un BUY',
    provaChiusura({ side: 'BUY', size: 10, chiudePosizione: true, heldSize: r3.held, heldSizeOpposto: r3.heldOpposto }).esente === false);
  const r4 = leggiCoppiaDetenuta('tokA', 'tokB', { snapshot: finto([{ asset: 'tokB', size: -100 }]) });
  ok('il campo `asset` è accettato come `tokenId` e la size è in valore assoluto', r4.heldOpposto === 100);

  console.log(`\nesenzione-chiusura: ${p} passati, ${f} falliti`);
  return f === 0;
}

module.exports = { provaChiusura, leggiCoppiaDetenuta, selfcheck };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);
