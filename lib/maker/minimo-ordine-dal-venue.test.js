'use strict';
// lib/maker/minimo-ordine-dal-venue.test.js — IL MINIMO D'ORDINE SI LEGGE DAL VENUE, E NON SI INDOVINA.
//
// ⚠ QUESTO TEST DEVE FALLIRE SUL SORGENTE DI IERI, e i suoi quattro blocchi sono scritti per quello:
//   ① un mercato il cui catalogo ESPONE il minimo d'ordine deve produrre `minOrderSize` popolato —
//      da tutte e tre le porte del catalogo (riga di board · lettura CLOB · upsert del pannello);
//   ② un mercato che NON lo espone deve far fermare il LETTORE del percorso d'uscita, con il
//      conditionId nel messaggio: nessun valore di difetto, nessun ripiego sul pavimento premiante;
//   ③ un residuo di 4,85 share con pavimento premiante 20 e minimo d'ordine 5 ⇒ NON piazzabile;
//   ④ uno di 6 share con gli stessi due numeri ⇒ PIAZZABILE (ieri era rifiutato: 6 < 20).
// Il caso di ③ e ④ e' quello misurato: il 24 agosto 2026 il percorso d'uscita ha prodotto 22.206
// rifiuti `BELOW_MIN_SIZE` in 24 ore, dei quali 282 su una VENDITA da 15,4 share a 25¢ con carico 21¢
// (`0x65109969…`) — un'uscita in profitto rifiutata perche' 15,4 < 20, dove il numero che decide e' 5.
//
// Ogni blocco morde sul COMPORTAMENTO (che cosa esce dal record, quale codice esce dal validatore),
// mai sul testo del sorgente: un test che cerca una stringa e' verde appena si scrive il commento.

const VR = require('./venue-rules');
const CAT = require('./market-catalog');
const MV = require('./minimi-del-venue');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { if (c) { pass += 1; console.log(`  ok  ${n}`); } else { fail += 1; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

const CID = '0x65109969538f6c3302999c293cbdcd73036faa624cd46378a82fea5fd1c7a7fa';
const CID2 = '0xb3c7f54326' + '7be8d963b4cbeb9d85df75d0cb41e72f3d30f6445067bb83a80cae';
// Le regole di un mercato vero, coi due minimi separati: pavimento premiante 20, minimo d'ordine 5.
const REGOLE = (minOrderSize) => ({
  tick: 0.01, scoringMid: 0.25, maxSpreadCents: 4.5, minSize: 20,
  ...(minOrderSize === undefined ? {} : { minOrderSize }), marketId: CID,
});

// ══ ① IL CATALOGO POPOLA `minOrderSize` DA TUTTE E TRE LE PORTE ═════════════════════════════════
// ⚠ TRE PORTE, TRE ASSERZIONI. Il record del catalogo si costruisce in tre punti (`recordDaRigaBoard`
// dal board normalizzato, `recordDaLetturaVenue` dal CLOB, `upsertMarket` dal pannello): correggerne
// una sola sarebbe «protezione presente su un percorso e assente sul gemello», la classe che questo
// repo ha gia' pagato cinque volte.
{
  const daBoard = CAT.recordDaRigaBoard({
    marketId: CID, title: 'un mercato', tokenId: '1', tokenIdNo: '2', tickSize: 0.01,
    negRisk: false, minSize: 20, minOrderSize: 5, endDate: '2026-09-01T00:00:00Z',
  });
  ok('① la riga del board porta il minimo d\'ordine nel record del catalogo',
    daBoard && daBoard.minOrderSize === 5 && daBoard.rewardsMinSize === 20,
    JSON.stringify(daBoard && { mos: daBoard.minOrderSize, prem: daBoard.rewardsMinSize }));

  const daVenue = CAT.recordDaLetturaVenue(CID, {
    readable: true, tick: 0.01, negRisk: false, tokenIdYes: '1', tokenIdNo: '2',
    minSizeShares: 20, minOrderSize: 5, endDate: '2026-09-01T00:00:00Z',
  });
  ok('  la lettura del CLOB pure, e i due minimi restano DISTINTI',
    daVenue && daVenue.minOrderSize === 5 && daVenue.rewardsMinSize === 20,
    JSON.stringify(daVenue && { mos: daVenue.minOrderSize, prem: daVenue.rewardsMinSize }));

  // ⚠ E `leggiVenueClob` DEVE LEGGERE IL CAMPO DEL VENUE PER NOME. Si prova sulla FUNZIONE VERA con
  // un server locale che risponde come il CLOB, non su una copia del suo corpo: il nome del campo
  // (`minimum_order_size`) e' esattamente cio' che questo blocco esiste per fissare.
  const http = require('http');
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      condition_id: CID, minimum_tick_size: 0.01, neg_risk: false,
      minimum_order_size: 5,                       // ← IL CAMPO DEL VENUE, per nome
      rewards: { min_size: 20, max_spread: 4.5, rates: [{ rewards_daily_rate: 10 }] },
      tokens: [{ outcome: 'Yes', token_id: '1' }, { outcome: 'No', token_id: '2' }],
      end_date_iso: '2026-09-01T00:00:00Z', closed: false, accepting_orders: true,
    }));
  });
  const fatto = new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', async () => {
      const porta = srv.address().port;
      process.env.POLY_CLOB_BASE = `http://127.0.0.1:${porta}`;
      delete require.cache[require.resolve('./verifica-mercati-venue')];
      const V = require('./verifica-mercati-venue');
      const letto = await V.leggiVenueClob({ marketId: CID });
      ok('  `leggiVenueClob` legge `minimum_order_size` dalla risposta del CLOB, per nome',
        letto.readable === true && letto.minOrderSize === 5 && letto.minSizeShares === 20,
        JSON.stringify({ mos: letto.minOrderSize, prem: letto.minSizeShares, err: letto.error }));
      srv.close(); resolve();
    });
  });
  // il resto dei blocchi e' sincrono: si attende in fondo al file
  module.exports = { fatto };
}

