'use strict';
// lib/maker/presidio-riconosce-sotto-minimo.test.js — IL SOTTO-MINIMO SI RICONOSCE ANCHE FUORI DAL BOARD.
//
// ═══ IL DIFETTO CHE QUESTO TEST CHIUDE ══════════════════════════════════════════════════════════════
// `presidio-posizioni-vecchie` marca `sottoMinimo` confrontando la size posseduta col minimo premiante
// del venue, e da quel flag dipende R6: `if (c.sottoMinimo === true)` e' l'unica porta verso lo sblocco
// (comprare l'altro lato e fondere), cioe' l'unica via d'uscita di un residuo che il libro rifiuta.
//
// La mappa dei minimi si costruiva dal SOLO board. Un mercato uscito dal board non ha minimo, quindi
// `sottoMinimo` resta `false`, quindi quel ramo non si raggiunge MAI. E uscire dal board e' lo stato
// normale di una posizione vecchia: e' esattamente il caso per cui il presidio esiste.
//
// MISURATO il 18 agosto 2026 sulla posizione viva — Hong Kong `0xe9b3e28d`, 6 share:
//   board (120 righe) ASSENTE · catalogo di ripiego (23) ASSENTE · Gamma ASSENTE · CLOB `min_size` 20.
// Sei share contro un minimo di venti: sotto il minimo da giorni, e nessun percorso poteva saperlo.
//
// ⚠ NON E' UN'ASSENZA CHE SI DICHIARA: e' un'assenza che si traveste da risposta. Il presidio non
// diceva «non so se e' sotto il minimo», diceva «non lo e'» — e provava a venderla come una posizione
// qualunque. Classe `Number(null) === 0` di §5.3.
//
// ═══ COSA SI PROVA, E COME SI FA CADERE ═════════════════════════════════════════════════════════════
// Si guida `presidioPosizioniVecchie` VERA con un mercato che non e' sul board, e si guarda cosa
// finisce a verbale. Il test cade sul sorgente di ieri in ①②③: senza la seconda e la terza fonte
// `sottoMinimo` e' `false` in tutti e tre i casi.
// ④ e' il verso opposto e NON deve cambiare: quando nessuna fonte risponde, non si inventa un minimo.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { if (c) { pass += 1; console.log(`  ✓ ${n}`); } else { fail += 1; console.log(`  ✗ ${n}${x ? ' — ' + x : ''}`); } };
const sez = (t) => console.log(`\n── ${t} ──`);

const RADICE = path.resolve(__dirname, '..', '..');
const A = require(path.join(RADICE, 'agents', 'agent41-realloc-scheduler.js'));
const SRC = fs.readFileSync(path.join(RADICE, 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
const MC = require(path.join(RADICE, 'lib', 'maker', 'market-catalog.js'));

// Un mercato che il board vero non contiene, e non puo' contenere.
const MKT = '0x' + '7e'.repeat(32);
const VECCHIA = Date.now() - 300 * 60_000;

/** La lettura del CLOB come la restituisce `leggiVenueClob`, col minimo premiante e i quattro campi
 *  che il catalogo pretende. E' la forma REALE, verificata sul venue il 18 agosto. */
const LETTURA_VENUE = Object.freeze({
  readable: true, closed: true, active: true, acceptingOrders: false,
  rewardsDailyRate: null, maxSpreadCents: 4.5, minSizeShares: 20,
  endDate: '2026-08-14T00:00:00Z',
  tick: 0.001, negRisk: true, tokenIdYes: '896172518661', tokenIdNo: '663710884291',
  question: 'Will the lowest temperature in Hong Kong be 27C on August 14?', slug: 'hk-27c',
});

/** Guida il presidio VERO. Ogni superficie che LEGGE o SCRIVE fuori e' iniettata: le ancore, il
 *  catalogo, il venue, il giornale e il piazzamento. Nessun file di produzione viene toccato, e
 *  nessuna richiesta esce dalla macchina. */
function giro({ catalogo = null, leggiVenue = null, size = 6, curPrice = 0.5 } = {}) {
  const righe = [];
  const salvati = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minsize-'));
  const fileAncore = path.join(dir, 'ancore.json');
  fs.writeFileSync(fileAncore, JSON.stringify({ ancore: { tk: VECCHIA } }));
  return A.presidioPosizioniVecchie({
    leggiPosizioni: () => ({ readable: true,
      positions: [{ tokenId: 'tk', conditionId: MKT, size, avgPrice: 0.5, curPrice }] }),
    fileAncore,
    leggiCatalogo: () => catalogo,
    leggiVenue: leggiVenue || (async () => ({ readable: false, error: 'nessun venue in questo test' })),
    salvaCatalogo: (id, lettura) => { salvati.push({ id, lettura }); return { ok: true }; },
    piazza: async () => ({ ok: true, orderId: 'X' }),
    scrivi: (r) => righe.push(r),
  }).then((esito) => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* niente */ }
    const pres = righe.filter((r) => r.tipo === 'presidio-posizioni-vecchie');
    const recu = righe.filter((r) => r.tipo === 'min-size-recupero');
    return { esito, righe, pres, recu, salvati };
  });
}

