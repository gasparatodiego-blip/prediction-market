'use strict';
// lib/rewards/scadenza-mercato.js — DOVE PUBLYMARKET PUBBLICA DAVVERO LA DATA DI RISOLUZIONE.
//
// ═══ IL PROBLEMA ═════════════════════════════════════════════════════════════════════════════════════
// Gamma espone `endDate` sul record del singolo mercato, ma lo OMETTE spesso — e non in casi rari:
// misurato il 4 agosto 2026, la pagina all'offset 300 dell'endpoint `/markets?active=true&closed=false`
// restituiva 100 record su 100 senza `endDate`, e 100 su 100 con la data presente sull'EVENTO padre.
// Sul board reward vivo erano 21 mercati su 117, venti dei quali negRisk, tutti mostrati con «—».
//
// ═══ PERCHÉ EREDITARE NON È INVENTARE ════════════════════════════════════════════════════════════════
// Su un evento multi-esito (negRisk) la data di risoluzione è una proprietà dell'EVENTO, non del singolo
// esito: «Wisconsin Governor Election Winner» si decide il 2026-11-03, e questo vale identicamente per
// la riga «Republicans win» e per la riga «Democrats win» — sono due esiti dello stesso voto, non due
// scadenze diverse. Leggere la data sul padre non è una stima né un default: è leggerla dove il venue
// la pubblica.
//
// Questo modulo non deduce MAI una data. Non c'è nessun ripiego «se non c'è metti fra un anno», nessuna
// data mediana, nessuna euristica sul testo della domanda. Tre esiti soltanto:
//
//   'market'  la data è sul mercato               → si usa quella, il padre non viene neanche guardato
//   'event'   la data è solo sull'evento padre    → si eredita, e si DICHIARA che è ereditata
//   null      non c'è né sull'uno né sull'altro   → resta ignota, e a valle deve restare visibile
//
// La provenienza esiste perché in futuro «scadenza 2026-11-03» e «scadenza 2026-11-03 ereditata» non
// siano lo stesso dato: se un giorno Polymarket pubblicasse per un esito una data diversa da quella del
// suo evento, l'ereditata sarebbe quella sbagliata e si vuole poterle distinguere senza rifare l'analisi.