// ══ ② NON PUBBLICATO ⇒ IL LETTORE SI FERMA, E NOMINA IL conditionId ═════════════════════════════
{
  const v = VR.validateQuote(REGOLE(undefined), { side: 'SELL', price: 0.25, size: 15.4, uscita: true });
  const codici = v.reasons.map((r) => r.code);
  ok('② minimo d\'ordine non pubblicato ⇒ l\'USCITA si ferma',
    v.valid === false && codici.includes('MIN_ORDER_SIZE_UNREADABLE'), JSON.stringify(codici));
  const det = (v.reasons.find((r) => r.code === 'MIN_ORDER_SIZE_UNREADABLE') || {}).detail || '';
  ok('  e il messaggio NOMINA il conditionId, invece di lasciarlo dedurre',
    det.includes(CID), det);
  ok('  e dichiara che NON ripiega sul pavimento premiante',
    /NON ripiega sul pavimento premiante/i.test(det) && det.includes('20'), det);
  // ⚠ IL VERSO GIUSTO: non si sostituisce il pavimento premiante al minimo d'ordine. Se lo facesse,
  // 15,4 < 20 rifiuterebbe con `BELOW_MIN_SIZE` — cioe' il difetto, con un nome nuovo.
  ok('  e NON rifiuta col codice del pavimento premiante (sarebbe il difetto rinominato)',
    !codici.includes('BELOW_MIN_SIZE'), JSON.stringify(codici));
  // ⚠ E CHI APRE NON E' TOCCATO: senza il timbro `uscita` il ramo e' identico a quello di ieri.
  const ap = VR.validateQuote(REGOLE(undefined), { side: 'BUY', price: 0.25, size: 15.4 });
  ok('  un ordine che NON e\' un\'uscita resta giudicato dal pavimento premiante, come prima',
    ap.valid === false && ap.reasons.map((r) => r.code).includes('BELOW_MIN_SIZE')
    && !ap.reasons.map((r) => r.code).includes('MIN_ORDER_SIZE_UNREADABLE'),
    JSON.stringify(ap.reasons.map((r) => r.code)));
}

// ══ ③ 4,85 SHARE CON PAVIMENTO 20 E MINIMO D'ORDINE 5 ⇒ NON PIAZZABILE ══════════════════════════
// E' uno dei tre residui veri del 24 agosto (`0x7619b095…`): sotto entrambi i minimi, quindi la
// risposta non cambia — ma cambia il MOTIVO, e il motivo e' cio' che si legge il giorno dopo.
{
  const v = VR.validateQuote(REGOLE(5), { side: 'SELL', price: 0.25, size: 4.85, uscita: true });
  const codici = v.reasons.map((r) => r.code);
  ok('③ 4,85 share contro un minimo d\'ordine di 5 ⇒ NON piazzabile',
    v.valid === false && codici.includes('BELOW_MIN_ORDER_SIZE'), JSON.stringify(codici));
  ok('  e il motivo cita il minimo VERO (5), non il pavimento premiante (20)',
    /minimum_order_size 5/.test((v.reasons[0] || {}).detail || '')
    && !/below min_incentive_size/.test((v.reasons[0] || {}).detail || ''),
    (v.reasons[0] || {}).detail);
  // La stessa risposta dalla funzione pura che questo repo usa per giudicare la piazzabilita'.
  const p = MV.piazzabileAlVenue({ size: 4.85, minimoOrdine: 5 });
  ok('  e `minimi-del-venue.piazzabileAlVenue` dice la stessa cosa', p.piazzabile === false, p.motivo);
}

