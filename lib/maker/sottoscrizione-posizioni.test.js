'use strict';
// lib/maker/sottoscrizione-posizioni.test.js — UN MERCATO DOVE ABBIAMO DEL DENARO NON RESTA CIECO.
//
// ═══ IL DIFETTO, MISURATO ═══════════════════════════════════════════════════════════════════════════
// agent34-clob-ws aveva quattro corsie di sottoscrizione — board premi, tracking, piano, permessi
// temporanei — e nessuna guardava le POSIZIONI. Un mercato che esce dal tabellone si portava via il suo
// libro, mentre noi ci tenevamo dentro capitale vero.
//
// Il 9 agosto 2026 alle 11:32, dopo un riavvio PULITO di agent34 (quindi non è staleness):
//   London 18°C  23,15 share  FUORI dal board   ⇒ assente dallo snapshot
//   Chengdu      21,69 share  SUL board         ⇒ assente lo stesso (SUBSCRIPTION_CAP 90 < 105 del board)
// Due cause diverse, stesso effetto: nessun libro. E a valle non era teorico —
// `pianificaRiposizionamentoScoperto` non poteva sapere davanti a chi mettersi, e il completamento della
// coppia veniva rifiutato con `would-cross` a ogni giro (§5 punto 60).
//
// LA CORSIA DELLE POSIZIONI RISOLVE ENTRAMBI I CASI senza toccare nessun tetto: tutti e due i mercati
// ciechi avevano una posizione aperta.

const A = require('../../agents/agent34-clob-ws');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

const LONDRA18 = '0xc00c23bbbe2414e8d79516455d62ecd7088297d7bb9328d7b83d14f776e5c08f';
const CHENGDU = '0x462e02874210ad57bddbba780a3b1249776ca7cc38305b99e55ccfdb7c8586df';
const BOARD = '0xa7245f903c604b2a0ddbd9a454600395d06e0e2d4f28f8fe227fffdbb923a1c1';   // Dallas, gia' sul board

const meta = (id) => ({ conditionId: id, yesTokenId: `${id}-y`, noTokenId: `${id}-n`, title: 'm' });
const posizioni = (righe) => ({ readable: true, positions: righe, ageMs: 0, reason: null });

