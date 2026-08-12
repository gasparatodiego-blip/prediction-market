'use strict';
// lib/maker/scansione-registri.test.js — LA PULIZIA NON DIPENDE PIÙ DA CHI ITERA COSA.
//
// Il difetto: la pulizia partiva da `auto-close`, che itera le POSIZIONI. Un mercato morto SENZA
// posizione ma con voci residue nei registri non veniva mai visitato. `end-of-life-cancel` in
// `auto-reprice` chiude gli ordini ma non chiama la pulizia — e legge l'OROLOGIO, non il venue.
//
// Misurato il 12 agosto 2026: **86 mercati orfani** — nominati dai registri, fuori dal board, senza
// posizione — su 88 mercati distinti presenti nei registri operativi.

const fs = require('fs');
const path = require('path');
const SR = require('./scansione-registri');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}
const mani = (rimosso = true) => Object.fromEntries(
  ['attesaMerge', 'residui', 'chiusura', 'tetto', 'manuale', 'autoClose'].map((k) => [k, () => ({ ok: true, rimosso })]));

console.log('── 1 · L\'UNIONE DEI TRE INSIEMI, E IL TERZO È QUELLO CHE MANCAVA');
{
  const u = SR.unioneMercati({
    posizioni: [{ marketId: '0xPOS' }],
    ordini: [{ marketId: '0xORD' }],
    registri: ['0xREG', '0xPOS'],
  });
  ok('l\'unione contiene tutti e tre gli insiemi', u.mercati.length === 3);
  ok('  e deduplica normalizzando il case', u.mercati.filter((x) => x === '0xpos').length === 1);
  ok('IL MERCATO CHE ESISTE SOLO NEI REGISTRI è isolato e contato',
    u.soloRegistri.length === 1 && u.soloRegistri[0] === '0xreg');
  ok('  ed è esattamente il caso che nessun ciclo visitava', !u.soloRegistri.includes('0xpos'));
}

console.log('\n── 2 · UNA FONTE NON LETTA NON SI TRAVESTE DA «VUOTA»');
{
  const u = SR.unioneMercati({ posizioni: null, ordini: [{ marketId: '0xB' }], registri: ['0xC'] });
  ok('contribuisce zero mercati', u.mercati.length === 2);
  ok('  e viene DICHIARATA', u.fontiNonLette.includes('posizioni'));
  // ⚠ LA RAGIONE PER CUI CONTA: se «snapshot non letto» valesse «nessuna posizione», un mercato con
  // posizione aperta potrebbe finire fra i candidati alla pulizia — e la pulizia toglie il tetto di
  // capitale e la gestione manuale.
  ok('  sbagliando nella direzione innocua: si esaminano MENO mercati, mai di più', u.daPosizioni === 0);
}

