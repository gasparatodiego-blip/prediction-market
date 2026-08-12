'use strict';
// lib/maker/pulizia-mercato-chiuso.js — QUANDO UN MERCATO MUORE, I SUOI REGISTRI SE NE VANNO CON LUI.
//
// ═══ IL PROBLEMA ═════════════════════════════════════════════════════════════════════════════════════
// Alla fine della vita di un mercato il sistema faceva due cose su sei: `end-of-life-cancel` toglie gli
// ordini a riposo (auto-reprice) e `allowlist-auto-off` lo toglie dalla allowlist live-min. Tutto il
// resto restava scritto — l'attesa di merge, il residuo scoperto, la modalità chiusura, il tetto di
// capitale, la gestione manuale, l'opt-in dell'uscita automatica — e ogni ciclo continuava a visitarlo
// per poi rifiutarsi di fare qualcosa. Un mercato risolto restava così un abitante permanente di sei
// file di stato, e §5 punto 57 racconta cosa costa lasciare voci morte in quei registri.
//
// ═══ «RISOLTO» E «ANNULLATO» SONO LA STESSA DOMANDA, E NON SI CHIEDE ALL'OROLOGIO ═══════════════════
// `market-clock` legge `endDate`, quindi vede un mercato che arriva alla sua scadenza NOMINALE. Un
// mercato annullato prima — voidato, risolto in anticipo, ritirato — quella scadenza non la raggiunge
// mai, e per l'orologio è ancora vivo.
//
// La domanda giusta non è «che ora è» ma «il venue lo accetta ancora?», e la risposta è già in casa:
// `leggiVenueClob` restituisce `closed` e `acceptingOrders`, ed è la stessa lettura che `decideClose`
// usa dal 4 agosto come PRIMO gate. La pulizia si attacca a quella, non al calendario — così copre la
// risoluzione ordinaria e l'annullamento con lo stesso codice, senza doverli distinguere.
//
// ═══ COSA NON FA, E VA DETTO ═════════════════════════════════════════════════════════════════════════
// · NON riscatta niente. Il redeem delle posizioni è fuori perimetro per decisione dell'operatore, e
//   `redeemPosition` resta senza chiamanti (§5 punto 48). Una posizione su un mercato risolto continua
//   a valere il suo esito: qui si toglie la BUROCRAZIA, non il capitale.
// · NON cancella ordini. Lo fa già `end-of-life-cancel`, che è l'unica direzione che riduce esposizione
//   e non passa da qui.
// · NON tocca gli audit. `cancellare un audit non è pulizia` è già la regola di questo repo (§5 punto 63):
//   i giornali restano, spariscono solo i registri di STATO CORRENTE.
//
// ═══ L'ORDINE CONTA, E FALLISCE APERTO ═══════════════════════════════════════════════════════════════
// Ogni registro si pulisce per conto suo e un fallimento NON ferma gli altri: sono sei stati
// indipendenti, e mezza pulizia è meglio di nessuna. Ma la pulizia nel complesso è subordinata a una
// condizione dura, verificata dal chiamante: **si pulisce solo a libro libero**. Togliere il tetto di
// capitale o la gestione manuale mentre un nostro ordine è ancora vivo lascerebbe un ordine vero su un
// mercato che il sistema non governa più — è la stessa disciplina di `allowlist-auto-off`
// (`auto-reprice.js`), che si applica solo quando ogni cancellazione è confermata.
//
// ═══ PURO NEL SENSO CHE CONTA ════════════════════════════════════════════════════════════════════════
// Non apre nessun file: ogni registro arriva come una coppia di funzioni iniettate. La regola si prova
// senza disco, e chi possiede il disco (agent40) resta l'unico a scriverlo.

