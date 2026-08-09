'use strict';
// lib/maker/merge-onchain-collegato.test.js — LA COPPIA COMPLETA SI FONDE, NON SI VENDE.
//
// ═══ COSA CAMBIA ════════════════════════════════════════════════════════════════════════════════════
// `lib/maker/ctf-relayer.js` esisteva dal 7 agosto 2026 — split/merge/redeem via relayer gasless,
// provato on-chain (split $2 tx 0x96072ab7…, merge $2 tx 0x792b31e5…, saldo tornato alla cifra esatta) —
// ma NESSUN modulo di produzione lo importava. Restava un'attrezzatura senza chiamante.
//
// Il punto in cui serve e' preciso: `decidiLivello` risponde `azione:'merge'` quando
// `mancaAllaCoppia <= 0` (strategia-merge.js:218), cioe' quando YES e NO sono in parti uguali e non
// c'e' un secondo lato da comprare. Fino a oggi quel caso cadeva nel vuoto — `liv.prezzo` e' `null` e
// `manca` e' 0, quindi entrambi i tentativi di `completaCoppia` venivano scartati — e si ripiegava
// sulla VENDITA.
//
// ═══ PERCHE' NON C'E' UN CONFRONTO DI CONVENIENZA ═══════════════════════════════════════════════════
// Il merge rende esattamente $1 per coppia, subito, senza slippage e senza gas. La vendita rende
// `bid × size` su UN lato solo, lascia l'altro in portafoglio (quindi non chiude la posizione: la
// rende direzionale) e attraversa lo spread. Non esiste condizione di mercato in cui il secondo termine
// batta il primo, quindi una regola di preferenza potrebbe soltanto sbagliare. Coppia completa ⇒ merge;
// la vendita resta il ripiego per quando il merge non e' disponibile.
//
// ═══ COSA SI VERIFICA ═══════════════════════════════════════════════════════════════════════════════
//   1 · coppia completa ⇒ mergePosition chiamata con i parametri giusti (id, size, negRisk)
//   2 · neg-risk E non-neg-risk, entrambi, e negRisk non leggibile che NON si indovina
//   3 · il merge fallisce ⇒ ripiego pulito, nessuna azione duplicata
//   4 · il flag spento (lo stato di oggi) ⇒ ripiego pulito, e nessuna transazione
//   5 · l'isolamento del relayer non e' stato allargato

const fs = require('fs');
const path = require('path');
const AC = require('./auto-close');
const SM = require('./strategia-merge');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

const ID = '0xcf92c77731a57d1fae661041114345536498c149514871c40920bc9566447bc2';
const regole = (negRisk) => ({ tick: 0.01, minSize: 20, maxSpreadCents: 4.5, negRisk,
  books: { yes: { scoringMid: 0.49 }, no: { scoringMid: 0.51 } } });

console.log('── 1 · IL SEGNALE «COPPIA COMPLETA» ESISTE GIÀ, E ORA HA UN CONSUMATORE');
{
  // Il verdetto viene da `decidiLivello`, non da un secondo criterio inventato qui.
  const liv = SM.decidiLivello({ book: 'no', sizePosseduta: 21.18, prezzoCarico: 0.59, sizeAltroLato: 21.18 });
  ok('YES e NO in parti uguali ⇒ azione «merge»', liv.azione === 'merge', `livello ${liv.livello} · ${String(liv.motivo).slice(0, 55)}`);
  ok('  e mancaAllaCoppia è zero', liv.numeri.mancaAllaCoppia <= 0, String(liv.numeri.mancaAllaCoppia));
  const parziale = SM.decidiLivello({ book: 'no', sizePosseduta: 21.18, prezzoCarico: 0.59, sizeAltroLato: 5 });
  ok('coppia PARZIALE non è «merge»: c\'è ancora un lato da comprare', parziale.azione !== 'merge', parziale.azione);
}

