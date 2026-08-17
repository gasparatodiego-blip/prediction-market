'use strict';
// lib/maker/cinture-armamento.js — LE CINQUE CINTURE, LETTE DA UN AMBIENTE QUALUNQUE. PURO.
//
// ═══ IL DIFETTO CHE CHIUDE (§ APERTI punto 4, 17 agosto 2026) ════════════════════════════════════════
// `scripts/cli/stato.js` stampava le cinture leggendo `process.env`, cioe' il `.env` caricato da se
// stesso. **Mi ha mentito una volta**: il 17 agosto il `.env` dichiarava `MAKER_PLACEMENT` vuota mentre
// `/proc/<pid>/environ` dei processi vivi diceva `send`. Il file dice cosa e' stato SCRITTO; il processo
// dice cosa sta USANDO — e pm2 tiene la propria copia dell'ambiente, quindi i due divergono a ogni
// riavvio fatto senza `--update-env` o senza ripartire dal file (§5.1, §5.2 p.2).
//
// Un pannello che risponde «disarmato» leggendo la fonte sbagliata e' peggio di un pannello assente:
// e' la stessa classe della riga «processi definiti 11» che diceva 11 a flotta accesa e 11 a flotta
// spenta (§5.1). Da qui in poi lo stato delle cinture si chiede a QUESTA funzione, passandole
// l'ambiente di un PROCESSO.
//
// ═══ PERCHE' UN MODULO E NON UN `if` DENTRO `stato.js` ═══════════════════════════════════════════════
// Perche' `stato.js` non puo' importare le superfici che decidono davvero: il suo §PERIMETRO cammina
// `require.cache` e FALLISCE se ha caricato qualcosa che sa agire sul venue — e `manual-order` e
// l'adapter sono esattamente quelle superfici. Serviva un posto puro dove vivesse l'aritmetica.
//
// ⚠ DUE DELLE CINQUE SONO IMPORTATE DAVVERO, NON RICOPIATE:
//   · il **freno di agent41** viene da `freno-prova.statoFreno` (puro, fail-closed, un'unica fonte);
//   · **`MANUAL_ORDER_PLACEMENT`** e' definita QUI e `manual-order.manualPlacement` la importa —
//     la dipendenza va nel verso giusto, cosi' la corsia manuale e il pannello non possono divergere.
//
// ⚠ LE ALTRE TRE SONO UNO SPECCHIO DELL'ADAPTER, E LO SPECCHIO E' PROVATO. `MAKER_MODE`,
// `MAKER_ADAPTER_DRYRUN` e `MAKER_PLACEMENT` sono lette da `polymarket-clob-maker/adapter.js`
// (righe 196-197 e 559-562) e importarle da qui tirerebbe l'adapter dentro `stato.js`. Quindi
// l'aritmetica e' scritta due volte — ed e' il reperto D1 se nessuno la confronta: per questo
// `cinture-armamento.test.js` importa l'adapter VERO e asserisce che le due letture coincidano su
// tutte le combinazioni, `LIVE_MODES` compreso. Non e' una promessa, e' un test che cade.
//
// ⚠ E LA SESTA VOCE NON E' UNA CINTURA. `MAKER_FUNDING_APPROVED` e' un'ATTESTAZIONE: da `true` il gate
// di piazzamento non rifiuta piu' per quel motivo, cioe' e' una cintura nella posizione APERTA. Si
// riporta perche' va saputa (l'`ecosystem` la dichiara `true` su agent40 e agent41), ma non si conta
// fra le cinque: contarla come «inserita» quando e' `true` sarebbe leggerla al rovescio.

const { statoFreno } = require('./freno-prova');

// Gli stessi due valori di `adapter.LIVE_MODES`. Il test asserisce l'uguaglianza con l'originale.
const MODI_VIVI = Object.freeze(['live-min', 'live']);

const str = (env, k) => {
  try { const v = env ? env[k] : undefined; return typeof v === 'string' ? v : (v == null ? undefined : String(v)); }
  catch { return undefined; }
};

/** `MANUAL_ORDER_PLACEMENT`: qualunque cosa che non sia esattamente `send` e' dry-run. */
function manualPlacement(env = process.env) {
  const raw = str(env, 'MANUAL_ORDER_PLACEMENT');
  return (typeof raw === 'string' ? raw.trim() : '') === 'send' ? 'send' : 'dry-run';
}

/** `MAKER_PLACEMENT`: stessa regola, stessa ragione — la POST parte solo su `send` esatto. */
function makerPlacement(env = process.env) {
  const raw = str(env, 'MAKER_PLACEMENT');
  return (typeof raw === 'string' ? raw.trim() : '') === 'send' ? 'send' : 'dry-run';
}