/** Una stringa non vuota, o null. Nessuna coercizione, nessun trim silenzioso su valori non stringa. */
function testo(v) {
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * Risolve la data di risoluzione di un mercato Gamma.
 * @param {object} m  il record del mercato come arriva da Gamma (con l'array `events` annidato)
 * @returns {{endDate: string|null, endDateSource: 'market'|'event'|null}}
 */
function risolviScadenza(m) {
  const rec = m || {};
  const propria = testo(rec.endDate);
  if (propria) return { endDate: propria, endDateSource: 'market' };

  // L'evento padre. Gamma annida un array `events`; nella pratica ne porta uno solo, ma se ne portasse
  // più d'uno si prende il PRIMO CHE HA UNA DATA anziché il primo e basta — un evento senza `endDate`
  // in testa all'array non deve nascondere quello che ce l'ha.
  const eventi = Array.isArray(rec.events) ? rec.events : [];
  for (const ev of eventi) {
    const d = ev && testo(ev.endDate);
    if (d) return { endDate: d, endDateSource: 'event' };
  }

  // Né sul mercato né sull'evento. Non si inventa: resta ignota, e chi la usa deve dichiararlo.
  return { endDate: null, endDateSource: null };
}

// ═══ LA RICONCILIAZIONE FRA LE DUE FONTI (12 agosto 2026) ═══════════════════════════════════════════
// Fin qui questo modulo rispondeva a una domanda sola: «dove Gamma pubblica la data». Ma le fonti sono
// DUE, e il sistema le leggeva in due punti diversi con due risultati diversi:
//
//   · il PIANIFICATORE leggeva il board, cioè Gamma (via agent24 → rewards-normalize);
//   · la VERIFICA leggeva il CLOB (`/markets/<conditionId>`, campo `end_date_iso`).
//
// Il costo misurato sul ciclo delle 15:41:31Z del 12 agosto: due mercati scelti dal pianificatore con
// 32,3 h e 20,3 h di vita e poi RIFIUTATI dalla verifica con «mancano 8,3 h (soglia 18 h)» — tre
// ricalcoli e il ciclo fermato, senza che nessuna delle due letture fosse sbagliata.
//
// ═══ QUALE FONTE, E PERCHÉ ═══════════════════════════════════════════════════════════════════════════
// MISURATO su 38 mercati del board (12 agosto 2026): differenza Gamma − CLOB **mai negativa**, mediana
// 0,0 h, p90 16,0 h, **massimo esattamente 24,0 h**; 15 mercati su 38 divergono oltre 2 h. La forma è
// riconoscibile: il CLOB TRONCA A MEZZANOTTE UTC del giorno di risoluzione, Gamma pubblica l'ora vera
// (23:59, 12:00, 18:30). Quando l'ora vera È mezzanotte le due coincidono — 22 casi su 38.
//
// Quindi il CLOB è, PER COSTRUZIONE E NON PER FORTUNA, **mai più tardi di Gamma**: è la fonte più
// prudente, ed è anche il venue che smette davvero di accettare ordini. È lui la fonte unica.
// Gamma non viene buttato: diventa il RISCONTRO INCROCIATO.
//
// ═══ LA REGOLA FAIL-CLOSED ═══════════════════════════════════════════════════════════════════════════
// Il troncamento a mezzanotte può produrre al massimo 24 ore di scarto, e solo nel verso Gamma ≥ CLOB.
// Le due soglie sono quindi DEDOTTE dalla forma dell'errore, non scelte a occhio:
//
//   · scarto oltre **24 h**            → non è troncamento: le due fonti descrivono eventi DIVERSI;
//   · Gamma PRIMA del CLOB oltre **1 h** → incompatibile col troncamento, che può solo anticipare.
//
// In entrambi i casi il mercato è **INAMMISSIBILE**, e l'esclusione avviene A MONTE — nel piano, non in
// un rifiuto a valle. Fra «ammettere un mercato su cui non sappiamo quando si chiude» e «rinunciare a un
// mercato», il secondo costa un'occasione e il primo costa capitale esposto oltre la finestra prevista.
//
// Una fonte sola leggibile NON esclude: non c'è divergenza da misurare, e trattare una lettura mancante
// come una contraddizione fermerebbe il bot a ogni singhiozzo del venue. Si usa quella che c'è e si
// DICHIARA quale (`gamma-sola` / `clob-sola`), che è la stessa disciplina di `endDateSource`.

const TOLLERANZA_ANTICIPO_ORE = 1;    // Gamma prima del CLOB: oltre un'ora non è arrotondamento
const DIVERGENZA_MAX_ORE = 24;        // il massimo che il troncamento a mezzanotte può produrre

/** Millisecondi di una data ISO, o null. Una stringa che non si parsa NON è una data. */
function istante(v) {
  const s = testo(v);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * LA SCADENZA, RICONCILIATA. Un punto solo, chiamato identicamente dal pianificatore e dalla verifica.
 *
 * @param {string|null} gammaIso  la data del board (Gamma, via `risolviScadenza`)
 * @param {string|null} clobIso   la data del venue (`end_date_iso` del CLOB)
 * @returns {{iso:string|null, fonte:string|null, divergenzaOre:number|null,
 *            ammissibile:boolean, motivo:string|null}}
 */
function scadenzaUnificata({ gammaIso = null, clobIso = null } = {}) {
  const g = istante(gammaIso);
  const c = istante(clobIso);

  if (g == null && c == null) {
    return {
      iso: null, fonte: null, divergenzaOre: null, ammissibile: false,
      motivo: 'scadenza non determinabile: né il board né il venue la pubblicano',
    };
  }
  if (c == null) {
    return {
      iso: testo(gammaIso), fonte: 'gamma-sola', divergenzaOre: null, ammissibile: true,
      motivo: 'il venue non ha restituito la scadenza: si usa quella del board, senza riscontro incrociato',
    };
  }
  if (g == null) {
    return {
      iso: testo(clobIso), fonte: 'clob-sola', divergenzaOre: null, ammissibile: true,
      motivo: 'il board non porta la scadenza: si usa quella del venue, senza riscontro incrociato',
    };
  }

  // Il confronto si fa sul valore ESATTO; l'arrotondamento è solo per la stampa. Deciderlo sul valore
  // arrotondato faceva passare un secondo oltre le 24 h come «esattamente 24» — trovato dal selfcheck.
  const oreEsatte = (g - c) / 3_600_000;
  const divergenzaOre = +oreEsatte.toFixed(3);

  if (oreEsatte < -TOLLERANZA_ANTICIPO_ORE) {
    return {
      iso: null, fonte: null, divergenzaOre, ammissibile: false,
      motivo: `il board anticipa il venue di ${(-divergenzaOre).toFixed(1)} h: incompatibile con il`
        + ` troncamento a mezzanotte, che può solo anticipare — le due fonti non descrivono lo stesso evento`,
    };
  }
  if (oreEsatte > DIVERGENZA_MAX_ORE) {
    return {
      iso: null, fonte: null, divergenzaOre, ammissibile: false,
      motivo: `board e venue divergono di ${divergenzaOre.toFixed(1)} h, oltre le ${DIVERGENZA_MAX_ORE} h`
        + ' che il troncamento a mezzanotte può produrre: le due fonti descrivono eventi diversi',
    };
  }

  // Entrambe leggibili e compatibili: vince la PIÙ PRUDENTE, cioè la più vicina. Col troncamento è
  // sempre il CLOB; il minimo esplicito copre anche il caso in cui Gamma anticipi entro la tolleranza.
  const prudente = Math.min(g, c);
  return {
    iso: prudente === c ? testo(clobIso) : testo(gammaIso),
    fonte: prudente === c ? 'clob' : 'gamma-piu-prudente',
    divergenzaOre,
    ammissibile: true,
    motivo: null,
  };
}

/** Asserzioni indipendenti. Esegui: node -e "require('./lib/rewards/scadenza-mercato').selfcheck()" */
function selfcheck() {
  const assert = require('assert');
  let n = 0;
  const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };

  const A = '2026-11-03T00:00:00Z';
  const B = '2027-01-01T00:00:00Z';

  ok('data sul mercato → source market', (() => {
    const r = risolviScadenza({ endDate: A, events: [{ endDate: B }] });
    return r.endDate === A && r.endDateSource === 'market';
  })());

  ok('  e il padre non la sovrascrive MAI, neanche se diversa', (() => {
    const r = risolviScadenza({ endDate: A, events: [{ endDate: B }] });
    return r.endDate === A;
  })());

  ok('data assente sul mercato, presente sull evento → ereditata e dichiarata', (() => {
    const r = risolviScadenza({ endDate: null, events: [{ slug: 'wisconsin-governor-winner-2026', endDate: A }] });
    return r.endDate === A && r.endDateSource === 'event';
  })());

  ok('  stringa vuota sul mercato conta come assente (non come data)', (() => {
    const r = risolviScadenza({ endDate: '   ', events: [{ endDate: A }] });
    return r.endDate === A && r.endDateSource === 'event';
  })());

  ok('  il primo evento CON data vince sul primo evento e basta', (() => {
    const r = risolviScadenza({ events: [{ endDate: null }, { endDate: A }] });
    return r.endDate === A && r.endDateSource === 'event';
  })());

  ok('nessuna data da nessuna parte → null, e la provenienza è null', (() => {
    const r = risolviScadenza({ endDate: null, events: [{ slug: 'x' }] });
    return r.endDate === null && r.endDateSource === null;
  })());

  ok('  nessun evento affatto → null (non esplode)', (() => {
    const r = risolviScadenza({ endDate: null });
    return r.endDate === null && r.endDateSource === null;
  })());

  ok('  record nullo → null (non esplode)', (() => {
    const r = risolviScadenza(null);
    return r.endDate === null && r.endDateSource === null;
  })());

  ok('  events non array → ignorato senza esplodere', (() => {
    const r = risolviScadenza({ events: { endDate: A } });
    return r.endDate === null && r.endDateSource === null;
  })());

  ok('NON si inventa mai una data: senza fonti l esito è null, non una data plausibile', (() => {
    const r = risolviScadenza({ question: 'Will X happen by December 2026?' });
    return r.endDate === null;
  })());

  ok('un numero non è una data', (() => {
    const r = risolviScadenza({ endDate: 1799999999999, events: [] });
    return r.endDate === null && r.endDateSource === null;
  })());

  // ── la riconciliazione fra le due fonti ──────────────────────────────────────────────────────────
  // I numeri sono quelli VERI del ciclo delle 15:41:31Z del 12 agosto 2026.
  const G_CLACTON = '2026-08-13T23:59:00Z';
  const C_CLACTON = '2026-08-13T00:00:00Z';

  ok('entrambe leggibili e compatibili → vince il CLOB, che è la più prudente', (() => {
    const r = scadenzaUnificata({ gammaIso: G_CLACTON, clobIso: C_CLACTON });
    return r.iso === C_CLACTON && r.fonte === 'clob' && r.ammissibile === true;
  })());

  ok('  e la divergenza viene DICHIARATA, non nascosta', (() => {
    const r = scadenzaUnificata({ gammaIso: G_CLACTON, clobIso: C_CLACTON });
    return Math.abs(r.divergenzaOre - 23.983) < 0.01;
  })());

  ok('24 h esatte è il massimo del troncamento: ammesso, non escluso', (() => {
    const r = scadenzaUnificata({ gammaIso: '2026-08-14T00:00:00Z', clobIso: '2026-08-13T00:00:00Z' });
    return r.ammissibile === true && r.divergenzaOre === 24;
  })());

  ok('oltre 24 h le due fonti descrivono eventi diversi → INAMMISSIBILE', (() => {
    const r = scadenzaUnificata({ gammaIso: '2026-08-14T00:00:01Z', clobIso: '2026-08-13T00:00:00Z' });
    return r.ammissibile === false && r.iso === null && /eventi diversi/.test(r.motivo);
  })());

  ok('  e il board che ANTICIPA il venue oltre un ora è ugualmente inammissibile', (() => {
    const r = scadenzaUnificata({ gammaIso: '2026-08-12T20:00:00Z', clobIso: '2026-08-13T00:00:00Z' });
    return r.ammissibile === false && r.iso === null && /anticipa/.test(r.motivo);
  })());

  ok('  ma un anticipo entro la tolleranza è arrotondamento: si tiene il più prudente', (() => {
    const r = scadenzaUnificata({ gammaIso: '2026-08-12T23:30:00Z', clobIso: '2026-08-13T00:00:00Z' });
    return r.ammissibile === true && r.iso === '2026-08-12T23:30:00Z' && r.fonte === 'gamma-piu-prudente';
  })());

  ok('una fonte sola NON esclude — e dichiara quale', (() => {
    const a = scadenzaUnificata({ gammaIso: G_CLACTON, clobIso: null });
    const b = scadenzaUnificata({ gammaIso: null, clobIso: C_CLACTON });
    return a.ammissibile === true && a.fonte === 'gamma-sola' && a.iso === G_CLACTON
      && b.ammissibile === true && b.fonte === 'clob-sola' && b.iso === C_CLACTON;
  })());

  ok('NESSUNA fonte leggibile → inammissibile, fail-closed', (() => {
    const r = scadenzaUnificata({ gammaIso: null, clobIso: null });
    return r.ammissibile === false && r.iso === null;
  })());

  ok('  e una stringa che non si parsa NON è una data', (() => {
    const r = scadenzaUnificata({ gammaIso: 'presto', clobIso: '   ' });
    return r.ammissibile === false && r.iso === null;
  })());

  ok('  argomenti assenti non esplodono', (() => {
    const r = scadenzaUnificata();
    return r.ammissibile === false && r.iso === null;
  })());

  ok('le due soglie sono DEDOTTE dalla forma dell errore, non scelte a occhio',
    DIVERGENZA_MAX_ORE === 24 && TOLLERANZA_ANTICIPO_ORE === 1);

  console.log('scadenza-mercato: ' + n + ' assertions passed');
  return n;
}

module.exports = {
  risolviScadenza, scadenzaUnificata, selfcheck,
  DIVERGENZA_MAX_ORE, TOLLERANZA_ANTICIPO_ORE,
};
