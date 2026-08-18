'use strict';
// lib/maker/presidio-gira-a-bot-fermo.test.js — IL PRESIDIO D'USCITA GIRA ANCHE A BOT FERMO.
//
// ═══ IL DIFETTO CHE QUESTO TEST CHIUDE ═══════════════════════════════════════════════════════════════
// Trovato il 18 agosto 2026 collegando R10, e nominato dall'operatore: **«se il kill mette FERMA e
// FERMA spegne l'ultima rete, allora dopo un kill le gambe scoperte restano senza nessuno che le
// guardi.»**
//
// `presidioPosizioniVecchie` — il presidio dei 60 minuti, che §3 chiama «l'ultima rete» — stava dietro
// `if (!TRIGGER_ATTIVO || !botAttivo()) return;` dentro `controlloCapitaleFermo`. Quindi:
//   · il kill a −$100 mette il bot su **FERMA** (`agent43.spazzaEFerma`);
//   · a bot FERMO `controlloCapitaleFermo` usciva prima di arrivare al presidio;
//   · una gamba scoperta oltre l'ora non veniva piu' chiusa da nessuno.
// Lo stato in cui le gambe scoperte sono **piu' probabili** era esattamente quello in cui nessuno le
// guardava piu'. E §2 diceva gia' cosa significa FERMA: «ferma i piazzamenti NUOVI, lascia gestite le
// posizioni aperte» — il presidio CHIUDE, quindi stava dalla parte sbagliata di un cancello la cui
// semantica era gia' scritta.
//
// ═══ COSA SI PROVA, E COME ══════════════════════════════════════════════════════════════════════════
// ⚠ SI PROVA L'ORDINE DEI CANCELLI, NON UN NUMERO DI RIGA. Un test che fotografa la riga 3163 diventa
// rosso al primo commento aggiunto sopra (§5.3). Qui si confrontano gli INDICI di quattro ancore
// dentro il corpo di `controlloCapitaleFermo`, che e' la proprieta' vera: «il presidio sta prima di
// `botAttivo()`, e cio' che apre sta dopo».
//
// ⚠ E SI PROVA LA META' CHE TIENE: tutto quello che AGGIUNGE esposizione deve essere rimasto DIETRO il
// cancello. Senza questa meta', spostare il presidio in cima sarebbe indistinguibile dall'aver tolto
// il cancello — che e' il modo in cui una correzione di sicurezza diventa un buco.

const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { if (c) { pass += 1; console.log(`  ✓ ${n}`); } else { fail += 1; console.log(`  ✗ ${n}${x ? ' — ' + x : ''}`); } };
const sez = (t) => console.log(`\n── ${t} ──`);

const RADICE = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(RADICE, 'agents', 'agent41-realloc-scheduler.js'), 'utf8');

// Il corpo della funzione: da `async function controlloCapitaleFermo` fino alla successiva `async
// function` di primo livello. Cercare le ancore nel file INTERO le troverebbe anche altrove (per
// esempio dentro `giro()`), e il test direbbe di sì per il motivo sbagliato.
const iniz = SRC.indexOf('async function controlloCapitaleFermo');
const dopo = SRC.indexOf('\nasync function ', iniz + 10);
const CORPO = SRC.slice(iniz, dopo > 0 ? dopo : SRC.length);

const dove = (ago) => CORPO.indexOf(ago);

