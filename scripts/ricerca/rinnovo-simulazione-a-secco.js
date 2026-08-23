'use strict';
// scripts/ricerca/rinnovo-simulazione-a-secco.js — SOLA LETTURA.
//
// A/B del filo di `rinnovo` fra `valutaMercato` e `trovaLivello`, sui mercati che hanno PERSO ordini
// per GTD nelle ultime 2 ore. Usa le funzioni VERE — `resolveMarketRules`, `resolveMarketDepth`,
// `decideReprice`, `scalaPerIlMotore`, `provaRinnovo`, `valutaMercato`, `mediaProfonditaAltrui` — e
// non ricopia nessuna aritmetica. Non piazza, non cancella, non scrive niente fuori da data/ricerca/.
//
// IL CONTROFATTUALE E' ESATTO, non stimato: si chiama `valutaMercato` DUE volte sugli stessi ingressi,
// una con `rinnovo: null` (che riproduce byte per byte il sorgente di ieri, dove il parametro non
// veniva destrutturato) e una con la prova vera.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const MO = require(path.join(ROOT, 'lib/maker/manual-order'));
const { decideReprice, selectOwnedOrders, scalaPerIlMotore } = require(path.join(ROOT, 'lib/maker/auto-reprice'));
const { loadAutoRepriceTuning } = require(path.join(ROOT, 'lib/maker/auto-reprice-config'));
const { valutaMercato } = require(path.join(ROOT, 'lib/maker/motore-unico'));
const { provaRinnovo } = require(path.join(ROOT, 'lib/maker/esenzione-rinnovo'));
const { mediaProfonditaAltrui } = require(path.join(ROOT, 'lib/maker/profondita-altrui'));
const { nostriSulLato } = require(path.join(ROOT, 'lib/maker/nostri-ordini'));
const { resolveOffsetFor } = require(path.join(ROOT, 'lib/maker/offset-config'));

const ORE = Number(process.argv[2] || 2);
const AUDIT = path.join(ROOT, 'data/polymarket-maker-audit.jsonl');
const ORDINI = path.join(ROOT, 'data/ricerca/ordini-vivi-21ago.json');

// ── ① I MERCATI CHE HANNO PERSO ORDINI PER GTD NELLE ULTIME `ORE` ORE ────────────────────────────
function mercatiCheHannoPerso(dopo) {
  const morti = [];
  const buf = fs.readFileSync(AUDIT, 'utf8');   // grep-equivalente: si filtra per stringa prima di parsare
  for (const riga of buf.split('\n')) {
    if (riga.indexOf('"scaduto-senza-rinnovo"') < 0) continue;
    let r; try { r = JSON.parse(riga); } catch { continue; }
    if (!r || r.outcome !== 'scaduto-senza-rinnovo' || !(r.ts >= dopo)) continue;
    morti.push(r);
  }
  return morti;
}

const classifica = (m) => {
  const s = String(m || '');
  if (/la banda finisce prima del pavimento/.test(s)) return 'pavimento';
  if (/livello: la ricerca parte dal secondo/.test(s)) return 'meno-di-2-livelli';
  if (/banda premiante non calcolabile/.test(s)) return 'banda-non-calcolabile';
  if (/profondit. non leggibile/.test(s)) return 'profondita-non-leggibile';
  return s.slice(0, 60);
};