// ⚠ NIENTE `trim()` E NIENTE `toLowerCase()`, E L'HA TROVATO IL TEST DELLO SPECCHIO. La prima stesura
// normalizzava, e su `'LIVE'` o `'live '` dichiarava la cintura APERTA mentre `config.loadMakerConfig`
// (riga 57-58, `MODES.includes(rawMode)` su `envStr`, che non tocca la stringa) risolve quei valori a
// `off` — cioe' cintura INSERITA. Un pannello piu' permissivo dell'originale su una cintura di armamento
// dice «armato» dove il codice rifiuta, e la prossima volta che qualcuno lo legge prima di armare non
// puo' fidarsene. Uno specchio deve essere esatto, non ragionevole.
/** `MAKER_MODE`: vivo solo sui due valori ESATTI `live-min` e `live`. */
function modoVivo(env = process.env) {
  return MODI_VIVI.includes(str(env, 'MAKER_MODE'));
}

// ⚠ E `MAKER_ADAPTER_DRYRUN` E' `=== 'true'` ESATTO, per la stessa ragione al rovescio: `config.envBool`
// fa `v === 'true'`, quindi `'TRUE'` NON inserisce la cintura. Con un confronto insensibile alle maiuscole
// questo modulo l'avrebbe dichiarata inserita — cioe' avrebbe dichiarato sicura una configurazione che
// non lo e'. Fra i due errori possibili, questo e' quello che costa.
const dryRunInserita = (env) => str(env, 'MAKER_ADAPTER_DRYRUN') === 'true';

/**
 * LO STATO DELLE CINQUE CINTURE per UN ambiente.
 *
 * @param env  l'ambiente da leggere — per un processo vivo: `/proc/<pid>/environ` parsato
 * @returns {{cinture:Array, inserite:number, aperte:number, puoPiazzare:boolean,
 *            attestazioneFinanziamento:{valore:string|null, attestata:boolean}}}
 *
 * `puoPiazzare` e' vero SOLO se tutte e cinque sono aperte: e' la congiunzione, non un giudizio.
 */
function statoCinture(env = process.env) {
  const modo = str(env, 'MAKER_MODE');
  const dry = dryRunInserita(env);
  const mp = makerPlacement(env);
  const op = manualPlacement(env);
  const freno = statoFreno(env || {});

  const cinture = [
    { nome: 'MAKER_MODE', valore: modo == null ? null : modo, inserita: !MODI_VIVI.includes(modo),
      cosaGoverna: 'l\'adapter maker raggiunge il venue',
      motivo: MODI_VIVI.includes(modo)
        ? `MAKER_MODE='${modo}' e' uno stadio VIVO: la cintura e' APERTA`
        : `MAKER_MODE='${modo || '(assente)'}' non e' uno stadio vivo (${MODI_VIVI.join('|')}): cintura INSERITA` },
    { nome: 'MAKER_ADAPTER_DRYRUN', valore: str(env, 'MAKER_ADAPTER_DRYRUN') ?? null, inserita: dry,
      cosaGoverna: 'ombra forzata, indipendente dal modo',
      motivo: dry ? 'MAKER_ADAPTER_DRYRUN=true: ombra forzata qualunque sia il modo'
        : 'MAKER_ADAPTER_DRYRUN non e\' `true`: la cintura NON e\' inserita' },
    { nome: 'MAKER_PLACEMENT', valore: str(env, 'MAKER_PLACEMENT') ?? null, inserita: mp !== 'send',
      cosaGoverna: 'la POST /order dell\'adapter',
      motivo: mp === 'send' ? 'MAKER_PLACEMENT=send: la POST /order parte davvero'
        : 'qualunque valore diverso da `send` esatto ⇒ dry-run: costruisce, firma, fa validare, non invia' },
    { nome: 'MANUAL_ORDER_PLACEMENT', valore: str(env, 'MANUAL_ORDER_PLACEMENT') ?? null, inserita: op !== 'send',
      // ⚠ E' LA CINTURA CHE CONTA DAVVERO su questo bot: la corsia manuale e' la strada da cui il bot
      // piazza (`source: manual-ui`), e NON legge `MAKER_PLACEMENT` — «Deliberately NOT MAKER_PLACEMENT».
      cosaGoverna: 'la CORSIA MANUALE, cioe\' la strada da cui il bot piazza davvero',
      motivo: op === 'send' ? 'MANUAL_ORDER_PLACEMENT=send: un ordine della corsia manuale RAGGIUNGE il venue'
        : 'diverso da `send` ⇒ dry-run: i postOrder escono `dry-run-validated`' },
    { nome: 'REALLOC_SCHEDULER_DRY_RUN', valore: freno.valore, inserita: freno.attivo,
      cosaGoverna: 'il freno di prova di agent41',
      motivo: freno.motivo },
  ];

  const inserite = cinture.filter((c) => c.inserita).length;
  return {
    cinture, inserite, aperte: cinture.length - inserite,
    // La congiunzione, e non un «probabilmente»: piazzare richiede tutte e cinque aperte.
    puoPiazzare: inserite === 0,
    attestazioneFinanziamento: {
      valore: str(env, 'MAKER_FUNDING_APPROVED') ?? null,
      // Anche qui l'esatto: `config.envBool` fa `v === 'true'`.
      attestata: str(env, 'MAKER_FUNDING_APPROVED') === 'true',
    },
    perno: String(str(env, 'MAKER_LIVE_MIN_MARKET') || '').trim().toLowerCase() || null,
  };
}

module.exports = { statoCinture, manualPlacement, makerPlacement, modoVivo, dryRunInserita, MODI_VIVI };