// ══ ① L'ORDINE DEI CANCELLI ════════════════════════════════════════════════════════════════════════
sez('① il presidio d\'uscita sta PRIMA del cancello su AVVIA');
{
  const iChiusura = dove('await eseguiChiusuraDiEmergenza()');
  const iTrigger = dove('if (!TRIGGER_ATTIVO) return;');
  const iKill = dove('killAttivo');
  const iPresidio = dove('await presidioPosizioniVecchie()');
  const iAvvia = dove('if (!botAttivo()) return;');

  ok('il corpo di `controlloCapitaleFermo` è stato isolato', iniz > 0 && CORPO.length > 500);
  for (const [nome, i] of [['chiusura di emergenza', iChiusura], ['TRIGGER_ATTIVO', iTrigger],
    ['kill', iKill], ['presidio', iPresidio], ['cancello AVVIA', iAvvia]]) {
    ok(`  l'ancora «${nome}» esiste nel corpo`, i > 0, String(i));
  }

  // ⚠ LA PROPRIETÀ, in una riga: il presidio sta prima del cancello su AVVIA.
  ok('IL PRESIDIO STA PRIMA DI `botAttivo()`', iPresidio > 0 && iAvvia > 0 && iPresidio < iAvvia,
    `presidio@${iPresidio} · AVVIA@${iAvvia}`);

  // ⚠ E il KILL sta prima del presidio: §2 dice che lo leggono TUTTI i percorsi, auto-close compreso.
  // Il presidio VENDE, quindi non può scavalcarlo.
  ok('  ma il KILL sta PRIMA del presidio (il presidio vende, e il KILL è l\'emergenza assoluta)',
    iKill > 0 && iKill < iPresidio, `kill@${iKill} · presidio@${iPresidio}`);

  // ⚠ E `TRIGGER_ATTIVO` resta in testa: è l'interruttore del PROCESSO, non AVVIA/FERMA.
  ok('  e `TRIGGER_ATTIVO` resta il primo cancello (è del processo, non del bot)',
    iTrigger > 0 && iTrigger < iKill, `trigger@${iTrigger} · kill@${iKill}`);

  // ⚠ La chiusura di emergenza di R10 sta prima di tutto: ha il proprio KILL dentro.
  ok('  e la chiusura di emergenza (R10) sta prima ancora, col suo KILL dentro',
    iChiusura > 0 && iChiusura < iTrigger, `chiusura@${iChiusura}`);
}

// ══ ② LA METÀ CHE TIENE: CIÒ CHE APRE È RIMASTO DIETRO IL CANCELLO ═════════════════════════════════
sez('② tutto ciò che AGGIUNGE esposizione è rimasto dietro `botAttivo()`');
{
  const iAvvia = dove('if (!botAttivo()) return;');
  // Ognuna di queste tre piazza o apre: `riconciliaCopertura` chiama `ripristinaGamba` (che piazza),
  // `selezionaMercati` abilita mercati nuovi, il mini-ciclo alloca capitale.
  for (const [nome, ago] of [
    ['riconciliaCopertura (piazza gambe con `ripristinaGamba`)', 'await riconciliaCopertura()'],
    ['selezionaMercati (apre mercati nuovi)', 'await selezionaMercati()'],
  ]) {
    const i = dove(ago);
    ok(`${nome} sta DOPO il cancello`, i > 0 && i > iAvvia, `@${i} contro AVVIA@${iAvvia}`);
  }
  // ⚠ E il cancello non è sparito: se qualcuno lo togliesse, il bot a FERMA aprirebbe posizioni.
  ok('il cancello su AVVIA esiste ancora, e compare UNA volta sola nel corpo',
    (CORPO.match(/if \(!botAttivo\(\)\) return;/g) || []).length === 1);
  ok('  e `botAttivo` non è stato scollegato dal modulo', /botAttivo/.test(SRC));
}

