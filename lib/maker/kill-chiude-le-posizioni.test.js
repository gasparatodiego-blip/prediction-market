'use strict';
// lib/maker/kill-chiude-le-posizioni.test.js — R10 · IL KILL A −$100 CHIUDE ANCHE LE POSIZIONI.
//
// ═══ COSA PROVA, E PERCHE' NON BASTA IL SELFCHECK DEL MODULO PURO ════════════════════════════════════
// `chiusura-di-emergenza.js` ha 22 asserzioni sulla DECISIONE. Quelle non dicono niente sul CABLAGGIO,
// ed e' esattamente la classe di difetto che il 17 agosto ha lasciato tre difese inerti con i test
// verdi (§5-bis p.181): fixture di forma inventata, decisione provata, cablaggio mai toccato.
//
// Qui si prova il cablaggio, e in particolare le tre proprieta' che un errore renderebbe silenzioso:
//   ① agent43 DEPOSITA e non esegue — la sua incapacita' di piazzare e' strutturale e resta;
//   ② agent41 ESEGUE anche a bot FERMO — che e' lo stato che il kill produce;
//   ③ il KILL switch resta davanti, e una richiesta sospesa NON si marca eseguita.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0; let fail = 0;
const ok = (nome, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ✓ ${nome}`); }
  else { fail += 1; console.log(`  ✗ ${nome}${extra ? ' — ' + extra : ''}`); }
};
const sez = (t) => console.log(`\n── ${t} ──`);

const RADICE = path.resolve(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r10-'));

// ══ ① IL MODULO CHE DECIDE E' PURO, E LO RESTA ══════════════════════════════════════════════════════
sez('① la decisione e\' pura e agent43 non ha imparato a vendere');
{
  const { classifica } = require('./chiusura-di-emergenza');
  const r = classifica({
    posizioni: [
      { asset: 'y1', conditionId: 'mA', size: 60, curPrice: 0.5 },   // coppia…
      { asset: 'n1', conditionId: 'mA', size: 60, curPrice: 0.5 },   // …completa
      { asset: 'y2', conditionId: 'mB', size: 40, curPrice: 0.4 },   // gamba scoperta
      { asset: 'y3', conditionId: 'mC', size: 6, curPrice: 0.5 },    // sotto il minimo
    ],
    minSizePerMercato: { mA: 20, mB: 20, mC: 20 },
  });
  ok('i tre destini di R10 escono dalla stessa chiamata',
    r.daFondere.length === 1 && r.daVendere.length === 1 && r.lasciate.length === 1);
  // ⚠ Il `conditionId` esce NORMALIZZATO (minuscolo), come dal presidio: e' la forma con cui il resto
  // del repo confronta gli id, e su un id esadecimale non perde niente. L'asserzione lo normalizza a
  // sua volta invece di pretendere la forma d'ingresso.
  ok('  la coppia va a FONDERE', r.daFondere[0].conditionId === 'ma');
  ok('  la gamba scoperta va a VENDERE', r.daVendere[0].asset === 'y2');
  ok('  la sotto-minimo resta e dichiara il minimo', r.lasciate[0].sottoMinimo === true && r.lasciate[0].minSizeMercato === 20);

  // ⚠ LA PROPRIETA' STRUTTURALE DI agent43, che questa modifica NON deve aver rotto. Si cammina il suo
  // albero dei `require` cercando una superficie che sappia piazzare o firmare. E' la stessa proprieta'
  // difesa da `guardian-perdite.test.js`, ripetuta qui perche' e' QUESTA modifica a metterla a rischio:
  // dare al guardiano un modulo nuovo e' esattamente il modo in cui si perde per sbaglio.
  const visti = new Set(); const trovati = [];
  const cammina = (file, prof) => {
    if (prof > 4 || visti.has(file) || !fs.existsSync(file)) return;
    visti.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      if (/polymarket-clob-maker[/\\](adapter|signer|orders)|manual-order|bulk-allocate/.test(m[1])) {
        trovati.push(`${path.basename(file)} → ${m[1]}`);
      }
      let r2 = path.resolve(path.dirname(file), m[1]);
      if (!fs.existsSync(r2) && fs.existsSync(`${r2}.js`)) r2 = `${r2}.js`;
      cammina(r2, prof + 1);
    }
  };
  cammina(path.join(RADICE, 'agents', 'agent43-guardian.js'), 0);
  ok(`nessuna superficie di piazzamento nell'albero di agent43 (${visti.size} moduli visitati)`,
    trovati.length === 0, trovati.join(' | '));

  // E il modulo nuovo non ne ha introdotta una: non ha `require` affatto.
  const src = fs.readFileSync(path.join(__dirname, 'chiusura-di-emergenza.js'), 'utf8');
  const req = src.split('\n').filter((l) => /\brequire\s*\(/.test(l) && !/^\s*\/\//.test(l) && !/readFileSync\(__filename/.test(l));
  ok('  e `chiusura-di-emergenza` non ha nessun `require`', req.length === 0, req.join(' | '));
}

// ══ ② agent43 DEPOSITA LA RICHIESTA, E SOLO PER LA PERDITA GIORNALIERA ══════════════════════════════
sez('② agent43 deposita, e solo per la perdita giornaliera');
{
  const src = fs.readFileSync(path.join(RADICE, 'agents', 'agent43-guardian.js'), 'utf8');
  ok('importa il modulo puro che classifica', /require\('\.\.\/lib\/maker\/chiusura-di-emergenza'\)/.test(src));
  ok('il deposito e\' condizionato alla causa `perdita-giornaliera`',
    /if \(causa === 'perdita-giornaliera'\)/.test(src));
  // ⚠ IL DRAWDOWN NON DEVE ESSERE STATO TRASCINATO DENTRO. «Le posizioni aperte NON si toccano» e' una
  // decisione presa e provata: un drawdown misura un PREZZO, che puo' rientrare.
  ok('  e il drawdown continua a NON toccare le posizioni',
    /il drawdown non chiude le posizioni/.test(src));
  ok('il latch porta il conto di cosa e\' stato richiesto', /chiusuraPosizioni:/.test(src));
  ok('e la richiesta non sovrascrive una precedente ancora da eseguire',
    /richiesta precedente non ancora eseguita/.test(src));
}

// ══ ③ agent41 ESEGUE, ANCHE A BOT FERMO ═════════════════════════════════════════════════════════════
sez('③ agent41 esegue, e gira PRIMA del cancello su AVVIA');
{
  const src = fs.readFileSync(path.join(RADICE, 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
  // ⚠ SI PROVA L'ORDINE, perche' e' l'ordine il difetto: la rete non c'era nello stato che la richiede.
  // Non si fotografa il numero di riga (§5.3) — si confrontano due indici nella stessa stringa.
  const iChiusura = src.indexOf('await eseguiChiusuraDiEmergenza()');
  const iCancello = src.indexOf('if (!TRIGGER_ATTIVO || !botAttivo()) return;');
  ok('la chiusura di emergenza e\' chiamata nel ciclo', iChiusura > 0);
  ok('  e sta PRIMA del cancello `botAttivo()` — o a bot FERMO non girerebbe mai',
    iChiusura > 0 && iCancello > 0 && iChiusura < iCancello,
    `chiusura@${iChiusura} cancello@${iCancello}`);
  // ⚠ E il presidio dei 60 minuti sta invece DOPO: e' il fatto che ha reso necessaria questa funzione,
  // e se un giorno qualcuno lo spostasse questa asserzione lo direbbe.
  const iPresidio = src.indexOf('await presidioPosizioniVecchie()');
  ok('  mentre il presidio dei 60 minuti sta DOPO (e infatti a bot FERMO non gira)',
    iPresidio > iCancello, `presidio@${iPresidio} cancello@${iCancello}`);
  ok('il prezzo attraversato viene da UNA funzione sola, condivisa col presidio',
    (src.match(/prezzoUscitaAttraversata\(/g) || []).length >= 3);
}

// ══ ④ LO SCATTO VERO, CONTRO UN FINTO VENUE ════════════════════════════════════════════════════════
sez('④ lo scatto: la richiesta viene eseguita, gamba per gamba');
{
  const A = require(path.join(RADICE, 'agents', 'agent41-realloc-scheduler.js'));
  const file = path.join(tmp, 'richiesta.json');
  const richiesta = {
    v: 1, at: Date.now(), causa: 'perdita-giornaliera', eseguita: false,
    daFondere: [{ conditionId: 'mA', size: 60 }],
    daVendere: [{ asset: 'y2', conditionId: 'mB', size: 40, curPrice: 0.4 }],
    lasciate: [{ asset: 'y3', conditionId: 'mC', size: 6, sottoMinimo: true }],
    esposizioneDirezionaleUsd: 16, bloccataUsd: 3,
  };

  const inviati = [];
  const piazza = async (spec) => { inviati.push(spec); return { ok: true, orderId: 'X' }; };

  fs.writeFileSync(file, JSON.stringify(richiesta));
  const r = A.eseguiChiusuraDiEmergenza({ file, piazza });
  // `eseguiChiusuraDiEmergenza` e' `async`: si aspetta.
  return r.then((esito) => {
    ok('la richiesta e\' stata eseguita', esito !== null);
    // ⚠ Il board di prova non ha `mB`, quindi il miglior bid non e' leggibile e la vendita NON parte.
    // E' il ramo giusto da provare per primo: fail-closed, e nessun ordine al buio.
    ok('  con board assente il bid non e\' leggibile ⇒ NESSUN invio', inviati.length === 0);
    ok('  e la gamba risulta non venduta, dichiarata', esito.vendute.length === 1 && esito.vendute[0].chiusa === false);
    ok('  il motivo dice che non si vende al buio', /non si vende al buio/.test(esito.vendute[0].motivo || ''));
    ok('  le coppie da fondere sono CONTATE e non fuse qui', esito.daFondere === 1);
    ok('  e le lasciate sotto il minimo sono contate', esito.lasciate === 1);

    const dopo = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok('la richiesta e\' marcata eseguita, e non si ripete', dopo.eseguita === true);
    ok('  col conto delle vendite fallite', dopo.venduteFallite === 1 && dopo.venduteOk === 0);
    ok('  e rieseguirla non fa niente', (() => {
      const prima = inviati.length;
      return A.eseguiChiusuraDiEmergenza({ file, piazza }).then((x) => x === null && inviati.length === prima);
    })() instanceof Promise);

    // ── I RAMI CHE NON DEVONO AGIRE ─────────────────────────────────────────────────────────────
    const assente = path.join(tmp, 'non-c-e.json');
    return A.eseguiChiusuraDiEmergenza({ file: assente, piazza }).then((v) => {
      ok('file assente ⇒ nessuna azione, nessun errore', v === null);
      const rotto = path.join(tmp, 'rotto.json');
      fs.writeFileSync(rotto, '{ questo non e json');
      return A.eseguiChiusuraDiEmergenza({ file: rotto, piazza });
    }).then((v) => {
      // ⚠ Un file che non si capisce NON diventa «chiudi tutto»: sarebbe la direzione di guasto peggiore.
      ok('file malformato ⇒ nessuna azione (non diventa «chiudi tutto»)', v === null && inviati.length === 0);
      const gia = path.join(tmp, 'gia.json');
      fs.writeFileSync(gia, JSON.stringify({ ...richiesta, eseguita: true }));
      return A.eseguiChiusuraDiEmergenza({ file: gia, piazza });
    }).then((v) => {
      ok('richiesta gia\' eseguita ⇒ nessuna azione', v === null && inviati.length === 0);
      console.log(`\nR10 · il kill chiude le posizioni: ${pass} passati, ${fail} falliti\n`);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* niente */ }
      process.exit(fail === 0 ? 0 : 1);
    });
  });
}
