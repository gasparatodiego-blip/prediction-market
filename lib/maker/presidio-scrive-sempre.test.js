'use strict';
// lib/maker/presidio-scrive-sempre.test.js — OGNI RINUNCIA DEL PRESIDIO LASCIA UNA TRACCIA.
//
// ═══ IL DIFETTO CHE QUESTO TEST CHIUDE ═══════════════════════════════════════════════════════════════
// Il presidio dei 60 minuti — «l'ultima rete» — scriveva a verbale solo quando riusciva a chiudere, o
// quando rinunciava AVENDO un prezzo. Il ramo più comune non entrava mai: quando il mercato è uscito
// dal board — che è lo stato normale di una posizione vecchia — il prezzo d'uscita non è calcolabile
// e il presidio rinunciava **in silenzio**.
//
// MISURATO il 18 agosto 2026 sui 400 record più recenti di `data/realloc-scheduler.jsonl`: **ZERO
// righe di presidio**, mentre girava ogni due minuti e rinunciava ogni volta su una posizione reale
// (6 share di Hong Kong, uscite dal board). Per sapere cosa stesse succedendo bisognava eseguire a
// mano la sua funzione di decisione.
//
// «Un presidio che non lascia traccia non è verificabile, e uno non verificabile non è un presidio:
// è una speranza.» È scritto nel riconciliatore della copertura, ed è la stessa regola.
//
// ═══ COSA SI PROVA ══════════════════════════════════════════════════════════════════════════════════
// Che il presidio scriva UNA riga per OGNI posizione che ha giudicato e non ha chiuso, con la causa,
// e che le tre rinunce restino distinguibili fra loro. Non si prova «scrive qualcosa»: si prova che
// il numero di righe è pari al numero di rinunce, perché una traccia che manca su un caso su tre è
// la stessa cosa di nessuna traccia il giorno in cui capita quel caso.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { if (c) { pass += 1; console.log(`  ✓ ${n}`); } else { fail += 1; console.log(`  ✗ ${n}${x ? ' — ' + x : ''}`); } };
const sez = (t) => console.log(`\n── ${t} ──`);

const RADICE = path.resolve(__dirname, '..', '..');
const A = require(path.join(RADICE, 'agents', 'agent41-realloc-scheduler.js'));
const SRC = fs.readFileSync(path.join(RADICE, 'agents', 'agent41-realloc-scheduler.js'), 'utf8');

// ⚠ SI MISURA PRIMA E DOPO, non in assoluto. Il registro è APPEND-ONLY per policy (§4.10: gli archivi
// non si cancellano, non si potano), e la prima corsa di questo test — prima che `scrivi` diventasse
// iniettabile — ci ha lasciato quattro record con mercati inventati. Quelli restano, con una riga di
// rettifica accanto. Ciò che questo test deve garantire è che **questa** corsa non ne aggiunga altri:
// un'asserzione in assoluto resterebbe rossa per sempre per una contaminazione già avvenuta, e un
// test rosso per sempre smette di essere letto.
const GIORNALE = path.join(RADICE, 'data', 'realloc-scheduler.jsonl');
const FINTI = /0x(aa|bb|cc|dd){32}/;
function contaFinti() {
  try {
    const buf = Buffer.alloc(2_000_000);
    const fd = fs.openSync(GIORNALE, 'r');
    const size = fs.statSync(GIORNALE).size;
    const letti = fs.readSync(fd, buf, 0, Math.min(buf.length, size), Math.max(0, size - buf.length));
    fs.closeSync(fd);
    return buf.slice(0, letti).toString('utf8').split('\n').filter((l) => FINTI.test(l)).length;
  } catch { return 0; }
}
const FINTI_PRIMA = contaFinti();

const MKT = '0x' + 'aa'.repeat(32);
const VECCHIA = Date.now() - 300 * 60_000;

/** Guida il presidio VERO con una posizione sola, e raccoglie ciò che ha scritto a verbale.
 *
 * ⚠ LE ANCORE SI INIETTANO IN UNA DIRECTORY TEMPORANEA. Sono l'unica cosa che questo presidio guarda
 * — da quanto una posizione è aperta — e senza controllarle ogni posizione risulta appena nata,
 * quindi sotto la soglia dei 60 minuti, quindi non giudicata: il test resterebbe verde su un percorso
 * mai raggiunto. E scriverebbe nel `data/` di produzione, che è l'altro difetto già visto oggi. */