console.log('\n── 2 · LA FUSIONE CHIAMA IL RELAYER CON I PARAMETRI GIUSTI');
{
  for (const negRisk of [true, false]) {
    const chiamate = [];
    const r = AC.fondiCoppia({
      marketId: ID, rules: regole(negRisk), size: 21.18,
      deps: { mergeOnChain: async (a) => { chiamate.push(a); return { eseguito: true, transactionID: 'tx-1', transactionHash: '0xabc', stato: 'CONFERMATA' }; } },
    });
    // eslint-disable-next-line no-loop-func
    r.then((res) => {
      ok(`negRisk=${negRisk}: fusione riuscita`, res.ok === true, res.motivo || '');
      ok('  chiamata UNA volta sola', chiamate.length === 1, String(chiamate.length));
      ok('  con il conditionId del mercato', chiamate[0] && chiamate[0].marketId === ID);
      ok('  con la size della coppia', chiamate[0] && chiamate[0].size === 21.18);
      ok(`  e con negRisk=${negRisk} COPIATO, non dedotto`, chiamate[0] && chiamate[0].negRisk === negRisk);
      ok('  l\'hash della transazione torna al chiamante', res.transactionHash === '0xabc');
    });
  }

  // negRisk decide QUALE adapter riceve la chiamata: con quello sbagliato la transazione reverte senza
  // dire perché. Non si indovina — stessa regola con cui resolveMarketRules rifiuta un mercato senza.
  for (const brutto of [null, undefined, 'true', 1, 0]) {
    const chiamate = [];
    AC.fondiCoppia({ marketId: ID, rules: { ...regole(true), negRisk: brutto }, size: 21.18,
      deps: { mergeOnChain: async (a) => { chiamate.push(a); return { eseguito: true }; } } })
      .then((res) => {
        ok(`negRisk=${JSON.stringify(brutto)} ⇒ NON si tenta`, res.ok === false && chiamate.length === 0, res.motivo);
      });
  }
  for (const size of [0, -1, NaN, null, 'venti']) {
    const chiamate = [];
    AC.fondiCoppia({ marketId: ID, rules: regole(true), size,
      deps: { mergeOnChain: async (a) => { chiamate.push(a); return { eseguito: true }; } } })
      .then((res) => {
        ok(`size=${JSON.stringify(size)} ⇒ NON si tenta`, res.ok === false && chiamate.length === 0);
      });
  }
}

console.log('\n── 3 · SE IL MERGE FALLISCE, RIPIEGO PULITO E NESSUNA AZIONE DOPPIA');
{
  // Tre modi di fallire, e tutti e tre devono valere «non è successo niente».
  const casi = [
    ['il relayer SOLLEVA', async () => { throw new Error('relayer irraggiungibile'); }],
    ['il relayer risponde eseguito:false', async () => ({ eseguito: false, motivo: 'CTF_RELAYER_ENABLED è false: nessuna firma prodotta, niente inviato' })],
    ['il relayer risponde vuoto', async () => null],
  ];
  for (const [nome, fn] of casi) {
    AC.fondiCoppia({ marketId: ID, rules: regole(true), size: 21.18, deps: { mergeOnChain: fn } })
      .then((res) => {
        ok(`${nome} ⇒ ok:false col motivo`, res.ok === false && !!res.motivo, String(res.motivo).slice(0, 60));
        ok('  e nessun hash inventato', res.transactionHash === null);
        ok('  e nessuna size dichiarata fusa', res.size === null);
      });
  }

  // L'audit dice SEMPRE cosa è successo, anche quando non è successo niente: un merge che non parte e
  // non lascia traccia è indistinguibile da un merge mai tentato.
  const righe = [];
  AC.fondiCoppia({ marketId: ID, rules: regole(true), size: 21.18,
    deps: { mergeOnChain: async () => ({ eseguito: false, motivo: 'flag spento' }) },
    audit: (r) => righe.push(r) })
    .then(() => {
      ok('un merge non eseguito lascia una riga d\'audit', righe.length === 1, righe[0] && righe[0].outcome);
      ok('  con un outcome distinto da quello riuscito', righe[0] && righe[0].outcome === 'merge-onchain-non-eseguito');
    });
  const ok2 = [];
  AC.fondiCoppia({ marketId: ID, rules: regole(true), size: 21.18,
    deps: { mergeOnChain: async () => ({ eseguito: true, transactionID: 'tx', transactionHash: '0xdef' }) },
    audit: (r) => ok2.push(r) })
    .then(() => {
      ok('un merge riuscito registra coppia, importo, esito e hash',
        ok2.length === 1 && ok2[0].outcome === 'merge-onchain-eseguito'
        && ok2[0].observed.size === 21.18 && ok2[0].observed.transactionHash === '0xdef'
        && typeof ok2[0].observed.negRisk === 'boolean');
    });
}

