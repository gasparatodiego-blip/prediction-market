#!/usr/bin/env node
'use strict';
/**
 * LE QUATTRO CINTURE, UNA ALLA VOLTA, CONTRO IL VENUE SIMULATO.
 *
 * ═══ LA DOMANDA ════════════════════════════════════════════════════════════════════════════════════
 * «Ognuna delle quattro inserita DA SOLA, con le altre tre tolte: l'ordine NON deve partire.»
 * Quattro prove, quattro rifiuti — piu' un CONTROLLO, che e' la meta' che rende la prova una prova.
 *
 * ⚠ SENZA IL CONTROLLO QUESTO SCRIPT NON DIMOSTRA NIENTE. Quattro rifiuti si ottengono anche con un
 * mercato inesistente, un saldo illeggibile o un `deps` sbagliato: sarebbero quattro verdi che non
 * parlano delle cinture. Quindi il primo caso apre TUTTE E QUATTRO e pretende che l'ordine PARTA — e
 * se non parte, lo script si ferma li' e lo dice, invece di proseguire e collezionare rifiuti muti.
 * E' la lezione di §5-bis p.181: un test che prova la DECISIONE e non il CABLAGGIO e' verde a vuoto.
 *
 * ═══ PERCHE' NEL BANCO E NON IN UN TEST UNITARIO ═══════════════════════════════════════════════════
 * Perche' le tre cinture dell'adapter sono state INERTI per settimane pur essendo lette da un test
 * unitario: il test provava che `statoCinture` le sapeva leggere, non che qualcuno le passasse a
 * `createMakerAdapter`. Qui si passa dal `placeManualOrder` VERO, con le sue dipendenze di produzione,
 * contro il venue sostituito dal banco. Se una cintura non e' cablata, l'ordine parte e questo file
 * diventa rosso.
 *
 * ═══ DOVE MORDE OGNUNA ═════════════════════════════════════════════════════════════════════════════
 *   MAKER_MODE                 gate `maker-mode` dentro `evaluatePlacementGate` (via `buildPlacementAdapter`)
 *   MAKER_ADAPTER_DRYRUN       gate `dry-run`    idem
 *   MANUAL_ORDER_PLACEMENT     l'ultimo `if` prima della POST (`adapter.js`: `placement !== 'send'`)
 *   REALLOC_SCHEDULER_DRY_RUN  NON e' una cintura dell'adapter: vive in agent41, che passa
 *                              `dryRunOnly` a `runBulkAllocation`. Si prova al SUO livello, o si
 *                              proverebbe una cosa diversa da quella che ferma il bot.
 *
 * Uso:  node scripts/ricerca/prova-cinture.js [--verboso]
 * Esce 1 se anche una sola cintura non ferma il piazzamento, o se il controllo non parte.
 */
const path = require('path');
const fs = require('fs');

const BASE = require('./banco-ciclo-completo');
const { VENUE, OROLOGIO, ROOT } = BASE;
const VERBOSO = process.argv.includes('--verboso');

const A41 = require(path.join(ROOT, 'agents/agent41-realloc-scheduler'));
const MO = require(path.join(ROOT, 'lib/maker/manual-order'));
const ARC = require(path.join(ROOT, 'lib/maker/auto-reprice-config'));
const MM = require(path.join(ROOT, 'lib/maker/manual-mode'));
const ACC = require(path.join(ROOT, 'lib/maker/auto-close-config'));
const BOT = require(path.join(ROOT, 'lib/maker/bot-enabled'));

let verdi = 0; let rossi = 0;
const esiti = [];
const ok = (nome, cond, extra) => {
  cond ? (verdi += 1) : (rossi += 1);
  console.log(`  ${cond ? '✅' : '❌'} ${nome}${extra ? ` — ${extra}` : ''}`);
  esiti.push({ nome, ok: !!cond, extra: extra || null });
};

// ── L'AMBIENTE: quattro cinture, e la posizione di ognuna ──────────────────────────────────────────
// APERTA = il valore che NON ferma. INSERITA = il valore che ferma. `MAKER_FUNDING_APPROVED` non e'
// una cintura ma un'attestazione, e va `true` in tutti i casi: senza, il gate rifiuterebbe con
// `funding-approval` e ogni caso sarebbe rosso per la ragione sbagliata.
const APERTE = Object.freeze({
  MAKER_MODE: 'live-min',
  MAKER_ADAPTER_DRYRUN: 'false',
  MANUAL_ORDER_PLACEMENT: 'send',
  REALLOC_SCHEDULER_DRY_RUN: '0',
});
const INSERITE = Object.freeze({
  MAKER_MODE: 'off',
  MAKER_ADAPTER_DRYRUN: 'true',
  MANUAL_ORDER_PLACEMENT: 'dry-run',
  REALLOC_SCHEDULER_DRY_RUN: '1',
});
// Il gate che ci si aspetta quando quella cintura e' l'unica inserita. `null` = non c'e' un gate, la
// cintura ferma DOPO il verdetto (e' il caso di `MANUAL_ORDER_PLACEMENT`, che e' l'ultimo `if`).
const GATE_ATTESO = Object.freeze({
  MAKER_MODE: 'maker-mode',
  MAKER_ADAPTER_DRYRUN: 'dry-run',
  MANUAL_ORDER_PLACEMENT: null,
  REALLOC_SCHEDULER_DRY_RUN: null,
});