console.log('\n── 3 · SI PULISCE SOLO CIÒ CHE IL VENUE DICHIARA MORTO, E SOLO A LIBRO LIBERO');
(async () => {
  const morto = await SR.scansiona({ posizioni: [], ordini: [], registri: ['0xm'],
    statoVenue: async () => ({ closed: true }), ordiniDelMercato: async () => 0, maniRegistri: mani() });
  ok('mercato chiuso + libro libero ⇒ ripulito', morto.puliti === 1);

  const vivo = await SR.scansiona({ posizioni: [], ordini: [], registri: ['0xv'],
    statoVenue: async () => ({ closed: false, acceptingOrders: true }), ordiniDelMercato: async () => 0, maniRegistri: mani() });
  ok('mercato vivo ⇒ non si tocca', vivo.morti === 0 && vivo.puliti === 0);

  const conOrdini = await SR.scansiona({ posizioni: [], ordini: [], registri: ['0xm'],
    statoVenue: async () => ({ closed: true }), ordiniDelMercato: async () => 2, maniRegistri: mani() });
  ok('morto MA con ordini a riposo ⇒ NON si pulisce', conOrdini.morti === 1 && conOrdini.puliti === 0);

  const cieco = await SR.scansiona({ posizioni: [], ordini: [], registri: ['0xm'],
    statoVenue: async () => ({ closed: true }), ordiniDelMercato: async () => null, maniRegistri: mani() });
  ok('ordini NON letti ⇒ NON si pulisce (libro non provato vuoto)', cieco.puliti === 0);

  // ⚠ «ANNULLATO» È COPERTO, e non dall'orologio: `acceptingOrders:false` con `endDate` lontana.
  const annullato = await SR.scansiona({ posizioni: [], ordini: [], registri: ['0xa'],
    statoVenue: async () => ({ closed: false, acceptingOrders: false }), ordiniDelMercato: async () => 0, maniRegistri: mani() });
  ok('un mercato ANNULLATO prima della scadenza nominale viene visto lo stesso',
    annullato.morti === 1 && annullato.puliti === 1);

  const venueMuto = await SR.scansiona({ posizioni: [], ordini: [], registri: ['0xa'],
    statoVenue: async () => null, ordiniDelMercato: async () => 0, maniRegistri: mani() });
  ok('venue che non risponde ⇒ non si conclude niente', venueMuto.morti === 0);
  const venueRotto = await SR.scansiona({ posizioni: [], ordini: [], registri: ['0xa'],
    statoVenue: async () => { throw new Error('429'); }, ordiniDelMercato: async () => 0, maniRegistri: mani() });
  ok('  e nemmeno se esplode', venueRotto.morti === 0 && venueRotto.puliti === 0);

  console.log('\n── 4 · CHI È SUL BOARD NON SI INTERROGA');
  const conBoard = await SR.scansiona({ posizioni: [], ordini: [], registri: ['0xvivo', '0xmorto'],
    suBoard: (id) => id === '0xvivo', statoVenue: async () => ({ closed: true }),
    ordiniDelMercato: async () => 0, maniRegistri: mani() });
  ok('una richiesta sola invece di due', conBoard.interrogati === 1);
  ok('  perché chiedere di un mercato sul board è una richiesta per confermare un sì', conBoard.saltati === 1);

  const tetto = await SR.scansiona({ posizioni: [], ordini: [], registri: ['0xa', '0xb', '0xc', '0xd'],
    statoVenue: async () => ({ closed: true }), ordiniDelMercato: async () => 0,
    maniRegistri: mani(), tettoInterrogazioni: 2 });
  ok('il tetto per giro limita le interrogazioni', tetto.interrogati === 2);
  ok('  e chi resta fuori NON viene concluso: si riprova fra 30 minuti',
    tetto.dettaglio.filter((d) => d.esito === 'oltre-il-tetto').length === 2);

  console.log('\n── 5 · NESSUN AUDIT VIENE CANCELLATO, MAI');
  const src = fs.readFileSync(path.join(__dirname, 'scansione-registri.js'), 'utf8');
  for (const vietato of ['audit.jsonl', 'execution-audit', 'unlinkSync', 'rmSync', 'redeem']) {
    ok(`  il modulo non nomina «${vietato}»`, !src.includes(vietato));
  }
  ok('  e non piazza né cancella ordini', !src.includes('placeOrder') && !src.includes('cancelOrder'));
  ok('la disciplina «morto + libro libero» è RIUSATA, non riscritta',
    src.includes("require('./pulizia-mercato-chiuso')") && !src.includes('function mercatoMorto'));

  console.log('\n── 6 · IL CABLAGGIO E LA CADENZA');
  const srcA = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent40-manual-reprice.js'), 'utf8');
  ok('la cadenza è 30 minuti', SR.CADENZA_MS === 30 * 60_000);
  ok('agent40 la esegue una volta all\'AVVIO', srcA.includes("await scansioneSicura('avvio')"));
  ok('  e poi a intervallo, con la cadenza del modulo (non un numero ricopiato)',
    srcA.includes("require('../lib/maker/scansione-registri').CADENZA_MS"));
  ok('  in un try/catch suo: una scansione fallita non perde un ciclo di riprezzo',
    srcA.includes('scansione registri fallita (non fatale)'));
  ok('gli ordini si leggono UNA volta e si raggruppano, non uno per mercato',
    srcA.includes("listManualOrders({ marketId: null })") && srcA.includes('perMercato.set(id'));
  ok('  e una lettura fallita NON diventa «zero ordini»',
    srcA.includes('(perMercato ? (perMercato.get(id) || 0) : null)'));
  ok('lo stato del mercato si chiede al VENUE, non all\'orologio',
    srcA.includes('leggiVenueClob({ marketId: id })'));
  ok('i registri scanditi includono i residui SOTTO MINIMO',
    srcA.includes('data/residui-sotto-soglia.json'));
  ok('  e tutti e sei quelli operativi più la allowlist dell\'uscita',
    ['merge-attese', 'residui-scoperti', 'modalita-chiusura', 'maker-allocated-capital', 'maker-manual-mode', 'maker-auto-close']
      .every((f) => srcA.includes(`data/${f}.json`)));

  console.log(`\n${falliti === 0 ? '✅ TUTTI VERDI' : '❌ ROSSI'}: ${passati} passati, ${falliti} falliti`);
  process.exit(falliti === 0 ? 0 : 1);
})();
