'use strict';
// lib/maker/selezione-book-vivo.test.js
//
// LA PROPRIETA': un mercato che non si puo' PREZZARE non deve occupare uno slot.
//
// IL FATTO, misurato la sera del 18 agosto 2026. Il bot ha scelto un mercato la cui sottoscrizione al
// feed era caduta: il book restava fermo e l'eta' saliva monotona — 86s, 98s, 110s, 122s, 134s —
// mentre gli altri 124 mercati del feed erano freschi. Il piazzatore apriva la coppia lo stesso, e tre
// minuti dopo `auto-reprice` la cancellava per `mid-stantio`. Quaranta minuti di piazza-muore-ripiazza,
// uno slot bruciato a ogni giro.
//
// ⚠ E' QUESTO GATE che impedisce alle tre correzioni di trasformare il churn in immobilita': non
// lascia lo slot vuoto, lo SPOSTA su un mercato che il feed segue davvero.

const assert = require('assert');
const S = require('./selezione-mercati');

let passati = 0;
const ok = (c, n) => { assert.ok(c, n); passati += 1; };

const ORA = Date.parse('2026-08-18T21:00:00Z');
const GIORNO = 86_400_000;
const mkt = (id, extra = {}) => ({
  conditionId: id, question: `mercato ${id}`, category: 'elections',
  rewardsMinSize: 20, endDate: new Date(ORA + 3 * GIORNO).toISOString(), ...extra,
});
const val = (riga, bookVivi) => S.valutaAmmissibilita(riga, { ora: ORA, bookVivi });
// Un book UTILIZZABILE: ancorato, con un tocco, datato. `live` NON entra nel criterio — v. il blocco ③.
const usabile = (ageMs = 5000, extra = {}) => ({ live: true, ageMs, needsResnapshot: false, haTocco: true, ...extra });
const GTD_MS = 1380 * 1000;
const BASE = { leggibile: true, etaMassimaMs: 60_000, etaMassimaAssolutaMs: GTD_MS, feedVivo: true };

// ══ ① SENZA MAPPA, IL COMPORTAMENTO E' QUELLO DI PRIMA ════════════════════════════════════════════
{
  ok(val(mkt('0xa'), null).ammissibile === true, '① nessuna mappa ⇒ cancello non applicato');
  ok(val(mkt('0xa'), { leggibile: false }).ammissibile === true,
    '① ⚑ mappa ILLEGGIBILE ⇒ cancello non applicato: non si svuota la selezione per un file non letto');
}

// ══ ② IL MERCATO CON UN BOOK UTILIZZABILE PASSA ══════════════════════════════════════════════════
{
  const r = val(mkt('0xa'), { ...BASE, per: { '0xa': usabile(5000) } });
  ok(r.ammissibile === true, '② book ancorato, con tocco e datato ⇒ ammissibile');
}

// ══ ③ ⚑ IL SILENZIO NON ESCLUDE — la correzione della sera del 18 agosto ═════════════════════════
//
// `live` in agent34 significa «e' arrivato un evento negli ultimi 30 s», NON «siamo abbonati». La
// prima stesura di questo gate escludeva `live !== true` e cosi' buttava fuori i mercati TRANQUILLI,
// cioe' quelli che un maker di rewards vuole. Misurato: 19% degli asset e' silenzioso in un istante
// qualunque, e il mercato che sembrava caduto e' tornato `live` da solo al primo evento.
{
  const quieto = val(mkt('0xa'), { ...BASE, per: { '0xa': { live: false, reason: 'stale', ageMs: 90_000, needsResnapshot: false, haTocco: true } } });
  ok(quieto.ammissibile === true,
    '③ ⚑ mercato SILENZIOSO (live:false, 90s senza eventi) ⇒ AMMISSIBILE: il quadro memorizzato e utilizzabile');

  // ⚠ E NEMMENO col feed non vivo: la domanda «siamo ciechi?» non appartiene alla selezione. La
  // risolve `mid-stantio`, che decide se TOGLIERE un ordine gia' a libro. Due soglie sullo stesso
  // fatto sarebbero due opinioni.
  const feedMuto = val(mkt('0xa'), { ...BASE, feedVivo: false, regime: 'muto',
    per: { '0xa': { live: false, reason: 'stale', ageMs: 90_000, needsResnapshot: false, haTocco: true } } });
  ok(feedMuto.ammissibile === true, '③ ⚑ e resta ammissibile anche col feed muto: qui non si giudica la cecita');
}