/** L'ambiente completo con UNA sola cintura inserita (o nessuna, per il controllo). */
function ambiente(inserita) {
  const env = { ...process.env, ...APERTE, MAKER_FUNDING_APPROVED: 'true' };
  if (inserita) env[inserita] = INSERITE[inserita];
  return env;
}

const MKT = `0x${'fe'.repeat(32)}`;

(async () => {
  console.log('\n════ LE QUATTRO CINTURE, UNA ALLA VOLTA ════');
  console.log(`worktree ${ROOT}\n`);

  // ── PREPARAZIONE: un mercato quotabile, e il perno che lo nomina ─────────────────────────────────
  VENUE.azzera('prova delle cinture');
  const m = VENUE.creaMercato({ conditionId: MKT, mid: 0.40, tick: 0.01, minSize: 20, bandaCents: 4.5,
    oreAllaScadenza: 60, question: 'banco · prova cinture' });
  MM.setManualMode({ marketId: MKT, manual: true, by: 'prova-cinture', reason: 'prova delle cinture' });
  ARC.setAutoReprice({ scope: 'global', enabled: true, by: 'prova-cinture', reason: 'prova' });
  ARC.setAutoReprice({ scope: 'market', marketId: MKT, enabled: true, by: 'prova-cinture', reason: 'prova' });
  ACC.setAutoClose({ scope: 'market', marketId: MKT, enabled: true, by: 'prova-cinture', reason: 'prova' });
  BOT.impostaBot({ enabled: true, by: 'prova-cinture', reason: 'prova delle cinture' });
  // ⚠ IL PERNO VA IMPOSTATO NEL PROCESSO, o il gate `live-min-market-unset` rifiuta tutto e i quattro
  // rifiuti sarebbero suoi, non delle cinture. E' la ragione per cui esiste il controllo.
  process.env.MAKER_LIVE_MIN_MARKET = MKT;

  // Il prezzo: un tick dentro il bordo basso della banda, size sopra il minimo premiante.
  const spec = { marketId: MKT, book: 'yes', side: 'BUY', price: 0.37, size: 60, source: 'manual-ui' };

  /** Un tentativo di piazzamento, e cosa e' arrivato AL VENUE. Il criterio sono gli ordini, non il verdetto. */
  async function tenta(inserita) {
    const prima = VENUE.ordiniVivi(MKT).length;
    let res;
    try { res = await MO.placeManualOrder(spec, { env: ambiente(inserita) }); }
    catch (e) { res = { errore: e.message }; }
    const dopo = VENUE.ordiniVivi(MKT).length;
    return { res, arrivatiAlVenue: dopo - prima, ordiniOra: dopo };
  }

  // ══ CONTROLLO · TUTTE E QUATTRO APERTE ⇒ L'ORDINE DEVE PARTIRE ══════════════════════════════════
  // Se questo e' rosso, i quattro casi sotto non provano niente e lo script si ferma.
  const ctrl = await tenta(null);
  if (VERBOSO) console.log('    controllo:', JSON.stringify(ctrl.res).slice(0, 400));
  ok('CONTROLLO · quattro cinture APERTE ⇒ l\'ordine PARTE',
    ctrl.arrivatiAlVenue === 1 && ctrl.res && ctrl.res.ok === true && ctrl.res.sent === true,
    `ordini nuovi al venue: ${ctrl.arrivatiAlVenue} · ok=${ctrl.res && ctrl.res.ok} sent=${ctrl.res && ctrl.res.sent}`
    + (ctrl.res && ctrl.res.gate ? ` gate=${ctrl.res.gate}` : ''));
  if (ctrl.arrivatiAlVenue !== 1) {
    console.log('\n🔴 IL CONTROLLO NON E\' PASSATO: senza un piazzamento che riesce, «la cintura ferma»');
    console.log('   e «qualcos\'altro fermava gia\'» sono indistinguibili. Non proseguo.');
    console.log(`   verdetto del controllo: ${JSON.stringify(ctrl.res).slice(0, 600)}`);
    process.exit(1);
  }

  // ══ LE TRE CINTURE DELL'ADAPTER, UNA ALLA VOLTA ════════════════════════════════════════════════
  for (const cintura of ['MAKER_MODE', 'MAKER_ADAPTER_DRYRUN', 'MANUAL_ORDER_PLACEMENT']) {
    VENUE.azzera(`cintura ${cintura}`);
    VENUE.creaMercato({ conditionId: MKT, mid: 0.40, tick: 0.01, minSize: 20, bandaCents: 4.5,
      oreAllaScadenza: 60, question: 'banco · prova cinture' });
    const t = await tenta(cintura);
    if (VERBOSO) console.log(`    ${cintura}:`, JSON.stringify(t.res).slice(0, 400));
    const gate = t.res && (t.res.gate || (t.res.result && t.res.result.gate)) || null;
    const atteso = GATE_ATTESO[cintura];
    ok(`${cintura} inserita DA SOLA ⇒ nessun ordine al venue`,
      t.arrivatiAlVenue === 0,
      `ordini nuovi: ${t.arrivatiAlVenue} · sent=${t.res && t.res.sent} · gate=${gate || '(nessuno)'}`);
    if (atteso) {
      ok(`  e il rifiuto e' proprio il suo gate \`${atteso}\``, gate === atteso, `letto: ${gate || '(nessuno)'}`);
    } else {
      // `MANUAL_ORDER_PLACEMENT` non produce un gate: l'ordine e' costruito, firmato, fatto validare, e
      // fermato nell'istante prima della POST. Il segno e' `dry-run-validated`, ed e' diverso da un
      // rifiuto — pretenderlo distingue «fermato dall'ultima cintura» da «rifiutato da un'altra».
      const dry = !!(t.res && t.res.sent === false && (t.res.dryRun === true || t.res.placement === 'dry-run'));
      ok('  e si ferma DOPO i gate, nell\'istante prima della POST (`dry-run-validated`)', dry,
        `sent=${t.res && t.res.sent} dryRun=${t.res && t.res.dryRun} placement=${t.res && t.res.placement}`);
    }
  }

  // ══ LA QUARTA: IL FRENO DI agent41, AL SUO LIVELLO ═════════════════════════════════════════════
  // ⚠ NON si prova con `placeManualOrder`: il freno non vive li'. Vive in `giro()` e nel controllo del
  // capitale fermo, che passano `dryRunOnly` a `runBulkAllocation`. Provarlo dall'altra parte
  // misurerebbe una cosa che non e' quella che ferma il bot — l'errore delle tre difese inerti.
  {
    VENUE.azzera('cintura REALLOC_SCHEDULER_DRY_RUN');
    VENUE.creaMercato({ conditionId: MKT, mid: 0.40, tick: 0.01, minSize: 20, bandaCents: 4.5,
      oreAllaScadenza: 60, question: 'banco · prova cinture' });
    const salva = process.env.REALLOC_SCHEDULER_DRY_RUN;
    // Le altre tre APERTE nel processo, cosi' se il freno non mordesse l'ordine partirebbe davvero.
    for (const [k, v] of Object.entries({ ...APERTE, MAKER_FUNDING_APPROVED: 'true' })) process.env[k] = v;
    process.env.REALLOC_SCHEDULER_DRY_RUN = INSERITE.REALLOC_SCHEDULER_DRY_RUN;
    const prima = VENUE.ordiniVivi().length;
    let giro = null;
    try { giro = await A41.giro(); } catch (e) { giro = { errore: e.message }; }
    let mini = null;
    try { mini = await A41.controlloCapitaleFermo(); } catch (e) { mini = { errore: e.message }; }
    const dopo = VENUE.ordiniVivi().length;
    if (VERBOSO) console.log('    freno · giro:', JSON.stringify(giro).slice(0, 300));
    ok('REALLOC_SCHEDULER_DRY_RUN inserita DA SOLA ⇒ nessun ordine al venue',
      dopo - prima === 0, `ordini nuovi dopo giro()+controlloCapitaleFermo(): ${dopo - prima}`);
    // E che il freno sia stato LETTO, non che il giro sia semplicemente morto prima: un giro che
    // esplode non manda ordini e sarebbe verde per la ragione sbagliata.
    const FRENO = require(path.join(ROOT, 'lib/maker/freno-prova'));
    ok('  e il freno risulta INSERITO alla rilettura di produzione', FRENO.statoFreno().attivo === true,
      FRENO.statoFreno().motivo);
    ok('  e il giro NON e\' morto con un errore (il rifiuto e\' una scelta, non un incidente)',
      !(giro && giro.errore) && !(mini && mini.errore),
      `giro: ${giro && giro.errore ? giro.errore : 'ok'} · mini: ${mini && mini.errore ? mini.errore : 'ok'}`);
    if (salva === undefined) delete process.env.REALLOC_SCHEDULER_DRY_RUN;
    else process.env.REALLOC_SCHEDULER_DRY_RUN = salva;
  }

  const OUT = path.join(ROOT, 'data', 'ricerca', 'prova-cinture.json');
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ verdi, rossi, esiti }, null, 2));
    console.log(`\nreferto → ${path.relative(ROOT, OUT)}`);
  } catch (e) { console.log(`\n(referto non scritto: ${e.message})`); }

  console.log(`\nquattro cinture: ${verdi} verdi, ${rossi} rossi`);
  try { BASE.chiudiClobSimulato(); } catch { /* gia' chiuso */ }
  process.exit(rossi === 0 ? 0 : 1);
})();