(async () => {
  const now = Date.now();
  const morti = mercatiCheHannoPerso(now - ORE * 3600_000);
  let cids = [...new Set(morti.map((r) => '0x' + String(r.marketRef || '').replace(/^cid_/, '')))];
  // `--tutti` allarga il campione a OGNI mercato con ordini nostri a riposo. La finestra dei 2 h resta
  // il caso chiesto; il campione largo serve a dire se il risultato dipende da quali 7 mercati sono.
  if (process.argv.includes('--tutti')) {
    cids = [...new Set(JSON.parse(fs.readFileSync(ORDINI, 'utf8')).ordini.map((o) => String(o.market)))];
    console.log(`(--tutti) campione allargato a ${cids.length} mercati con ordini a riposo`);
  }
  const nozMorto = morti.reduce((s, r) => s + (Number(r.observed && r.observed.notionalUsd) || 0), 0);
  console.log(`\n══ FINESTRA: ultime ${ORE} h (da ${new Date(now - ORE * 3600_000).toISOString()}) ══`);
  console.log(`ordini morti per GTD senza rinnovo: ${morti.length} · $${nozMorto.toFixed(2)} · su ${cids.length} mercati`);
  const perGate = {}; for (const r of morti) { const g = r.gate || '(non dichiarata)'; perGate[g] = (perGate[g] || 0) + 1; }
  console.log('per gate:', JSON.stringify(perGate));

  const vivi = JSON.parse(fs.readFileSync(ORDINI, 'utf8')).ordini;
  const config = loadAutoRepriceTuning();
  const righe = [];

  for (const cid of cids) {
    const rules = MO.resolveMarketRules(cid);
    const depth = MO.resolveMarketDepth(cid);
    // Gli ordini NOSTRI di questo mercato, nella forma che il ciclo usa (`selectOwnedOrders`).
    const grezzi = vivi.filter((o) => String(o.market).toLowerCase() === cid.toLowerCase()).map((o) => ({
      orderId: o.id, marketId: o.market, tokenId: String(o.asset_id), side: o.side,
      price: Number(o.price), size: Number(o.size), sizeRemaining: Number(o.size) - Number(o.matched || 0),
      sizeMatched: Number(o.matched || 0), source: 'manual-ui', status: 'LIVE',
      secondsToExpiry: o.expiration ? Math.round(Number(o.expiration) - now / 1000) : null,
      expiresAtMs: o.expiration ? Number(o.expiration) * 1000 : null,
    }));
    const owned = selectOwnedOrders(grezzi, { marketId: cid, rules });
    if (!owned.length) { righe.push({ cid, stato: 'nessun ordine nostro a riposo adesso', n: 0 }); continue; }

    for (const order of owned) {
      const d = decideReprice({ order, rules, config, lastRepriceAt: null, consecutiveBreaches: 0, repricesThisHour: 0, now,
        ownOrders: nostriSulLato({ orders: owned, book: order.book }).ordini, ownOrdersAuthoritative: true },
      { resolveOffset: resolveOffsetFor, resolveDepth: () => depth });
      const nl = nostriSulLato({ orders: owned, book: order.book }).ordini;
      const sc = scalaPerIlMotore({ rules, book: order.book, side: order.side, scoringMid: d.scoringMid, ownOrders: nl, depth });
      const la = (() => { try { const m = mediaProfonditaAltrui({ marketId: cid }); return { mediaUsd: m.mediaUsd, campioni: m.campioni }; } catch { return { mediaUsd: null, campioni: 0 }; } })();
      const prezzoCheParte = d.targetPrice != null ? d.targetPrice : order.price;
      const rinnovo = provaRinnovo({ conditionId: cid, tokenId: order.tokenId, side: order.side,
        size: order.size, price: prezzoCheParte, ordiniVivi: owned });
      const base = {
        marketId: cid, side: 'BUY', bookLevels: sc.bookLevels, bandBounds: sc.bandBounds,
        bandRadiusCents: d.bandRadiusC, tick: rules.tick, scoringMid: sc.scoringMid, ownOrders: sc.ownOrders,
        proposedSize: order.size, proposedPrice: prezzoCheParte,
        // Il tetto per mercato NON e' oggetto di questo lavoro: gli si passano gli stessi ingressi nei
        // due rami, quindi la differenza fra A e B puo' venire solo dal pavimento di profondita'.
        saldoUsd: null, esposizioneMercatoUsd: 0,
        liquiditaMediaUsd: la.mediaUsd, liquiditaCampioniAltrui: la.campioni,
      };
      const A = valutaMercato({ ...base, rinnovo: null });          // sorgente di ieri: filo tagliato
      const B = valutaMercato({ ...base, rinnovo });                // sorgente di oggi: filo attaccato
      const soloProf = (v) => v.bocciature.filter((b) => b.regola === 'profondita-insufficiente');
      righe.push({
        cid, orderId: String(order.orderId).slice(0, 12), book: order.book, side: order.side,
        price: order.price, size: order.size, noz: +(order.price * order.size).toFixed(2),
        esente: rinnovo.esente, motivoRinnovo: rinnovo.esente ? null : rinnovo.motivo,
        pavimento: A.controlli.pavimento ? A.controlli.pavimento.usd : null,
        depthAhead: A.controlli.livello ? A.controlli.livello.depthAheadUsd : null,
        A_prof: soloProf(A).length ? soloProf(A)[0].motivo : null,
        B_prof: soloProf(B).length ? soloProf(B)[0].motivo : null,
        recuperato: !!(soloProf(A).length && !soloProf(B).length),
        // La sottocausa, con gli stessi nomi con cui si contano i 49 del giornale.
        classe: soloProf(A).length ? classifica(soloProf(A)[0].motivo) : null,
      });
    }
  }

  const conOrdine = righe.filter((r) => r.orderId);
  const bloccatiPrima = conOrdine.filter((r) => r.A_prof);
  const recuperati = conOrdine.filter((r) => r.recuperato);
  const restano = bloccatiPrima.filter((r) => !r.recuperato);
  const nozRec = recuperati.reduce((s, r) => s + r.noz, 0);
  const nozBloc = bloccatiPrima.reduce((s, r) => s + r.noz, 0);

  console.log(`\n══ A/B SUGLI ORDINI VIVI DI QUEI MERCATI (${conOrdine.length} ordini) ══`);
  for (const r of conOrdine) {
    console.log(` ${r.cid.slice(0, 12)} ${r.orderId} ${r.book.toUpperCase()} ${r.side} ${r.price}x${r.size} $${r.noz}`
      + ` · pav $${r.pavimento != null ? r.pavimento.toFixed(2) : '?'} davanti $${r.depthAhead != null ? r.depthAhead.toFixed(2) : '?'}`
      + ` · PRIMA ${r.A_prof ? 'RIFIUTATO' : 'ok'} · DOPO ${r.B_prof ? 'RIFIUTATO' : 'ok'}`
      + (r.recuperato ? '  ⇒ RECUPERATO' : (r.A_prof ? `  ⇒ resta: ${r.B_prof}` : ''))
      + (r.esente ? '' : `  [non esente: ${r.motivoRinnovo}]`));
  }
  console.log(`\nrifiutati da profondita-insufficiente PRIMA: ${bloccatiPrima.length} · $${nozBloc.toFixed(2)}`);
  console.log(`recuperati dal filo:                        ${recuperati.length} · $${nozRec.toFixed(2)}`);
  console.log(`restano rifiutati (illiquidi veri):         ${restano.length} · $${(nozBloc - nozRec).toFixed(2)}`);
  console.log(`quota recuperata: ${bloccatiPrima.length ? (100 * recuperati.length / bloccatiPrima.length).toFixed(1) : '—'}% degli ordini`
    + `, ${nozBloc ? (100 * nozRec / nozBloc).toFixed(1) : '—'}% del nozionale`);

  console.log('\n══ PER SOTTOCAUSA — gli stessi nomi con cui si contano i 49 del giornale ══');
  const classi = [...new Set(bloccatiPrima.map((r) => r.classe))];
  for (const c of classi) {
    const g = bloccatiPrima.filter((r) => r.classe === c);
    const rec = g.filter((r) => r.recuperato);
    console.log(` ${c.padEnd(24)} rifiutati ${g.length} ($${g.reduce((s2, r) => s2 + r.noz, 0).toFixed(2)})`
      + ` · recuperati ${rec.length} ($${rec.reduce((s2, r) => s2 + r.noz, 0).toFixed(2)})`
      + ` · ${g.length ? (100 * rec.length / g.length).toFixed(0) : '—'}%`);
  }
  // Non-monotonia: un ordine che PASSAVA e adesso non passa. Deve essere ZERO, per costruzione.
  const regressioni = conOrdine.filter((r) => !r.A_prof && r.B_prof);
  console.log(`\nREGRESSIONI (passava prima, rifiutato dopo): ${regressioni.length} — deve essere 0`);
  const nonEsenti = conOrdine.filter((r) => !r.esente);
  console.log(`ordini NON esenti (non stanno rinnovando: size o nozionale in aumento): ${nonEsenti.length}/${conOrdine.length}`);

  fs.writeFileSync(path.join(ROOT, 'data/ricerca/rinnovo-simulazione-a-secco.json'), JSON.stringify({
    atIso: new Date(now).toISOString(), ore: ORE, mortiInFinestra: morti.length, nozionaleMorto: +nozMorto.toFixed(2),
    perGate, mercati: cids, righe,
    bloccatiPrima: bloccatiPrima.length, recuperati: recuperati.length, restano: restano.length,
    nozionaleBloccato: +nozBloc.toFixed(2), nozionaleRecuperato: +nozRec.toFixed(2),
  }, null, 2));
})();
