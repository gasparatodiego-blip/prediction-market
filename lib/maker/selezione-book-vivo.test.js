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
const vivo = (ageMs = 5000) => ({ live: true, ageMs });

// ══ ① SENZA MAPPA, IL COMPORTAMENTO E' QUELLO DI PRIMA ════════════════════════════════════════════
{
  ok(val(mkt('0xa'), null).ammissibile === true, '① nessuna mappa ⇒ cancello non applicato');
  ok(val(mkt('0xa'), { leggibile: false }).ammissibile === true,
    '① ⚑ mappa ILLEGGIBILE ⇒ cancello non applicato: non si svuota la selezione per un file non letto');
}

// ══ ② IL MERCATO VIVO PASSA ═══════════════════════════════════════════════════════════════════════
{
  const r = val(mkt('0xa'), { leggibile: true, per: { '0xa': vivo(5000) }, etaMassimaMs: 120_000 });
  ok(r.ammissibile === true, '② book live e fresco ⇒ ammissibile');
}

// ══ ③ LE QUATTRO ESCLUSIONI, OGNUNA COL SUO NOME ══════════════════════════════════════════════════
{
  const base = { leggibile: true, etaMassimaMs: 120_000 };

  const assente = val(mkt('0xa'), { ...base, per: { '0xb': vivo() } });
  ok(assente.ammissibile === false, '③ mercato assente dalla mappa ⇒ escluso');
  ok(assente.motivo === 'book-non-sottoscritto', '③   motivo: book-non-sottoscritto');

  const nonLive = val(mkt('0xa'), { ...base, per: { '0xa': { live: false, ageMs: 5000, reason: 'stale' } } });
  ok(nonLive.ammissibile === false, '③ live:false ⇒ escluso');
  ok(nonLive.motivo === 'book-non-live', '③   motivo: book-non-live');
  ok(/stale/.test(nonLive.dettaglio), '③   e il dettaglio riporta la ragione del feed');

  const nonDatabile = val(mkt('0xa'), { ...base, per: { '0xa': { live: true, ageMs: null } } });
  ok(nonDatabile.ammissibile === false, '③ eta non leggibile ⇒ escluso');
  ok(nonDatabile.motivo === 'book-non-databile',
    '③   ⚑ motivo: book-non-databile — DISTINTO da «vecchio», perche e un guasto nostro');

  const vecchio = val(mkt('0xa'), { ...base, per: { '0xa': { live: true, ageMs: 130_000 } } });
  ok(vecchio.ammissibile === false, '③ book oltre soglia ⇒ escluso');
  ok(vecchio.motivo === 'book-vecchio', '③   motivo: book-vecchio');
  ok(/130s/.test(vecchio.dettaglio), '③   e il dettaglio dice di quanto');
}

// ══ ④ IL CONFINE E' LA SOGLIA PASSATA, PROVATO DAI DUE LATI ═══════════════════════════════════════
{
  const base = { leggibile: true, per: {}, etaMassimaMs: 120_000 };
  const sotto = val(mkt('0xa'), { ...base, per: { '0xa': { live: true, ageMs: 119_999 } } });
  ok(sotto.ammissibile === true, '④ appena sotto la soglia passa');
  const sopra = val(mkt('0xa'), { ...base, per: { '0xa': { live: true, ageMs: 120_001 } } });
  ok(sopra.ammissibile === false, '④ appena sopra viene escluso');

  // ⚑ Nessun numero cablato: spostando la soglia si sposta il confine.
  const larga = val(mkt('0xa'), { leggibile: true, per: { '0xa': { live: true, ageMs: 120_001 } }, etaMassimaMs: 200_000 });
  ok(larga.ammissibile === true, '④ ⚑ con una soglia piu larga lo stesso book passa: il confine e la soglia');
}

// ══ ⑤ IL GATE SPOSTA LO SLOT, NON LO SVUOTA — la ragione per cui esiste ═══════════════════════════
{
  // Due mercati ammissibili: uno col book morto, uno vivo. La selezione deve prendere il VIVO.
  const board = [mkt('0xmorto'), mkt('0xvivo')];
  const bookVivi = { leggibile: true, etaMassimaMs: 120_000,
    per: { '0xmorto': { live: false, ageMs: 300_000 }, '0xvivo': vivo(4000) } };
  const d = S.decidiSelezione({
    board, stato: S.statoVuoto(), posizioni: { leggibile: true, conditionIds: [] },
    ora: ORA, max: 1, bookVivi,
    // il morto ha il netto migliore: senza il gate vincerebbe lui
    nettoPerMercato: { '0xmorto': 99, '0xvivo': 1 },
  });
  const entrati = d.entranti.map((x) => x.id);
  ok(!entrati.includes('0xmorto'), '⑤ ⚑ il mercato col book morto NON entra, benche abbia il netto migliore');
  ok(entrati.includes('0xvivo'), '⑤ ⚑ e lo slot va a quello vivo — il gate SPOSTA, non svuota');
}

// ══ ⑥ IL MODULO E' ANCORA PURO ════════════════════════════════════════════════════════════════════
{
  const src = require('fs').readFileSync(require.resolve('./selezione-mercati'), 'utf8');
  const req = src.split('\n').filter((l) => /(^|[^/])\brequire\s*\(/.test(l) && !l.trim().startsWith('//'));
  ok(req.length === 0, '⑥ zero `require`: la liveness si INIETTA, non si legge da qui');
}

console.log(`selezione book vivo: ${passati}/${passati} verdi, 0 rossi`);