console.log('\n── 4 · L\'INTERRUTTORE, E COSA FA QUANDO È SPENTO');
{
  const R = require('./ctf-relayer');
  // Acceso il 9 agosto 2026 su istruzione esplicita dell'operatore. Il test non pretende più un valore
  // fisso — pretende che il valore e l'intestazione che lo racconta dicano la stessa cosa, perché in
  // questo repo un commento invecchiato ha già prodotto guasti (CLAUDE.md §5 punti 2 e 4).
  const srcRel = fs.readFileSync(path.join(__dirname, 'ctf-relayer.js'), 'utf8');
  ok('CTF_RELAYER_ENABLED è un booleano dichiarato', typeof R.CTF_RELAYER_ENABLED === 'boolean');
  ok('  ed è ACCESO', R.CTF_RELAYER_ENABLED === true);
  ok('  e l\'intestazione lo dice, con la data e chi lo chiama',
    /ACCESO dal 9 agosto 2026/.test(srcRel) && /fondiCoppia/.test(srcRel));

  // IL RAMO SPENTO RESTA PROVATO, e va provato proprio ora che il difetto non è più lo stato di
  // default: si passa `abilitato:false` esplicito. Con il flag spento `esegui` non firma e non invia.
  // Credenziali finte per arrivare al ramo dell'interruttore senza toccare la rete.
  const env = { MAKER_FUNDER_ADDRESS: '0x4C81F19a436e8174f1f3b07d7c0169150Fbdbdee',
    POLYMARKET_RELAYER_API_KEY: 'finta', POLYMARKET_RELAYER_API_KEY_ADDRESS: '0x7bd09f34622296fa6ba5a28f6d4e888d418285d3' };
  let rete = 0;
  R.mergePosition(ID, 21.18, { negRisk: true, deps: { abilitato: false, env, http: () => { rete += 1; throw new Error('la rete non deve essere toccata'); } } })
    .then((res) => {
      ok('col flag spento mergePosition NON esegue', res.eseguito === false, String(res.motivo).slice(0, 55));
      ok('  e non tocca la rete', rete === 0);
      ok('  ma il PIANO è costruito, quindi il wiring è verificabile', !!res.piano && !!res.piano.adapter);
      ok('  con l\'adapter neg-risk giusto', String(res.piano.adapter).toLowerCase() === R.ADAPTER_NEG_RISK.toLowerCase());
    })
    .catch((e) => ok('col flag spento mergePosition non solleva', false, e.message));
  R.mergePosition(ID, 21.18, { negRisk: false, deps: { abilitato: false, env, http: () => { throw new Error('mai'); } } })
    .then((res) => {
      ok('e su un mercato NON neg-risk sceglie l\'altro adapter',
        String(res.piano.adapter).toLowerCase() === R.ADAPTER_STANDARD.toLowerCase());
    });
}

console.log('\n── 5 · L\'ISOLAMENTO DEL RELAYER NON È STATO ALLARGATO');
{
  const src = fs.readFileSync(path.join(__dirname, 'ctf-relayer.js'), 'utf8');
  const req = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  // `../venues/polymarket-clob-maker/audit` NON è l'adapter: è il redattore dell'audit, sola scrittura
  // di log. Quello che non deve comparire è l'adapter stesso e la corsia degli ordini.
  ok('il relayer non importa l\'adapter né la corsia manuale',
    !req.some((r) => /polymarket-clob-maker\/adapter|manual-order|bulk-allocate|plan-to-orders/.test(r)), req.join(' '));
  ok('  e l\'unico modulo del venue che tocca è l\'audit',
    req.filter((r) => /venues\//.test(r)).every((r) => /\/audit$/.test(r)));
  ok('  e i target ammessi restano DUE', require('./ctf-relayer').ADAPTER_STANDARD && require('./ctf-relayer').ADAPTER_NEG_RISK);

  // auto-close è ora un chiamante, e deve esserlo in UN punto solo: un secondo punto sarebbe una
  // seconda politica di quando fondere.
  const ac = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
  const usi = (ac.match(/require\('\.\/ctf-relayer'\)/g) || []).length;
  ok('auto-close IMPORTA il relayer in un punto solo', usi === 1, `${usi} require`);
  ok('  e lo fa dentro fondiCoppia, dietro una dep iniettabile', /deps\.mergeOnChain/.test(ac));
  ok('auto-close non chiama split né redeem', !/splitPosition|redeemPosition/.test(ac));

  // Il flag resta l'unico interruttore, e non ne è stato aggiunto un secondo (che vorrebbe dire che
  // spegnerne uno non spegne l'operazione).
  // Un secondo interruttore vorrebbe dire che spegnerne uno non spegne l'operazione: la costante nel
  // sorgente del relayer resta l'unico. auto-close non deve poterlo scavalcare né leggere da .env.
  ok('nessuna env accende il merge on-chain', !/process\.env\.CTF/.test(ac));
  ok('  e auto-close non forza `abilitato` nel relayer', !/abilitato\s*:/.test(ac));
}

setTimeout(() => {
  console.log(`\n${falliti === 0 ? 'TUTTI VERDI' : 'ROSSI'}: ${passati} passati, ${falliti} falliti`);
  process.exit(falliti === 0 ? 0 : 1);
}, 600);
