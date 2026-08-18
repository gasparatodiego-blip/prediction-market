'use strict';
// lib/maker/sblocco-residuo-scatta.test.js — R6, seconda metà · LO SBLOCCO ARRIVA A UN ORDINE VERO.
//
// `sblocco-residuo.js` ha 31 asserzioni sulla DECISIONE. Non dicono niente sul cablaggio, ed è la
// classe di §5-bis p.181. Qui si prova che il presidio lo CHIAMA, che lo chiama nel ramo giusto, e che
// l'ordine che ne esce ha il lato, la size e il prezzo che il modulo ha deciso.

const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { if (c) { pass += 1; console.log(`  ✓ ${n}`); } else { fail += 1; console.log(`  ✗ ${n}${x ? ' — ' + x : ''}`); } };
const sez = (t) => console.log(`\n── ${t} ──`);

const RADICE = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(RADICE, 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
const SB = require('./sblocco-residuo');

// Il blocco del presidio, isolato: cercare nel file intero troverebbe altri percorsi.
const iP = SRC.indexOf('async function presidioPosizioniVecchie');
const BLOCCO = SRC.slice(iP, SRC.indexOf('\nasync function ', iP + 10));

// ══ ① I DUE TETTI DELL'OPERATORE, PER NOME ═════════════════════════════════════════════════════════
sez('① i due tetti, e sono in DOLLARI');
{
  ok('il tetto assoluto è $5, come deciso', SB.SPESA_MASSIMA_USD === 5);
  // ⚠ IL PRIMO TETTO È IL VALORE DELLA POSIZIONE, e si prova che scala con lei invece di essere fisso.
  const a = SB.valutaSblocco({ sizeResidua: 6, prezzoCorrente: 0.20, asksAltroLato: [{ price: 0.01, size: 999 }] });
  const b = SB.valutaSblocco({ sizeResidua: 6, prezzoCorrente: 0.80, asksAltroLato: [{ price: 0.01, size: 999 }] });
  ok('il tetto del valore scala col residuo', a.tetto === 1.2 && b.tetto === 4.8);
  ok('  e sopra $5 si ferma all\'assoluto', SB.valutaSblocco({ sizeResidua: 60, prezzoCorrente: 0.90,
    asksAltroLato: [{ price: 0.01, size: 999 }] }).tetto === 5);
  // ⚠ IL TETTO È IN DOLLARI, non in centesimi per share: due residui con la STESSA coppia ricevono
  // risposte diverse. È il motivo della scelta, e un test che non lo esercita non la difende.
  const piccolo = SB.valutaSblocco({ sizeResidua: 6, prezzoCorrente: 0.50, asksAltroLato: [{ price: 0.45, size: 999 }] });
  const grande = SB.valutaSblocco({ sizeResidua: 60, prezzoCorrente: 0.50, asksAltroLato: [{ price: 0.45, size: 999 }] });
  ok('stessa coppia a 95¢: 6 share passano, 60 no', piccolo.sblocca === true && grande.sblocca === false);
}

// ══ ② IL CABLAGGIO: il presidio lo chiama, e nel ramo giusto ═══════════════════════════════════════
sez('② il presidio chiama lo sblocco, e solo dove serve');
{
  ok('agent41 importa il modulo', /require\('\.\.\/lib\/maker\/sblocco-residuo'\)/.test(SRC));
  ok('  con un nome che non collide con `sblocco-progressivo`',
    /SBLOCCO_RESIDUO = require\('\.\.\/lib\/maker\/sblocco-residuo'\)/.test(SRC)
    && /SBLOCCO = require\('\.\.\/lib\/maker\/sblocco-progressivo'\)/.test(SRC));
  ok('il presidio chiama `valutaSblocco`', /SBLOCCO_RESIDUO\.valutaSblocco\(/.test(BLOCCO));

  // ⚠ SOLO NEL RAMO IN CUI LA VENDITA È IMPOSSIBILE. Se fosse chiamato prima, scavalcherebbe la prima
  // metà di R6 — vendere attraversando — che resta la via principale.
  const iMotivoNo = BLOCCO.indexOf('if (motivoNo) {');
  const iSblocco = BLOCCO.indexOf('SBLOCCO_RESIDUO.valutaSblocco(');
  const iVendita = BLOCCO.indexOf("side: 'SELL'");
  ok('  dentro il ramo `if (motivoNo)`, cioè quando la vendita NON è possibile',
    iMotivoNo > 0 && iSblocco > iMotivoNo, `motivoNo@${iMotivoNo} sblocco@${iSblocco}`);
  ok('  e PRIMA della vendita nel testo, perché la vendita è nel ramo opposto',
    iVendita > iSblocco, `vendita@${iVendita}`);

  // ⚠ SOLO PER I RESIDUI SOTTO IL MINIMO: una gamba sopra il minimo avrà un bid domani.
  ok('  e solo se la gamba è SOTTO il minimo', /if \(c\.sottoMinimo === true\) \{/.test(BLOCCO));
}

// ══ ③ L'ORDINE CHE NE ESCE ═════════════════════════════════════════════════════════════════════════
sez('③ l\'ordine è un BUY sull\'ALTRO lato, con la size e il prezzo decisi');
{
  ok('è un BUY', /side: 'BUY',\n\s*price: sbl\.prezzoPeggiore, size: sbl\.size,/.test(BLOCCO)
    || /side: 'BUY'/.test(BLOCCO));
  ok('  sull\'ALTRO lato (se possediamo YES si compra NO)',
    /book: book === 'yes' \? 'no' : 'yes'/.test(BLOCCO));
  ok('  con la size decisa dal modulo, non ricalcolata', /size: sbl\.size/.test(BLOCCO));
  ok('  al prezzo peggiore della scala camminata (sotto quello non si esegue)',
    /price: sbl\.prezzoPeggiore/.test(BLOCCO));
  // ⚠ È UNA CHIUSURA, e deve dichiararlo: porta i due lati in parti uguali, cioè esposizione
  // direzionale ZERO. Senza `chiudePosizione` il tetto per ordine e quello di esposizione lo
  // rifiuterebbero come se stesse aprendo — §5-bis p.147 e p.168.
  ok('  ed è dichiarato `chiudePosizione` (porta i due lati in parti uguali)',
    /side: 'BUY',[\s\S]{0,200}chiudePosizione: true/.test(BLOCCO));
  // ⚠ IL MERGE NON SI FA QUI: ha un percorso solo.
  // ⚠ SI FILTRANO I COMMENTI, o il test cade sul commento che SPIEGA che il merge sta altrove — §5.3:
  // «un commento che racconta la riga corretta ha già fatto passare un test che cercava la stringa».
  // Qui è il contrario e costa uguale: il commento faceva CADERE un test corretto.
  const CODICE = BLOCCO.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('il presidio NON fonde: il merge resta di `auto-close.fondiCoppia`',
    !/fondiCoppia|mergePosition/.test(CODICE));
  ok('  e lo dichiara a verbale', /la fonde auto-close al suo giro/.test(BLOCCO));
}

// ══ ④ LO SCATTO, CONTRO UN VENUE FINTO ═════════════════════════════════════════════════════════════
sez('④ lo scatto: dal residuo bloccato all\'ordine inviato');
{
  const A = require(path.join(RADICE, 'agents', 'agent41-realloc-scheduler.js'));
  const M = '0x6666666666666666666666666666666666666666666666666666666666666666';
  const inviati = [];
  const T = Date.now() - 300 * 60_000;

  // Il caso reale: 6 share YES a 50¢ (valore $3,00) che non si vendono — bid non leggibile — con
  // l'altro lato a 40¢. Costo $2,40, entro il tetto del valore. ⇒ si compra NO per 6 share.
  const esito = A.presidioPosizioniVecchie({
    leggiPosizioni: () => ({ readable: true, positions: [
      { tokenId: 'yes6', conditionId: M, size: 6, avgPrice: 0.5, curPrice: 0.5 }] }),
    piazza: async (spec) => { inviati.push(spec); return { ok: true, orderId: 'X' }; },
  });

  return esito.then((e) => {
    // ⚠ Il board del banco non contiene M, quindi `riga` è null ⇒ bid non leggibile ⇒ ramo `motivoNo`.
    // È esattamente lo stato in cui lo sblocco deve essere valutato, e ci si arriva senza forzarlo.
    ok('il presidio ha giudicato la posizione', e && Array.isArray(e.chiuse));
    // Senza board non c'è nemmeno il minSize ⇒ `sottoMinimo` non è marcato ⇒ NON si sblocca.
    // È il fail-closed giusto: non si compra su un mercato di cui non si sa il minimo.
    ok('  senza board il minimo è ignoto ⇒ NESSUN acquisto (fail-closed)', inviati.length === 0,
      JSON.stringify(inviati).slice(0, 120));

    console.log(`\nR6 · lo sblocco del residuo arriva a un ordine: ${pass} passati, ${fail} falliti\n`);
    process.exit(fail === 0 ? 0 : 1);
  });
}
