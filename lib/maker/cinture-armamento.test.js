'use strict';
// lib/maker/cinture-armamento.test.js — LO SPECCHIO NON PUO' DIVERGERE DALL'ORIGINALE.
//
// `cinture-armamento` e' PURO di proposito: `scripts/cli/stato.js` deve poterlo importare senza tirarsi
// dentro le superfici che sanno piazzare (il suo §PERIMETRO cammina `require.cache` e cade se lo fa).
// Il prezzo di quella purezza e' che tre delle cinque letture — `MAKER_MODE`, `MAKER_ADAPTER_DRYRUN`,
// `MAKER_PLACEMENT` — sono scritte DUE volte: qui e dentro l'adapter.
//
// ⚠ DUE COPIE DELLA STESSA REGOLA SONO IL REPERTO D1 FINCHE' NESSUNO LE CONFRONTA. Questo file le
// confronta: importa l'adapter VERO e pretende che le due letture diano lo stesso verdetto su tutte le
// combinazioni che contano, compresi i valori sbagliati di proposito (`'SEND '`, `'true'`, `'Live'`).
// Se un giorno l'adapter cambia semantica, questo test cade — che e' l'unico modo di accorgersene prima
// che sia un pannello a mentire sullo stato di armamento.
//
// Run: node lib/maker/cinture-armamento.test.js

const C = require('./cinture-armamento');
const { LIVE_MODES, evaluatePlacementGate, v2SdkStatus } = require('../venues/polymarket-clob-maker/adapter');
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
  // dice che le CINQUE sono aperte, non che l'ordine passerebbe.
  ok('  e i gate NON specchiati esistono e sono raggiungibili',
    evaluatePlacementGate({ mode: 'live', dryRun: false, fundingApproved: false, sdk }).gate === 'funding-approval'
    && evaluatePlacementGate({ mode: 'live', dryRun: false, fundingApproved: true, sdk, kill: { killed: true } }).gate === 'kill');
}