const REGISTRI = [
  // chiave           che cos'è                                            file
  ['attesaMerge', 'l\'attesa del completamento di coppia', 'data/merge-attese.json'],
  ['residui', 'il residuo scoperto sotto il minimo', 'data/residui-scoperti.json'],
  ['chiusura', 'la modalità chiusura', 'data/modalita-chiusura.json'],
  ['tetto', 'il tetto di capitale per questo mercato', 'data/maker-allocated-capital.json'],
  ['manuale', 'la gestione manuale', 'data/maker-manual-mode.json'],
  ['autoClose', 'l\'opt-in dell\'uscita automatica', 'data/maker-auto-close.json'],
];

/**
 * PULISCE I SEI REGISTRI DI UN MERCATO MORTO.
 *
 * @param a.marketId     il mercato
 * @param a.causa        'closed' | 'not-accepting' | 'end-of-life' — viaggia nel referto e nell'audit
 * @param a.libroLibero  `true` solo se è PROVATO che non abbiamo più ordini a riposo qui. Qualunque
 *                       altro valore — compreso `null` per «non l'ho letto» — blocca tutto: non si
 *                       smette di governare un mercato su cui potremmo avere un ordine vivo.
 * @param a.registri     { chiave: (marketId) => {ok:boolean, rimosso:boolean, motivo?:string} }
 *                       Una chiave assente NON è un errore: quel registro non è cablato da questo
 *                       chiamante e si dichiara `non-cablato`.
 * @returns {{ok:boolean, puliti:string[], falliti:object[], saltati:string[], motivo:string}}
 */
function pulisciRegistri({ marketId = null, causa = null, libroLibero = null, registri = {} } = {}) {
  const vuoto = (motivo) => ({ ok: false, puliti: [], falliti: [], saltati: REGISTRI.map((r) => r[0]), motivo });
  if (!marketId || typeof marketId !== 'string') return vuoto('mercato non indicato: non si pulisce niente');
  // `=== true` e non truthy: «non ho letto gli ordini» deve valere NO, non «probabilmente sì».
  if (libroLibero !== true) {
    return vuoto('il libro non è PROVATAMENTE vuoto su questo mercato: prima si toglie ogni ordine, poi si chiudono i registri'
      + ' — mai il contrario, o si resta con un ordine vero su un mercato che il sistema non governa più');
  }

  const puliti = []; const falliti = []; const saltati = [];
  for (const [chiave, cosa] of REGISTRI) {
    const f = registri[chiave];
    if (typeof f !== 'function') { saltati.push(chiave); continue; }
    let r = null;
    try { r = f(marketId); } catch (e) { r = { ok: false, motivo: e && e.message ? e.message : String(e) }; }
    if (r && r.ok === false) { falliti.push({ chiave, cosa, motivo: (r && r.motivo) || 'motivo non dichiarato' }); continue; }
    // `rimosso:false` è un esito legittimo e NON un fallimento: vuol dire che quel registro non aveva
    // niente su questo mercato. Contarlo come pulizia direbbe che è stato fatto un lavoro che non c'era.
    if (r && r.rimosso === true) puliti.push(chiave);
  }
  return {
    ok: falliti.length === 0,
    puliti, falliti, saltati,
    motivo: `mercato ${causa || 'chiuso'} a libro libero: ${puliti.length} registro/i ripuliti`
      + (falliti.length ? `, ${falliti.length} falliti (${falliti.map((x) => x.chiave).join(', ')})` : '')
      + (saltati.length ? `, ${saltati.length} non cablati (${saltati.join(', ')})` : ''),
  };
}

/**
 * IL MERCATO È MORTO? Pura, e volutamente asimmetrica.
 *
 * `closed` e `acceptingOrders` vanno LETTI: un record assente o senza quei campi risponde `false` con
 * il motivo. È la stessa asimmetria di `decideClose` — non si smette di governare un mercato perché una
 * lettura non è riuscita.
 */
