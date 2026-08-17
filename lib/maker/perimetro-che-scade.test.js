#!/usr/bin/env node
'use strict';
// lib/maker/perimetro-che-scade.test.js — DUE DIFETTI CHIUSI: il piano che sopravvive alla selezione,
// e la scadenza che non toglieva il mercato dal perimetro.
//
// ═══ ① IL PIANO SALVATO SOPRAVVIVEVA A UN CAMBIO DI SELEZIONE ════════════════════════════════════════
// `restringiAllaSelezione` vive in `calcolaPianoFuoriProcesso` (`agent41:520`), l'unico punto da cui il
// piano NASCE. Ma `miniCiclo` non ricalcola nel caso comune: prende le righe dal piano SALVATO se e'
// fresco, e `PIANO_FRESCO_MAX_MS` vale SESSANTA MINUTI. Misurato sul sorgente: nel corpo di `miniCiclo`
// le occorrenze di `selezion`/`idsAttivi` erano ZERO. Un mercato uscito dalla selezione restava
// piazzabile per un'ora — la forma esatta del quarto mercato comparso in allowlist il 16 agosto.
//
// ═══ ② LA SCADENZA NON TOGLIEVA IL MERCATO DAL PERIMETRO ════════════════════════════════════════════
// Lo facevano la SELEZIONE (solo se accesa: oggi e' spenta) e il ciclo da 6 ORE (che al piu' lo toglie dal
// PIANO). Sei ore sono la cadenza sbagliata per una scadenza, e il perno del giro controllato scade fra
// ~28 h.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SCAD = require('./scadenza-fuori-perimetro');
const { MIN_HORIZON_DAYS } = require('../rewards/horizon');

