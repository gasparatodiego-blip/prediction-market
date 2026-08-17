'use strict';
// lib/maker/cinture-armamento.test.js — LO SPECCHIO NON PUO' DIVERGERE DALL'ORIGINALE.
//
// `cinture-armamento` e' PURO di proposito: `scripts/cli/stato.js` deve poterlo importare senza tirarsi
// dentro le superfici che sanno piazzare (il suo §PERIMETRO cammina `require.cache` e cade se lo fa).
// Dal 17 agosto 2026 le cinture sono QUATTRO e le letture non sono piu' ricopiate: `buildPlacementAdapter`
// importa `modoVivo` e `dryRunInserita` da qui, quindi non c'e' piu' uno specchio da confrontare — c'e'
// UNA lettura, usata sia per raccontare lo stato sia per deciderlo.
//
// ⚠ QUELLO CHE RESTA DA CONFRONTARE E' LA SEMANTICA DELL'ADAPTER, e questo file lo fa importando
// l'adapter VERO: che `MODI_VIVI` sia ancora `LIVE_MODES`, che `evaluatePlacementGate` rifiuti sulle
// stesse combinazioni che noi dichiariamo inserite, e che il ripiego su `MAKER_PLACEMENT` — tolto —
// non torni. Se un giorno l'adapter cambia semantica, questo test cade: e' l'unico modo di accorgersene
// prima che sia un pannello a mentire sullo stato di armamento.
//
// Run: node lib/maker/cinture-armamento.test.js

const C = require('./cinture-armamento');
const { LIVE_MODES, evaluatePlacementGate, v2SdkStatus, createMakerAdapter } = require('../venues/polymarket-clob-maker/adapter');
const { statoFreno } = require('./freno-prova');
const MO = require('./manual-order');

let p = 0; let f = 0;
const ok = (n, c, x) => { c ? (p++, console.log(`  ok  ${n}${x ? ' — ' + x : ''}`)) : (f++, console.log(`  NO  ${n}${x ? ' — ' + x : ''}`)); };

console.log('\n════ cinture-armamento ════');

// ── ① I MODI VIVI SONO GLI STESSI DELL'ADAPTER, per valore e per ordine ────────────────────────
ok('MODI_VIVI === adapter.LIVE_MODES', JSON.stringify(C.MODI_VIVI) === JSON.stringify(LIVE_MODES),
  `${JSON.stringify(C.MODI_VIVI)} vs ${JSON.stringify(LIVE_MODES)}`);

// ── ② `MAKER_MODE` + `MAKER_ADAPTER_DRYRUN`: lo stesso verdetto dell'ADAPTER VERO ──────────────
// `evaluatePlacementGate` e' la funzione che l'adapter usa per rifiutare: restituisce il PRIMO gate che
// si oppone, nell'ordine `kill` → `venue-allowlist` → `limit-*` → `v2-sdk-*` → `maker-mode` → `dry-run`
// → `funding-approval`. Si confronta quel gate con le nostre due cinture, sulle stesse combinazioni.
//
// ⚠ SI PASSA `sdk: v2SdkStatus()`, cioe' lo stato VERO dell'SDK su questa macchina, e non lo si omette:
// omettendolo il primo gate diventa `v2-sdk-missing` e `maker-mode` non viene MAI raggiunto — cioe' il
// confronto misurerebbe l'assenza di un argomento invece della semantica che deve specchiare. E' stata la
// prima stesura di questo blocco, che dichiarava 10 divergenze inesistenti: verificato subito dopo,
// l'SDK c'e' ed e' la 1.1.0. Lo stesso errore in un test di armamento avrebbe fatto dichiarare «rifiuta»
// un adapter che non rifiutava.
{
  const sdk = v2SdkStatus();
  const modi = ['off', 'paper', 'live', 'live-min', 'LIVE', 'Live-Min', '', undefined, 'liv', 'live ',
    'off ', 'true', '0'];
  let divergenze = 0; let casi = 0; const gateVisti = new Set();
  for (const mode of modi) {
    for (const dry of [true, false]) {
      casi += 1;
      const g = evaluatePlacementGate({ mode, dryRun: dry, fundingApproved: true, sdk });
      gateVisti.add(g.gate || '(nessuno: allow)');
      const st = C.statoCinture({ MAKER_MODE: mode, MAKER_ADAPTER_DRYRUN: dry ? 'true' : 'false' });
      // L'adapter valuta il modo per primo, poi il dry-run: si confronta nello stesso ordine.
      const atteso = st.cinture[0].inserita ? 'maker-mode' : (st.cinture[1].inserita ? 'dry-run' : null);
      const suo = (g.gate === 'maker-mode' || g.gate === 'dry-run') ? g.gate : null;
      if (atteso !== suo) {
        divergenze += 1;
        console.log(`     divergenza: mode='${mode}' dryRun=${dry} — noi '${atteso}', adapter '${suo}' (gate reale ${g.gate})`);
      }
    }
  }
  ok('i due gate specchiati coincidono con l\'adapter', divergenze === 0, `${casi} combinazioni`);
  ok('  `LIVE` maiuscolo NON e uno stadio vivo, per entrambi',
    C.modoVivo({ MAKER_MODE: 'LIVE' }) === false
    && evaluatePlacementGate({ mode: 'LIVE', dryRun: false, fundingApproved: true, sdk }).gate === 'maker-mode');
  ok('  e con le cinture aperte l\'adapter dice `allow` (il confronto e esercitato nei due versi)',
    gateVisti.has('(nessuno: allow)'), [...gateVisti].join(', '));
  // ⚠ L'ADAPTER HA GATE CHE QUESTO MODULO NON SPECCHIA, e non e' un difetto: `kill`, `venue-allowlist`,
  // `limit-*`, `v2-sdk-*`, `funding-approval` non sono cinture d'armamento dell'operatore — sono lo stato
  // del sistema. Chi legge `statoCinture` non deve dedurre «puo' piazzare» dal solo `puoPiazzare`: quello
  // dice che le QUATTRO sono aperte, non che l'ordine passerebbe.
  ok('  e i gate NON specchiati esistono e sono raggiungibili',
    evaluatePlacementGate({ mode: 'live', dryRun: false, fundingApproved: false, sdk }).gate === 'funding-approval'
    && evaluatePlacementGate({ mode: 'live', dryRun: false, fundingApproved: true, sdk, kill: { killed: true } }).gate === 'kill');
}