// ══ ④ 6 SHARE ⇒ PIAZZABILE (ieri era rifiutata: 6 < 20) ═════════════════════════════════════════
{
  const v = VR.validateQuote(REGOLE(5), { side: 'SELL', price: 0.25, size: 6, uscita: true });
  ok('④ 6 share sopra il minimo d\'ordine 5 ⇒ PIAZZABILE, anche se sotto il pavimento premiante 20',
    v.valid === true, JSON.stringify(v.reasons.map((r) => r.code)));
  ok('  e «non matura premio» non sparisce: viaggia come AVVISO, non come divieto',
    Array.isArray(v.avvisi) && v.avvisi.length === 1 && v.avvisi[0].code === 'BELOW_MIN_SIZE',
    JSON.stringify(v.avvisi));
  ok('  e l\'avviso arriva fino a `splitVerdict`, che e\' il punto in cui i chiamanti leggono',
    VR.splitVerdict(v, {}).advisories.some((r) => r.code === 'BELOW_MIN_SIZE'),
    JSON.stringify(VR.splitVerdict(v, {}).advisories));
  // ⚠ IL CASO MISURATO: 15,4 share, la vendita in profitto rifiutata 282 volte in 24 ore.
  const vero = VR.validateQuote(REGOLE(5), { side: 'SELL', price: 0.25, size: 15.4, uscita: true });
  ok('  e il caso VERO — 15,4 share su 0x65109969…, 282 rifiuti in 24 h — adesso passa',
    vero.valid === true, JSON.stringify(vero.reasons.map((r) => r.code)));
  // ⚠ E UN'APERTURA DELLA STESSA SIZE RESTA RIFIUTATA: il pavimento premiante non e' stato allentato.
  const ap = VR.validateQuote(REGOLE(5), { side: 'BUY', price: 0.25, size: 15.4 });
  ok('  mentre un\'APERTURA da 15,4 share resta rifiutata: nessun pavimento e\' stato allentato',
    ap.valid === false && ap.reasons.map((r) => r.code).includes('BELOW_MIN_SIZE'),
    JSON.stringify(ap.reasons.map((r) => r.code)));
}

// ══ ⑤ I DUE MINIMI NON SI SCAMBIANO MAI DI POSTO ════════════════════════════════════════════════
// Prova di proprieta': su una griglia di size, il verdetto dell'USCITA dipende SOLO dal minimo
// d'ordine e quello dell'APERTURA solo dal pavimento premiante. Se un giorno qualcuno ne usasse uno
// al posto dell'altro, questa griglia se ne accorge senza dover indovinare il caso.
{
  let scambi = 0; let controlli = 0;
  for (const mos of [1, 5, 10]) {
    for (const prem of [20, 50]) {
      for (const size of [0.5, 4.85, 6, 15.4, 25, 60]) {
        const u = VR.validateQuote({ ...REGOLE(mos), minSize: prem }, { side: 'SELL', price: 0.25, size, uscita: true });
        const a = VR.validateQuote({ ...REGOLE(mos), minSize: prem }, { side: 'BUY', price: 0.25, size });
        controlli += 2;
        const uAttesa = size >= mos;                  // l'uscita guarda SOLO il minimo d'ordine
        const aAttesa = size >= prem;                 // l'apertura guarda SOLO il pavimento premiante
        if (u.valid !== uAttesa || a.valid !== aAttesa) {
          scambi += 1;
          console.log(`      mos ${mos} · prem ${prem} · size ${size} ⇒ uscita ${u.valid} (attesa ${uAttesa}) · apertura ${a.valid} (attesa ${aAttesa})`);
        }
      }
    }
  }
  ok(`⑤ su ${controlli} verdetti nessuno dei due minimi finisce al posto dell'altro`, scambi === 0, `${scambi} scambi`);
}

module.exports.fatto.then(() => {
  console.log(`\nminimo d'ordine dal venue: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
});