(async () => {
  console.log('── 1 · I DUE MERCATI CIECHI DEL 9 AGOSTO ENTRANO NELLA SOTTOSCRIZIONE');
  {
    // Il board contiene solo un altro mercato: né London 18 (uscito) né Chengdu (tagliato dal tetto).
    const into = new Map([[BOARD, { ...meta(BOARD), source: 'board' }]]);
    const r = await A.unionPositionMarkets(into, {
      posizioni: posizioni([
        { conditionId: LONDRA18, size: 23.15, avgPrice: 0.65 },
        { conditionId: CHENGDU, size: 21.69, avgPrice: 0.6164 },
      ]),
      meta: (id) => meta(id),
      operatorMeta: (id) => meta(id),
    });
    const ids = [...r.keys()];
    ok('London 18°C è sottoscritto anche se è FUORI dal board', ids.includes(LONDRA18));
    ok('Chengdu è sottoscritto anche se il tetto del board lo tagliava', ids.includes(CHENGDU));
    ok('  e il mercato del board resta', ids.includes(BOARD));
    ok('  marcati con la loro provenienza', r.get(LONDRA18) && r.get(LONDRA18).source === 'posizione-aperta',
      r.get(LONDRA18) && r.get(LONDRA18).source);
    ok('  e riconoscibili come «ha una posizione»', r.get(CHENGDU) && r.get(CHENGDU).posizione === true);
    const st = A.positionLaneState();
    ok('la corsia dichiara cosa ha sottoscritto', st.active.length === 2, JSON.stringify(st.active.map((x) => x.slice(0, 10))));
    ok('  e non ha scartato niente', st.dropped.length === 0);
  }

  console.log('\n── 2 · UN MERCATO GIÀ SOTTOSCRITTO NON VIENE DUPLICATO');
  {
    const into = new Map([[LONDRA18, { ...meta(LONDRA18), source: 'board' }]]);
    const r = await A.unionPositionMarkets(into, {
      posizioni: posizioni([{ conditionId: LONDRA18, size: 23.15 }]),
      meta: (id) => meta(id), operatorMeta: (id) => meta(id),
    });
    ok('resta una voce sola', r.size === 1, String(r.size));
    ok('  con la provenienza originale intatta', r.get(LONDRA18).source === 'board');
    ok('  ma marcata come «ha una posizione»', r.get(LONDRA18).posizione === true);
  }

  console.log('\n── 3 · FAIL-CLOSED: NON SI DEDUCE «NESSUNA POSIZIONE» DA UNA LETTURA FALLITA');
  {
    const base = () => new Map([[BOARD, { ...meta(BOARD), source: 'board' }]]);
    for (const [nome, snap] of [
      ['snapshot illeggibile', { readable: false, positions: [], reason: 'mai scritto' }],
      ['snapshot assente', null],
    ]) {
      const r = await A.unionPositionMarkets(base(), { posizioni: snap, meta, operatorMeta: meta });
      ok(`${nome} ⇒ la corsia non tocca niente`, r.size === 1 && [...r.keys()][0] === BOARD);
      ok('  e non dichiara sottoscrizioni', A.positionLaneState().active.length === 0);
    }

    // Una posizione a zero non è una posizione: non si sottoscrive un mercato dove non c'è niente.
    const zero = await A.unionPositionMarkets(base(), {
      posizioni: posizioni([{ conditionId: LONDRA18, size: 0 }, { conditionId: CHENGDU, size: -3 }]),
      meta, operatorMeta: meta,
    });
    ok('una posizione a zero o negativa non sottoscrive', zero.size === 1, String(zero.size));

    // Duplicati nello snapshot (due token dello stesso mercato) ⇒ una sottoscrizione sola.
    const dup = await A.unionPositionMarkets(base(), {
      posizioni: posizioni([{ conditionId: LONDRA18, size: 10 }, { conditionId: LONDRA18, size: 5 }]),
      meta, operatorMeta: meta,
    });
    ok('i due token dello stesso mercato non lo sottoscrivono due volte', dup.size === 2, String(dup.size));
  }

  console.log('\n── 4 · LA CORSIA È CABLATA, E PRIMA DI QUELLE A PRIORITÀ MINORE');
  {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent34-clob-ws.js'), 'utf8');
    ok('la corsia viene chiamata nel giro di sottoscrizione', /await unionPositionMarkets\(desired\)/.test(src));
    const iPos = src.indexOf('await unionPositionMarkets(desired)');
    const iPlan = src.indexOf('await unionPlanMarkets(desired)');
    const iLease = src.indexOf('await unionLeaseMarkets(desired)');
    ok('  prima del piano e dei permessi temporanei', iPos > 0 && iPos < iPlan && iPlan < iLease,
      `posizioni@${iPos} < piano@${iPlan} < permessi@${iLease}`);
    ok('  e riusa readVenuePositions invece di inventare una fonte',
      /require\('\.\.\/lib\/safety\/venue-positions-snapshot'\)/.test(src));
    ok('se serve spazio cede un mercato del BOARD, non la posizione',
      /evictWeakestRewardMarket\(into, 'un mercato con una posizione aperta'\)/.test(src));
    ok('e uno scarto non resta muto', /CON POSIZIONE APERTA non sottoscritti/.test(src));
  }

  console.log(`\n${falliti === 0 ? 'TUTTI VERDI' : 'ROSSI'}: ${passati} passati, ${falliti} falliti`);
  process.exit(falliti === 0 ? 0 : 1);
})().catch((e) => { console.log(`\nROSSI: ${e && e.stack ? e.stack : e}`); process.exit(1); });