// ══ ③ CHI CHIUDE E CHI APRE, DALLA PARTE GIUSTA ════════════════════════════════════════════════════
sez('③ il presidio chiude e basta: non apre, non riabilita, non tocca AVVIA');
{
  const P = require('./presidio-posizioni-vecchie');
  const T = 1_000_000;
  // Una gamba scoperta oltre l'ora: il presidio la vuole chiudere.
  const v = P.valuta({ posizioni: [{ asset: 'y', conditionId: '0xff', size: 60, avgPrice: 0.5, curPrice: 0.5 }],
    ancore: { y: T }, ora: T + 90 * 60_000, minSizePerMercato: { '0xff': 20 } });
  ok('una gamba scoperta da 90 minuti finisce in `daChiudere`', v.daChiudere.length === 1);
  {
    const a41 = SRC.slice(SRC.indexOf('async function presidioPosizioniVecchie'));
    const blocco = a41.slice(0, a41.indexOf('\nasync function ', 10));
    // ⚠ QUESTA ASSERZIONE DICEVA «SOLO SELL», ed è caduta il giorno stesso: R6 seconda metà ha dato al
    // presidio un BUY — quello che compra l'altro lato per sbloccare un residuo. Non è stata
    // ammorbidita, è stata riscritta sulla proprietà VERA, che è più forte e non più debole:
    //
    //     il presidio non aggiunge MAI esposizione direzionale.
    //
    // Un SELL riduce. Un BUY dichiarato `chiudePosizione` porta i due lati in parti uguali, cioè
    // esposizione direzionale ZERO — è la stessa aritmetica per cui §4.6 lo esenta dal tetto per
    // ordine («BUY entro `manca`»). Un BUY **senza** quella dichiarazione sarebbe un'apertura, e
    // questo test esiste per non farlo passare.
    ok('  il presidio vende, o compra SOLO per appaiare', /side: 'SELL'/.test(blocco));
    {
      // Ogni `side: 'BUY'` del blocco deve avere `chiudePosizione: true` nello stesso oggetto.
      const buys = blocco.split(/side: 'BUY'/).slice(1);
      ok(`  e ognuno dei ${buys.length} BUY dichiara \`chiudePosizione\` (0 esposizione direzionale)`,
        buys.every((coda) => /^[\s\S]{0,300}chiudePosizione: true/.test(coda)),
        `${buys.filter((c) => !/^[\s\S]{0,300}chiudePosizione: true/.test(c)).length} senza`);
    }
    ok('  e non tocca AVVIA/FERMA', !/impostaBot\(/.test(blocco));
    ok('  e non abilita mercati', !/setAutoReprice\(/.test(blocco));
  }
}

// ══ ④ IL CASO DELL'OPERATORE, PER INTERO ═══════════════════════════════════════════════════════════
sez('④ dopo un kill: il bot è su FERMA, e le gambe scoperte hanno ancora qualcuno che le guarda');
{
  // La catena che l'operatore ha descritto, provata sui sorgenti invece che raccontata:
  //   agent43 (kill) → impostaBot({enabled:false}) → bot FERMO → agent41.controlloCapitaleFermo
  const a43 = fs.readFileSync(path.join(RADICE, 'agents', 'agent43-guardian.js'), 'utf8');
  ok('il kill mette davvero il bot su FERMA', /impostaBot\)\(\{\s*\n?\s*enabled: false/.test(a43) || /enabled: false, by: 'agent43-guardian'/.test(a43));

  const iPresidio = dove('await presidioPosizioniVecchie()');
  const iAvvia = dove('if (!botAttivo()) return;');
  ok('e a bot FERMO il presidio viene comunque raggiunto', iPresidio < iAvvia);

  // ⚠ E la chiusura di emergenza di R10 pure: le due reti sono indipendenti e vanno provate insieme.
  // R10 vende SUBITO le gambe scoperte elencate nella richiesta; il presidio raccoglie quelle che R10
  // non ha potuto vendere (bid illeggibile, invio fallito) e quelle nate DOPO il kill.
  const iChiusura = dove('await eseguiChiusuraDiEmergenza()');
  ok('e anche la chiusura di emergenza (R10) è raggiunta a bot FERMO', iChiusura > 0 && iChiusura < iAvvia);
  ok('  le due reti sono indipendenti: R10 vende subito, il presidio raccoglie il resto dopo 60 min',
    iChiusura !== iPresidio);
}

console.log(`\nil presidio d'uscita gira a bot fermo: ${pass} passati, ${fail} falliti\n`);
process.exit(fail === 0 ? 0 : 1);