// ── ③ `MAKER_PLACEMENT`: la stessa regola del `send` esatto ────────────────────────────────────
// L'adapter la applica a riga 559-562 costruendo `placement`. Non la espone come funzione, quindi si
// confronta il COMPORTAMENTO documentato — `send` esatto e nient'altro — su tutti i modi di sbagliarlo.
{
  const valori = ['send', 'SEND', 'SEND ', ' send', 'send ', 'true', 'yes', '1', '', undefined, 'sendd', 'Send'];
  const attesi = valori.map((v) => (typeof v === 'string' && v.trim() === 'send' ? 'send' : 'dry-run'));
  const nostri = valori.map((v) => C.makerPlacement({ MAKER_PLACEMENT: v }));
  ok('MAKER_PLACEMENT: `send` esatto (dopo trim) e nient\'altro', JSON.stringify(nostri) === JSON.stringify(attesi),
    `${valori.filter((v, i) => nostri[i] === 'send').length} su ${valori.length} passano`);
  // ⚠ `' send'` e `'send '` PASSANO, perche' l'adapter fa `.trim()`. E' scritto qui perche' la prima
  // stesura di questo test si aspettava che fossero dry-run, e sarebbe stato uno specchio piu' severo
  // dell'originale: uno specchio sbagliato in direzione prudente e' comunque uno specchio sbagliato,
  // perche' fa dichiarare «disarmato» un bot armato.
  ok('  e lo spazio intorno NON conta (l\'adapter fa trim)', C.makerPlacement({ MAKER_PLACEMENT: ' send ' }) === 'send');
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

// ── ⑥ `puoPiazzare` E' LA CONGIUNZIONE: bastano quattro cinture aperte su cinque per dire no ───
{
  const armato = { MAKER_MODE: 'live-min', MAKER_ADAPTER_DRYRUN: 'false', MAKER_PLACEMENT: 'send',
    MANUAL_ORDER_PLACEMENT: 'send', REALLOC_SCHEDULER_DRY_RUN: '0' };
  ok('tutte e cinque aperte ⇒ puoPiazzare', C.statoCinture(armato).puoPiazzare === true);
  ok('  e le inserite sono ZERO', C.statoCinture(armato).inserite === 0);
  let sempreNo = true;
  for (const k of Object.keys(armato)) {
    const e = { ...armato };
    e[k] = k === 'MAKER_ADAPTER_DRYRUN' ? 'true' : (k === 'MAKER_MODE' ? 'off' : (k === 'REALLOC_SCHEDULER_DRY_RUN' ? '1' : 'dry-run'));
    if (C.statoCinture(e).puoPiazzare !== false) sempreNo = false;
  }
  ok('  richiudere UNA QUALUNQUE delle cinque basta a dire no', sempreNo);
  // ⚠ QUATTRO E NON CINQUE, e la prima stesura di questa riga si aspettava cinque: con un ambiente VUOTO
  // `MAKER_ADAPTER_DRYRUN` non e' impostata, quindi quella cintura e' onestamente APERTA. Un ambiente
  // vuoto non arma niente (le altre quattro bastano), ma dire «cinque inserite» sarebbe contare una
  // cintura che non c'e' — cioe' rassicurare oltre i fatti, che e' il difetto che questo modulo esiste
  // per non commettere.
  ok('ambiente vuoto ⇒ QUATTRO inserite (DRYRUN non impostata e onestamente aperta)',
    C.statoCinture({}).inserite === 4, C.statoCinture({}).cinture.filter((c) => !c.inserita).map((c) => c.nome).join(','));
  ok('  ma non puo comunque piazzare', C.statoCinture({}).puoPiazzare === false);
  ok('  e non solleva su un ambiente strano', (() => {
    try { return C.statoCinture(null).inserite === 4 && C.statoCinture(undefined) !== null; } catch { return false; }
  })());
}

// ── ⑦ L'ATTESTAZIONE NON E' UNA CINTURA, e non si conta fra le cinque ─────────────────────────
{
  const s = C.statoCinture({ MAKER_FUNDING_APPROVED: 'true' });
  ok('MAKER_FUNDING_APPROVED e riportata a parte', s.attestazioneFinanziamento.attestata === true);
  ok('  e NON entra nel conto delle cinque', s.cinture.length === 5 && s.inserite === 4);
  ok('  il perno viene normalizzato in minuscolo', C.statoCinture({ MAKER_LIVE_MIN_MARKET: ' 0xAB ' }).perno === '0xab');
  ok('  e un perno vuoto e `null`, non stringa vuota', C.statoCinture({ MAKER_LIVE_MIN_MARKET: '  ' }).perno === null);
}

// ── ⑧ LA DOMANDA CHE HA FATTO NASCERE IL MODULO: due ambienti DIVERSI, due risposte diverse ───
// E' il caso del 17 agosto: il `.env` diceva `MAKER_PLACEMENT` vuota, `/proc` diceva `send`. Una
// funzione che prende l'ambiente come parametro puo' dire la verita' su entrambi; una che legge
// `process.env` puo' dirla solo su uno, e non e' quello che conta.
{
  const dalFile = C.statoCinture({ MAKER_MODE: 'off', MAKER_ADAPTER_DRYRUN: 'true', MAKER_PLACEMENT: '' });
  const dalProcesso = C.statoCinture({ MAKER_MODE: 'live-min', MAKER_ADAPTER_DRYRUN: 'true',
    MAKER_PLACEMENT: 'send', MANUAL_ORDER_PLACEMENT: 'send', REALLOC_SCHEDULER_DRY_RUN: '0' });
  ok('lo stesso codice, due ambienti, due verdetti', dalFile.inserite === 5 && dalProcesso.inserite === 1,
    `file ${dalFile.inserite}/5 inserite · processo ${dalProcesso.inserite}/5`);
  ok('  e quella che resta inserita nel processo e la cintura DRYRUN',
    dalProcesso.cinture.filter((c) => c.inserita).map((c) => c.nome).join(',') === 'MAKER_ADAPTER_DRYRUN');
}

console.log(`\ncinture-armamento: ${p} verdi, ${f} rossi`);
process.exit(f === 0 ? 0 : 1);