let pass = 0; let fail = 0;
const ok = (nome, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { fail += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
};
const ORA = 1_700_000_000_000;
const h = (n) => ORA + n * 3_600_000;
const A = `0x${'a1'.repeat(32)}`;
const B = `0x${'b2'.repeat(32)}`;

console.log('\n══ 1 · LA SOGLIA E\' DERIVATA, NON UN NUMERO NUOVO');
{
  ok('il pavimento in ore viene da MIN_HORIZON_DAYS', SCAD.ORE_MINIME === MIN_HORIZON_DAYS * 24,
    `${SCAD.ORE_MINIME} h = ${MIN_HORIZON_DAYS} g × 24`);
  const src = fs.readFileSync(path.join(__dirname, 'scadenza-fuori-perimetro.js'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok('  e non c\'e\' nessun numero di ore cablato nel modulo', !/ORE_MINIME\s*=\s*[0-9]/.test(src));
}

console.log('\n══ 2 · CHI ESCE, CHI RESTA');
{
  const base = { abilitati: [A, B], ora: ORA, conPosizione: [], conOrdiniVivi: [],
    scadenzaMs: (id) => (id === A.toLowerCase() ? h(2) : h(48)) };
  const v = SCAD.valutaScadenze(base);
  ok('un mercato a 2 h dalla scadenza ESCE dal perimetro', v.daRilasciare.length === 1 && v.daRilasciare[0].id === A.toLowerCase());
  ok('  e uno a 48 h resta', v.tenuti.length === 1 && v.tenuti[0].id === B.toLowerCase());
  ok('  e il motivo porta le ore e il pavimento', /2\.0 h sotto il pavimento di 12 h/.test(v.daRilasciare[0].motivo), v.daRilasciare[0].motivo.slice(0, 90));

  const chiuso = SCAD.valutaScadenze({ ...base, scadenzaMs: () => h(200), chiuso: (id) => id === A.toLowerCase() });
  ok('un mercato CHIUSO al venue esce anche se la scadenza nominale e\' lontana',
    chiuso.daRilasciare.length === 1 && chiuso.daRilasciare[0].chiusoAlVenue === true);
}

console.log('\n══ 3 · LE DUE COSE CHE TENGONO UN MERCATO DENTRO, E SONO QUELLE CHE COSTANO SE SBAGLIATE');
{
  const scaduti = { abilitati: [A], ora: ORA, scadenzaMs: () => h(1) };
  const conPos = SCAD.valutaScadenze({ ...scaduti, conPosizione: [A], conOrdiniVivi: [] });
  ok('scaduto MA con una posizione aperta ⇒ RESTA abilitato', conPos.daRilasciare.length === 0 && conPos.tenuti.length === 1);
  ok('  e il motivo dice perche\' (la gamba morirebbe di GTD prima dei 30 minuti della scala)',
    /GTD in 23 minuti invece dei 30/.test(conPos.tenuti[0].motivo));
  const conOrd = SCAD.valutaScadenze({ ...scaduti, conPosizione: [], conOrdiniVivi: [A] });
  ok('scaduto MA con ordini a riposo ⇒ RESTA abilitato', conOrd.daRilasciare.length === 0);
}

console.log('\n══ 4 · FAIL-CLOSED IN TUTTE E QUATTRO LE DIREZIONI');
{
  const scaduti = { abilitati: [A], ora: ORA, scadenzaMs: () => h(1) };
  ok('posizioni NON leggibili (null) ⇒ nessun rilascio',
    SCAD.valutaScadenze({ ...scaduti, conPosizione: null, conOrdiniVivi: [] }).daRilasciare.length === 0);
  ok('ordini NON leggibili (null) ⇒ nessun rilascio',
    SCAD.valutaScadenze({ ...scaduti, conPosizione: [], conOrdiniVivi: null }).daRilasciare.length === 0);
  ok('  e in entrambi i casi il motivo distingue «non ho letto» da «non c\'e\' niente»',
    /non e' un mercato vuoto/.test(SCAD.valutaScadenze({ ...scaduti, conPosizione: null, conOrdiniVivi: [] }).motivo));
  const senzaScad = SCAD.valutaScadenze({ abilitati: [A], ora: ORA, conPosizione: [], conOrdiniVivi: [], scadenzaMs: () => null });
  ok('scadenza NON determinabile ⇒ NON si rilascia', senzaScad.daRilasciare.length === 0 && senzaScad.tenuti.length === 1);
  ok('  ed e\' l\'OPPOSTO di §4.4 (dove una scadenza ignota ESCLUDE dal piano), di proposito',
    /NON si rilascia/i.test(senzaScad.tenuti[0].motivo), senzaScad.tenuti[0].motivo.slice(0, 80));
  ok('allowlist non leggibile ⇒ nessun rilascio', SCAD.valutaScadenze({ abilitati: null, ora: ORA, conPosizione: [], conOrdiniVivi: [] }).daRilasciare.length === 0);
}

console.log('\n══ 5 · IL CABLAGGIO: GIRA ANCHE A SELEZIONE SPENTA, E RILASCIA DAVVERO');
{
  const A41 = require(path.join(__dirname, '..', '..', 'agents', 'agent41-realloc-scheduler'));
  const rilasciati = [];
  // ⚠ Nessuna dep di scrittura vera: `rilascia` e' iniettata, quindi la allowlist del bot non si tocca.
  const r = A41.scadenzeFuoriPerimetro({
    leggiConfig: () => ({ readable: true, markets: { [A.toLowerCase()]: { enabled: true }, [B.toLowerCase()]: { enabled: true } } }),
    conPosizione: [], conOrdiniVivi: [],
    ora: ORA, scadenzaMs: (id) => (id === A.toLowerCase() ? h(3) : h(72)),
    rilascia: async ({ marketId, motivo }) => { rilasciati.push({ marketId, motivo }); return { ok: true }; },
  });
  return r.then((esito) => {
    ok('rilascia SOLO il mercato scaduto', rilasciati.length === 1 && rilasciati[0].marketId === A.toLowerCase(), JSON.stringify(rilasciati));
    ok('  con il motivo `scaduto` (distinguibile in audit da `fuori-selezione`)', rilasciati[0].motivo === 'scaduto');
    ok('  e il referto lo dichiara', esito.ok === true && esito.rilasciati.length === 1 && esito.tenuti === 1);

    // ⚠ LA PROPRIETA' CHE CONTA: questa funzione NON guarda la selezione. `riconciliaAllowlist` si
    // astiene a selezione spenta — giustamente, deriva da lei — e senza questa il caso di oggi (selezione
    // SPENTA e un mercato che scade) non era coperto da nessuno.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
    const corpo = src.slice(src.indexOf('async function scadenzeFuoriPerimetro'), src.indexOf('// ══ IL PRESIDIO: NESSUNA POSIZIONE'));
    const codice = corpo.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    ok('non consulta la selezione: gira anche quando e\' spenta', !/selezioneAttiva|sel\.attiva/.test(codice));
    ok('e spegne SOLO l\'ingresso: nessun `setAutoClose`, nessuna cancellazione',
      !/setAutoClose|cancel/i.test(codice));
    ok('  passando da `rilasciaDallaSelezione`, che tocca solo `setAutoReprice`', /rilasciaDallaSelezione/.test(codice));
    ok('e scrive a verbale ANCHE quando non rilascia niente (§5-bis p.171)',
      /esito: v\.motivo \? 'astenuta' : 'niente-da-rilasciare'/.test(corpo));

    console.log('\n══ 6 · IL MINI-CICLO RIFA\' L\'INTERSEZIONE CON LA SELEZIONE, SU ENTRAMBE LE FONTI');
    const mc = src.slice(src.indexOf('async function miniCiclo'), src.indexOf('function messaggioFeedRiseminato'));
    const mcCodice = mc.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    ok('`miniCiclo` adesso consulta la selezione', /selezioneAttiva\(\)/.test(mcCodice));
    ok('  e usa `idsAttivi`, non `ids` (un mercato in gestione sta chiudendo)', /sel\.idsAttivi/.test(mcCodice));
    // ⚠ ENTRAMBE LE FONTI, e la prova e' che `adattaAlleSoglie` non sia piu' chiamata direttamente da
    // nessuna delle due: e' la stessa lezione di §5 p.130, dove la correzione era INERTE perche' la
    // ricostruzione sovrascriveva le righe adattate.
    ok('il piano SALVATO passa da `righeAmmesse`', /righeAmmesse\(piano\.righe, 'piano salvato'\)/.test(mcCodice));
    ok('la RICOSTRUZIONE passa da `righeAmmesse`', /righeAmmesse\(righeFresche, 'ricostruzione'\)/.test(mcCodice));
    ok('  e nessuna fonte chiama piu\' `adattaAlleSoglie` da sola',
      (mcCodice.match(/adattaAlleSoglie\(/g) || []).length === 1, 'una sola occorrenza: la definizione dentro `righeAmmesse`');
    ok('e il taglio si DICHIARA nel referto (`fuoriSelezione`)', /referto\.fuoriSelezione/.test(mc));

    console.log(`\nperimetro che scade: ${pass} passati, ${fail} falliti\n`);
    assert.strictEqual(fail, 0, `${fail} asserzioni fallite`);
  });
}