function giro({ posizioni, piazza = async () => ({ ok: true }) }) {
  const righe = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presidio-'));
  const fileAncore = path.join(dir, 'ancore.json');
  const ancore = {};
  for (const p of posizioni) ancore[String(p.tokenId || p.asset || '')] = VECCHIA;
  fs.writeFileSync(fileAncore, JSON.stringify({ ancore }));
  return A.presidioPosizioniVecchie({
    leggiPosizioni: () => ({ readable: true, positions: posizioni }),
    fileAncore,
    piazza,
    scrivi: (r) => righe.push(r),
  }).then((esito) => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* niente */ }
    return { esito, righe };
  });
}

const POS = (extra = {}) => ({ tokenId: 'tk', conditionId: MKT, size: 6,
  avgPrice: 0.5, curPrice: 0.5, ...extra });

(async () => {
  // ══ ① IL CASO CHE ERA MUTO: mercato NON sul board ════════════════════════════════════════════════
  sez('① mercato uscito dal board: si rinuncia, e ADESSO si scrive');
  {
    // Il board vero non contiene `0xaaaa…`, quindi `riga` è null: né prezzo né minimo del venue. È
    // esattamente lo stato dei 6 share di Hong Kong il 18 agosto 2026.
    const { esito, righe } = await giro({ posizioni: [POS()] });
    const mie = righe.filter((r) => r.tipo === 'presidio-posizioni-vecchie');
    ok('il presidio ha giudicato la posizione', esito.chiuse.length === 1);
    ok('  e NON è riuscito a chiuderla', esito.chiuse[0].chiusa !== true);
    ok('  ma ha scritto una riga a verbale', mie.length === 1, `${mie.length} righe`);
    const r = mie[0] || {};
    ok('  con l\'esito che dice QUALE rinuncia è', r.esito === 'rinunciata-prezzo-non-calcolabile', String(r.esito));
    ok('  la causa in chiaro, non solo l\'etichetta', /non si vende al buio/.test(String(r.motivo)));
    // ⚠ È LA CAUSA A MONTE, e va nel giornale: senza riga di board non c'è né il prezzo né il minimo,
    // quindi né la vendita né lo sblocco sono valutabili. Chi legge deve vederlo, non dedurlo.
    ok('  e dichiara che il mercato NON è sul board', r.sulBoard === false);
    ok('  col mercato, la size e l\'anzianità', r.marketId === MKT && r.size === 6 && r.etaMin > 60);
  }

  // ══ ② IL NUMERO DI RIGHE È IL NUMERO DI RINUNCE ══════════════════════════════════════════════════
  sez('② una riga per ogni posizione giudicata e non chiusa');
  {
    // Tre posizioni su tre mercati diversi, nessuno sul board: tre rinunce, tre righe.
    const posizioni = ['bb', 'cc', 'dd'].map((h, i) => POS({
      tokenId: `tk${i}`, conditionId: '0x' + h.repeat(32), size: 6 + i,
    }));
    const { esito, righe } = await giro({ posizioni });
    const mie = righe.filter((r) => r.tipo === 'presidio-posizioni-vecchie');
    ok('tre posizioni ⇒ tre giudizi', esito.chiuse.length === 3, String(esito.chiuse.length));
    ok('  ⇒ TRE righe a verbale, non una', mie.length === 3, `${mie.length} righe`);
    ok('  e ognuna nomina il suo mercato', new Set(mie.map((r) => r.marketId)).size === 3);
  }

  // ══ ③ LE TRE RINUNCE RESTANO DISTINGUIBILI ═══════════════════════════════════════════════════════
  sez('③ le tre rinunce hanno tre esiti diversi');
  {
    // ⚠ SI PROVA SUL SORGENTE perché i tre rami dipendono da stati del venue che non si costruiscono
    // tutti da qui. Ciò che conta è che i tre nomi esistano e siano DIVERSI: un esito solo per tre
    // cause diverse renderebbe il giornale illeggibile proprio quando serve.
    const nomi = ['rinunciata-prezzo-non-calcolabile', 'rinunciata-ricavo-nullo',
      'rinunciata-sblocco-oltre-tetto'];
    for (const n of nomi) ok(`l'esito «${n}» esiste nel sorgente`, SRC.includes(n));
    ok('  e sono tre nomi distinti', new Set(nomi).size === 3);
    // ⚠ E LA SCRITTURA NON È PIÙ CONDIZIONATA. Questa è la riga che mancava: se tornasse una guardia
    // sul prezzo davanti alla `scrivi`, il ramo muto tornerebbe con lei.
    const blocco = SRC.slice(SRC.indexOf('async function presidioPosizioniVecchie'));
    const corpo = blocco.slice(0, blocco.indexOf('\nasync function ', 10));
    const codice = corpo.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    ok('la scrittura della rinuncia NON è dietro una guardia sul prezzo',
      !/if \(prezzo !== null \|\| sbl\)/.test(codice) && !/if \(prezzo !== null\)\s*\{\s*\n\s*scrivi/.test(codice));
  }

  // ══ ④ CHI CHIUDE DAVVERO CONTINUA A SCRIVERE COME PRIMA ══════════════════════════════════════════
  sez('④ la riga di chiusura riuscita non è cambiata');
  {
    // ⚠ È LA METÀ CHE TIENE: aggiungere una riga sulle rinunce non deve averne tolta una sui successi.
    const codice = SRC.slice(SRC.indexOf('async function presidioPosizioniVecchie'));
    ok('l\'esito `chiusa` esiste ancora', /esito: \(r && r\.ok\) \? 'chiusa' : 'chiusura-fallita'/.test(codice));
    ok('  e porta ancora `scalaNonHaChiuso`', /scalaNonHaChiuso: true/.test(codice));
  }

  // ══ ⑤ IL PRESIDIO NON SCRIVE SE NON HA GIUDICATO NIENTE ══════════════════════════════════════════
  sez('⑤ nessuna posizione ⇒ nessuna riga (il silenzio giusto)');
  {
    const { esito, righe } = await giro({ posizioni: [] });
    const mie = righe.filter((r) => r.tipo === 'presidio-posizioni-vecchie');
    ok('nessuna posizione ⇒ nessun giudizio', esito.chiuse.length === 0);
    ok('  e nessuna riga: il silenzio qui è corretto', mie.length === 0, `${mie.length} righe`);
    // ⚠ La differenza fra i due silenzi è tutto il punto di questo test: «non c'era niente da fare»
    // e «c'era e non l'ho detto» producevano lo stesso giornale vuoto, e adesso no.
  }

  // ══ ⑥ E QUESTO TEST NON HA SPORCATO IL GIORNALE DI PRODUZIONE ══════════════════════════════════
  sez('⑥ nessun record finto nel registro vero');
  {
    // ⚠ SCRIVENDO QUESTA PROVA È SUCCESSO DAVVERO: `scrivi` era la funzione di modulo, che appende al
    // registro VERO in `data/`, e la prima corsa ci ha lasciato quattro record con mercati inventati.
    // È la terza occorrenza in un giorno della classe «un test che guida una funzione che scrive deve
    // poterle dire dove». L'asserzione su DOVE NON ha scritto è quella che l'avrebbe presa subito.
    const dopo = contaFinti();
    ok('questa corsa non ha aggiunto NESSUN record al registro vero',
      dopo === FINTI_PRIMA, `${FINTI_PRIMA} prima → ${dopo} dopo`);
    if (FINTI_PRIMA > 0) {
      console.log(`  ~ ${FINTI_PRIMA} record finti restano in coda dalla PRIMA corsa di questo test,`
        + ' scritti quando `scrivi` non era ancora iniettabile. Il registro è append-only: non si'
        + ' cancellano, e accanto c\'è una riga di rettifica che li dichiara.');
    }
  }

  console.log(`\nil presidio scrive sempre: ${pass} passati, ${fail} falliti\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