// ── ③ LA CINTURA TOLTA DEVE RESTARE TOLTA — 17 agosto 2026 ────────────────────────────────────
// `MAKER_PLACEMENT` era il ripiego sull'ambiente di `adapter.js` per il campo `placement`, e su questo
// bot non aveva chiamanti: l'unico costruttore dell'adapter passa sempre `placement` esplicito. E' stata
// TOLTA. Qui si prova la proprieta' che la rimozione ha creato — **nessuna variabile d'ambiente puo'
// piu' portare `placement` a `send`** — perche' un ripiego rimesso per distrazione tornerebbe a essere
// una via d'armamento che nessuna delle quattro cinture sorveglia.
{
  const originale = process.env.MAKER_PLACEMENT;
  process.env.MAKER_PLACEMENT = 'send';
  try {
    const senzaOpt = createMakerAdapter({ mode: 'off' });
    ok('un adapter costruito SENZA `placement` resta dry-run anche con la vecchia env a `send`',
      senzaOpt.placement === 'dry-run', `placement='${senzaOpt.placement}'`);
    const conOpt = createMakerAdapter({ mode: 'off', placement: 'send' });
    ok('  e `placement` passato esplicitamente continua a valere', conOpt.placement === 'send');
    // La direzione conta: si prova che il ripiego non c'e' PIU', non che non c'e' mai stato.
    const src = require('fs').readFileSync(require.resolve('../venues/polymarket-clob-maker/adapter'), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    ok('  e il sorgente dell\'adapter non legge piu\' quella env fuori dai commenti',
      !/process\.env\.MAKER_PLACEMENT/.test(src));
    ok('  il modulo non esporta piu\' la sua lettura', typeof C.makerPlacement === 'undefined');
  } finally {
    if (originale === undefined) delete process.env.MAKER_PLACEMENT; else process.env.MAKER_PLACEMENT = originale;
  }
}

// ── ④ `MANUAL_ORDER_PLACEMENT`: NON e' uno specchio, e' la fonte ───────────────────────────────
{
  ok('manual-order.manualPlacement E la nostra funzione (stesso riferimento)', MO.manualPlacement === C.manualPlacement);
  const valori = ['send', 'SEND ', ' send ', 'dry-run', '', undefined, 'true'];
  let uguali = 0;
  for (const v of valori) if (MO.manualPlacement({ MANUAL_ORDER_PLACEMENT: v }) === C.manualPlacement({ MANUAL_ORDER_PLACEMENT: v })) uguali += 1;
  ok('  e su ogni valore danno la stessa risposta', uguali === valori.length, `${uguali}/${valori.length}`);
}

// ── ⑤ IL FRENO E' IMPORTATO, non ricopiato ────────────────────────────────────────────────────
{
  const casi = [undefined, '', '0', 'false', 'off', 'no', 'spento', '1', 'true', 'on', 'yes', 'pippo'];
  let uguali = 0;
  for (const v of casi) {
    const env = v === undefined ? {} : { REALLOC_SCHEDULER_DRY_RUN: v };
    const c = C.statoCinture(env).cinture.find((x) => x.nome === 'REALLOC_SCHEDULER_DRY_RUN');
    if (c.inserita === statoFreno(env).attivo) uguali += 1;
  }
  ok('il freno di agent41 viene da `freno-prova`, non da una copia', uguali === casi.length, `${uguali}/${casi.length}`);
  ok('  assente ⇒ INSERITO (fail-closed)', C.statoCinture({}).cinture.find((x) => x.nome === 'REALLOC_SCHEDULER_DRY_RUN').inserita === true);
  ok('  `0` ⇒ DISINSERITO', C.statoCinture({ REALLOC_SCHEDULER_DRY_RUN: '0' }).cinture.find((x) => x.nome === 'REALLOC_SCHEDULER_DRY_RUN').inserita === false);
}

// ── ⑥ `puoPiazzare` E' LA CONGIUNZIONE: basta UNA cintura inserita su quattro per dire no ─────
{
  const armato = { MAKER_MODE: 'live-min', MAKER_ADAPTER_DRYRUN: 'false',
    MANUAL_ORDER_PLACEMENT: 'send', REALLOC_SCHEDULER_DRY_RUN: '0' };
  ok('tutte e quattro aperte ⇒ puoPiazzare', C.statoCinture(armato).puoPiazzare === true);
  ok('  e le inserite sono ZERO', C.statoCinture(armato).inserite === 0);
  let sempreNo = true;
  for (const k of Object.keys(armato)) {
    const e = { ...armato };
    e[k] = k === 'MAKER_ADAPTER_DRYRUN' ? 'true' : (k === 'MAKER_MODE' ? 'off' : (k === 'REALLOC_SCHEDULER_DRY_RUN' ? '1' : 'dry-run'));
    if (C.statoCinture(e).puoPiazzare !== false) sempreNo = false;
  }
  ok('  richiudere UNA QUALUNQUE delle quattro basta a dire no', sempreNo);
  // ⚠ TRE E NON QUATTRO, e la stessa riga si sbagliava gia' prima della rimozione: con un ambiente VUOTO
  // `MAKER_ADAPTER_DRYRUN` non e' impostata, quindi quella cintura e' onestamente APERTA. Un ambiente
  // vuoto non arma niente (le altre tre bastano), ma dire «quattro inserite» sarebbe contare una
  // cintura che non c'e' — cioe' rassicurare oltre i fatti, che e' il difetto che questo modulo esiste
  // per non commettere.
  ok('ambiente vuoto ⇒ TRE inserite (DRYRUN non impostata e onestamente aperta)',
    C.statoCinture({}).inserite === 3, C.statoCinture({}).cinture.filter((c) => !c.inserita).map((c) => c.nome).join(','));
  ok('  ma non puo comunque piazzare', C.statoCinture({}).puoPiazzare === false);
  ok('  e non solleva su un ambiente strano', (() => {
    try { return C.statoCinture(null).inserite === 3 && C.statoCinture(undefined) !== null; } catch { return false; }
  })());
}

// ── ⑦ L'ATTESTAZIONE NON E' UNA CINTURA, e non si conta fra le quattro ────────────────────────
{
  const s = C.statoCinture({ MAKER_FUNDING_APPROVED: 'true' });
  ok('MAKER_FUNDING_APPROVED e riportata a parte', s.attestazioneFinanziamento.attestata === true);
  ok('  e NON entra nel conto delle quattro', s.cinture.length === 4 && s.inserite === 3);
  ok('  il perno viene normalizzato in minuscolo', C.statoCinture({ MAKER_LIVE_MIN_MARKET: ' 0xAB ' }).perno === '0xab');
  ok('  e un perno vuoto e `null`, non stringa vuota', C.statoCinture({ MAKER_LIVE_MIN_MARKET: '  ' }).perno === null);
}

// ── ⑧ LA DOMANDA CHE HA FATTO NASCERE IL MODULO: due ambienti DIVERSI, due risposte diverse ───
// E' il caso del 17 agosto: il `.env` diceva una cintura vuota, `/proc` diceva `send`. Una funzione che
// prende l'ambiente come parametro puo' dire la verita' su entrambi; una che legge `process.env` puo'
// dirla solo su uno, e non e' quello che conta.
{
  const dalFile = C.statoCinture({ MAKER_MODE: 'off', MAKER_ADAPTER_DRYRUN: 'true' });
  const dalProcesso = C.statoCinture({ MAKER_MODE: 'live-min', MAKER_ADAPTER_DRYRUN: 'true',
    MANUAL_ORDER_PLACEMENT: 'send', REALLOC_SCHEDULER_DRY_RUN: '0' });
  ok('lo stesso codice, due ambienti, due verdetti', dalFile.inserite === 4 && dalProcesso.inserite === 1,
    `file ${dalFile.inserite}/4 inserite · processo ${dalProcesso.inserite}/4`);
  ok('  e quella che resta inserita nel processo e la cintura DRYRUN',
    dalProcesso.cinture.filter((c) => c.inserita).map((c) => c.nome).join(',') === 'MAKER_ADAPTER_DRYRUN');
}

console.log(`\ncinture-armamento: ${p} verdi, ${f} rossi`);
process.exit(f === 0 ? 0 : 1);