(async () => {
  // ══ ① LA SECONDA FONTE: IL CATALOGO DI RIPIEGO ═══════════════════════════════════════════════════
  sez('① mercato fuori dal board ma NEL catalogo di ripiego: il minimo si legge di li\'');
  {
    const { pres, recu } = await giro({ catalogo: { [MKT]: { rewardsMinSize: 20 } } });
    ok('il presidio ha scritto la sua riga', pres.length === 1, `${pres.length} righe`);
    ok('  e la posizione e\' marcata SOTTO IL MINIMO', pres[0] && pres[0].sottoMinimo === true,
      JSON.stringify(pres[0] && pres[0].sottoMinimo));
    ok('  col minimo che l\'ha decisa, non un\'etichetta nuda', pres[0] && pres[0].minSizeMercato === 20);
    ok('  e il mercato resta dichiarato fuori dal board', pres[0] && pres[0].sulBoard === false);
    // ⚠ Il catalogo ha risposto ⇒ NESSUNA richiesta al venue. Una fonte su disco che risponde e non
    // impedisce la chiamata di rete e' una fonte che non serve a niente.
    ok('  e NON si e\' chiesto niente al venue: la fonte su disco bastava', recu.length === 0);
  }

  // ══ ② LA TERZA FONTE: IL VENUE — IL CASO DI HONG KONG ════════════════════════════════════════════
  sez('② fuori dal board E fuori dal catalogo: lo chiede al venue (il caso vero)');
  {
    let chiesti = 0;
    const { pres, recu, salvati } = await giro({ catalogo: {},
      leggiVenue: async (id) => { chiesti += 1; ok.ultimoId = id; return LETTURA_VENUE; } });
    ok('il venue e\' stato interrogato una volta sola', chiesti === 1);
    ok('  sull\'id giusto', ok.ultimoId === MKT);
    ok('la posizione e\' marcata SOTTO IL MINIMO', pres[0] && pres[0].sottoMinimo === true,
      JSON.stringify(pres[0] && pres[0].sottoMinimo));
    ok('  col minimo letto dal venue (20 contro 6 share possedute)', pres[0] && pres[0].minSizeMercato === 20);
    // ⚠ IL RECUPERO SI SCRIVE A VERBALE. Senza, «non e' marcato sotto-minimo» resta indistinguibile
    // fra «non lo e'» e «non l'ho potuto sapere».
    ok('il recupero e\' a verbale', recu.length === 1 && recu[0].chiesti === 1);
    ok('  con il minimo recuperato e la dichiarazione che e\' stato salvato',
      recu[0].recuperati.length === 1 && recu[0].recuperati[0].minSize === 20 && recu[0].recuperati[0].salvato === true);

    // ── IL RECORD CHE SI POSA NEL CATALOGO DEVE ESSERE ACCETTABILE ────────────────────────────────
    // ⚠ `upsertMarket` RIFIUTA i record parziali, e lo fa anche quando il record esiste gia': un
    // `salva({marketId, rewardsMinSize})` sarebbe una lettura di rete che non arriva mai a
    // destinazione. E' il difetto latente del gemello in agent40 (`{marketId, endDate}`). Qui si
    // prova che la traduzione porta tutti e quattro i campi obbligatori.
    ok('la lettura INTERA arriva allo scrittore, non il solo numero', salvati.length === 1 && salvati[0].lettura === LETTURA_VENUE);
    const rec = MC.recordDaLetturaVenue(MKT, LETTURA_VENUE, Date.now());
    ok('  e si traduce in un record di catalogo COMPLETO', MC.missingFields(rec).length === 0,
      JSON.stringify(MC.missingFields(rec)));
    ok('  che porta davvero il minimo premiante', rec.rewardsMinSize === 20);
    // ⚠ Due campi che viaggiano gratis con lo stesso record, e valgono da soli: senza `endDate` la
    // chiusura forzata a 3 ore non puo' scattare (§5-bis p.122), senza `negRisk` il riscatto
    // on-chain rifiuta di scegliere l'adapter.
    ok('  e anche la scadenza e il negRisk, che nessun\'altra fonte portava',
      rec.endDate === '2026-08-14T00:00:00Z' && rec.negRisk === true);
    // ⚠ I TOKEN SI PRENDONO PER NOME, MAI PER POSIZIONE: scambiarli significherebbe comprare il lato
    // sbagliato per «chiudere».
    ok('  coi token presi per nome dell\'esito', rec.tokenIdYes === '896172518661' && rec.tokenIdNo === '663710884291');
  }

  // ══ ③ SOPRA IL MINIMO NON SI MARCA ═══════════════════════════════════════════════════════════════
  sez('③ la stessa fonte deve saper dire anche di NO');
  {
    const { pres } = await giro({ catalogo: { [MKT]: { rewardsMinSize: 20 } }, size: 60 });
    ok('60 share contro un minimo di 20: NON e\' sotto il minimo', pres[0] && pres[0].sottoMinimo === false);
    // Una fonte che marca tutto sotto-minimo sarebbe inutile quanto una che non marca niente.
    ok('  e nessun minimo viene attribuito alla riga', pres[0] && pres[0].minSizeMercato === null);
  }

  // ══ ④ IL VERSO CHE NON DEVE CAMBIARE: NESSUNA FONTE ⇒ NESSUN MINIMO INVENTATO ════════════════════
  sez('④ nessuna fonte risponde: non si inventa un minimo (fail-closed, come prima)');
  {
    const { pres, recu } = await giro({ catalogo: {}, leggiVenue: async () => ({ readable: false, error: 'HTTP 404' }) });
    ok('la posizione NON e\' marcata sotto-minimo', pres[0] && pres[0].sottoMinimo === false);
    ok('  e il fatto e\' DICHIARATO, non taciuto',
      recu.length === 1 && recu[0].nonTrovati.length === 1 && /404/.test(recu[0].nonTrovati[0].motivo));
    const { pres: p2 } = await giro({ catalogo: {}, leggiVenue: async () => { throw new Error('rete giu'); } });
    ok('un lettore del venue che ESPLODE non ferma il presidio', p2.length === 1 && p2[0].sottoMinimo === false);
    // ⚠ Il caso che il modulo puro isola e che qui deve arrivare fino in fondo: un venue che risponde
    // `min_size: 0` non sta dicendo «niente e' sotto il minimo».
    const { pres: p3 } = await giro({ catalogo: { [MKT]: { rewardsMinSize: 0 } } });
    ok('minimo ZERO nel catalogo: non e\' una risposta, e non marca niente', p3[0] && p3[0].sottoMinimo === false);
    const { pres: p4 } = await giro({ catalogo: { [MKT]: { rewardsMinSize: null } } });
    ok('minimo `null`: `Number(null)` NON diventa 0 qui', p4[0] && p4[0].sottoMinimo === false);
  }

  // ══ ⑤ IL SORGENTE: LA MAPPA NON NASCE PIU' DAL SOLO BOARD ════════════════════════════════════════
  sez('⑤ il cablaggio, sul sorgente');
  {
    const i = SRC.indexOf('async function presidioPosizioniVecchie');
    const blocco = SRC.slice(i, SRC.indexOf('\nasync function selezionaMercati', i));
    const codice = blocco.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok('il minimo passa da `min-size-mercato`, non da un ciclo sul board',
      /MINSIZE\.risolvi\(/.test(codice) && !/for \(const r of board\)/.test(codice));
    ok('  e la terza fonte e\' cablata', /MINSIZE\.recuperaDalVenue\(/.test(codice));
    ok('  il modulo e\' importato per nome', /require\('\.\.\/lib\/maker\/min-size-mercato'\)/.test(SRC));
    // ⚠ Il record si salva INTERO: e' cio' che rende la terza fonte persistente invece che ripetuta.
    ok('  e si salva un record di catalogo intero, non il solo minimo',
      /recordDaLetturaVenue\(/.test(codice));
    // ⚠ Le tre superfici verso l'esterno restano iniettabili, o un test scrive nella produzione: e'
    // successo tre volte in un giorno solo (§10 di APERTI.md).
    for (const dep of ['deps.leggiVenue', 'deps.salvaCatalogo', 'deps.leggiCatalogo']) {
      ok(`  \`${dep}\` e' iniettabile`, codice.includes(dep));
    }
  }

  console.log(`\nil presidio riconosce il sotto-minimo fuori dal board: ${pass} passati, ${fail} falliti\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