// ══ ④ LE ESCLUSIONI CHE RESTANO, OGNUNA COL SUO NOME ═════════════════════════════════════════════
{
  const assente = val(mkt('0xa'), { ...BASE, per: { '0xb': usabile() } });
  ok(assente.ammissibile === false, '④ mercato assente dalla mappa ⇒ escluso');
  ok(assente.motivo === 'book-non-sottoscritto', '④   motivo: book-non-sottoscritto');

  const daRisync = val(mkt('0xa'), { ...BASE, per: { '0xa': usabile(5000, { needsResnapshot: true }) } });
  ok(daRisync.ammissibile === false, '④ ⚑ needsResnapshot ⇒ escluso: il libro ha perso l ancoraggio');
  ok(daRisync.motivo === 'book-da-risincronizzare', '④   motivo: book-da-risincronizzare');

  const senzaTocco = val(mkt('0xa'), { ...BASE, per: { '0xa': usabile(5000, { haTocco: false }) } });
  ok(senzaTocco.ammissibile === false, '④ senza bid ne ask ⇒ escluso');
  ok(senzaTocco.motivo === 'book-senza-tocco', '④   motivo: book-senza-tocco');

}

// ══ ⑤ NESSUNA SOGLIA DI ETA', DI NESSUN TIPO ═════════════════════════════════════════════════════
{
  // ⚑ Un book silenzioso da venti minuti, ma ancorato e con un tocco, si quota. L'eta' non e' un
  //   criterio di selezione: la domanda e' «e utilizzabile», non «e recente».
  for (const eta of [GTD_MS - 1000, GTD_MS + 1000, GTD_MS * 10, 3_600_000]) {
    const r = val(mkt('0xa'), { ...BASE, per: { '0xa': usabile(eta) } });
    ok(r.ammissibile === true, `⑤ eta ${Math.round(eta / 60000)} min ⇒ ancora ammissibile`);
  }
  // E nemmeno un'eta' NON LEGGIBILE esclude: se lo snapshot e ancorato e ha un tocco, e usabile.
  const senzaEta = val(mkt('0xa'), { ...BASE, per: { '0xa': usabile(null) } });
  ok(senzaEta.ammissibile === true, '⑤ ⚑ e nemmeno un eta non leggibile esclude, se il book e ancorato');
}

// ══ ⑤ IL GATE SPOSTA LO SLOT, NON LO SVUOTA — la ragione per cui esiste ═══════════════════════════
{
  // Due mercati ammissibili: uno col book morto, uno vivo. La selezione deve prendere il VIVO.
  const board = [mkt('0xmorto'), mkt('0xvivo')];
  const bookVivi = { ...BASE,
    per: { '0xmorto': usabile(5000, { needsResnapshot: true }), '0xvivo': usabile(4000) } };
  const d = S.decidiSelezione({
    board, stato: S.statoVuoto(), posizioni: { leggibile: true, conditionIds: [] },
    ora: ORA, max: 1, bookVivi,
    // il morto ha il netto migliore: senza il gate vincerebbe lui
    nettoPerMercato: { '0xmorto': 99, '0xvivo': 1 },
  });
  const entrati = d.entranti.map((x) => x.id);
  ok(!entrati.includes('0xmorto'), '⑥ ⚑ il mercato col book da risincronizzare NON entra, benche abbia il netto migliore');
  ok(entrati.includes('0xvivo'), '⑥ ⚑ e lo slot va a quello usabile — il gate SPOSTA, non svuota');
}

// ══ ⑥ IL MODULO E' ANCORA PURO ════════════════════════════════════════════════════════════════════
{
  const src = require('fs').readFileSync(require.resolve('./selezione-mercati'), 'utf8');
  const req = src.split('\n').filter((l) => /(^|[^/])\brequire\s*\(/.test(l) && !l.trim().startsWith('//'));
  ok(req.length === 0, '⑥ zero `require`: la liveness si INIETTA, non si legge da qui');
}

console.log(`selezione book vivo: ${passati}/${passati} verdi, 0 rossi`);