function mercatoMorto({ venue = null } = {}) {
  if (!venue || typeof venue !== 'object') {
    return { morto: false, causa: null, motivo: 'stato del mercato non letto dal venue: non si conclude niente' };
  }
  if (venue.closed === true) {
    return { morto: true, causa: 'closed',
      motivo: 'il venue dichiara il mercato CHIUSO: risolto o annullato, in entrambi i casi non tornerà a vivere' };
  }
  if (venue.acceptingOrders === false) {
    return { morto: true, causa: 'not-accepting',
      motivo: 'il venue non accetta più ordini su questo mercato: qualunque cosa i registri dicano, qui non si opera più' };
  }
  return { morto: false, causa: null, motivo: 'il mercato risulta ancora vivo sul venue' };
}

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c) => { if (c) { p += 1; console.log(`  ✓ ${n}`); } else { f += 1; console.log(`  ✗ ${n}`); } };
  console.log('\n════ pulizia-mercato-chiuso ════');

  ok('venue non letto ⇒ non morto', mercatoMorto({ venue: null }).morto === false);
  ok('closed:true ⇒ morto', mercatoMorto({ venue: { closed: true } }).morto === true);
  ok('acceptingOrders:false ⇒ morto', mercatoMorto({ venue: { acceptingOrders: false } }).morto === true);
  ok('  e la causa le distingue',
    mercatoMorto({ venue: { closed: true } }).causa === 'closed'
    && mercatoMorto({ venue: { acceptingOrders: false } }).causa === 'not-accepting');
  ok('vivo ⇒ non morto', mercatoMorto({ venue: { closed: false, acceptingOrders: true } }).morto === false);
  ok('  e `closed:"true"` stringa NON è `true`', mercatoMorto({ venue: { closed: 'true' } }).morto === false);

  const tutti = (rimosso) => Object.fromEntries(REGISTRI.map(([k]) => [k, () => ({ ok: true, rimosso })]));

  const r1 = pulisciRegistri({ marketId: '0xm', causa: 'closed', libroLibero: true, registri: tutti(true) });
  ok('libro libero ⇒ tutti e sei ripuliti', r1.ok === true && r1.puliti.length === 6);
  const r2 = pulisciRegistri({ marketId: '0xm', causa: 'closed', libroLibero: false, registri: tutti(true) });
  ok('libro NON libero ⇒ non si tocca niente', r2.ok === false && r2.puliti.length === 0 && r2.saltati.length === 6);
  const r3 = pulisciRegistri({ marketId: '0xm', causa: 'closed', libroLibero: null, registri: tutti(true) });
  ok('  e «non l\'ho letto» vale come NO, non come sì', r3.puliti.length === 0);

  const r4 = pulisciRegistri({ marketId: '0xm', libroLibero: true, registri: tutti(false) });
  ok('niente da rimuovere non è un fallimento, ed è contato a parte', r4.ok === true && r4.puliti.length === 0);

  const parziale = { ...tutti(true), tetto: () => { throw new Error('disco pieno'); } };
  const r5 = pulisciRegistri({ marketId: '0xm', libroLibero: true, registri: parziale });
  ok('un registro che esplode non ferma gli altri', r5.puliti.length === 5 && r5.falliti.length === 1);
  ok('  e il fallimento è dichiarato con il suo motivo', /disco pieno/.test(r5.falliti[0].motivo));

  const r6 = pulisciRegistri({ marketId: '0xm', libroLibero: true, registri: { chiusura: () => ({ ok: true, rimosso: true }) } });
  ok('i registri non cablati sono `saltati`, non falliti', r6.ok === true && r6.puliti.length === 1 && r6.saltati.length === 5);

  ok('mercato non indicato ⇒ niente', pulisciRegistri({ libroLibero: true, registri: tutti(true) }).puliti.length === 0);

  console.log(`\npulizia-mercato-chiuso: ${p} passati, ${f} falliti`);
  return f === 0;
}

module.exports = { pulisciRegistri, mercatoMorto, REGISTRI, selfcheck };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);
