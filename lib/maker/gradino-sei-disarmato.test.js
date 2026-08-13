#!/usr/bin/env node
'use strict';
// IL GRADINO 6 È DISARMATO, E SI VEDE — decisione dell'operatore del 13 agosto 2026.
//
// ═══ PERCHÉ QUESTO FILE ══════════════════════════════════════════════════════════════════════════════
// `gradino-sei-cablato.test.js` prova che il gradino ESISTE (il filo che mancava, §5-bis p.153). Questo
// prova la cosa opposta e complementare: che l'operatore può SPEGNERLO senza toccare il codice, e che
// spento **registra invece di tacere**. Le due proprietà vivono in due file perché sono due decisioni
// diverse — una è un difetto corretto, l'altra è una scelta reversibile.
//
// ═══ COSA SI DIFENDE ═════════════════════════════════════════════════════════════════════════════════
//   §1 · il verso del difetto: SOLO `'0'` disarma. Assente, vuoto o illeggibile ⇒ ARMATO — un env che
//        sparisce non può spegnere una difesa (la stessa regola di `end-of-scale` e dell'orizzonte).
//   §2 · il disarmo è DICHIARATO nella configurazione, non è un effetto collaterale di un'assenza.
//   §3 · disarmato, il gradino NON tocca l'interruttore e dice che SAREBBE scattato. È l'assertzione
//        che fallisce sul codice di ieri, dove il ramo non esisteva e `impostaBot` veniva chiamato.
//   §4 · armato, il comportamento è ancora quello di prima — il disarmo non ha rotto la difesa.
//   §5 · le difese vere non passano da questa scala: guardiano, sentinella e KILL restano fuori.
//
// ═══ LA CINTURA SULLO STATO VERO ═════════════════════════════════════════════════════════════════════
// §3 e §4 eseguono il ramo che mette il bot su FERMA, contro una spia installata nel modulo prima che
// agent41 lo destrutturi. `data/maker-bot-enabled.json` viene fotografato prima e riletto dopo, e il
// test FALLISCE se è cambiato di un byte: «non dovrebbe» non è una prova (§5 punto 1).

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const AGENT41 = path.join(ROOT, 'agents', 'agent41-realloc-scheduler.js');
const SBLOCCO = require('./sblocco-progressivo');
const BOT_ENABLED = require('./bot-enabled');
const FILE_VERO = BOT_ENABLED.FILE;
const primaBytes = fs.existsSync(FILE_VERO) ? fs.readFileSync(FILE_VERO) : null;
const primaMtime = fs.existsSync(FILE_VERO) ? fs.statSync(FILE_VERO).mtimeMs : null;

// ⚠ IL TEST NON DEVE CROLLARE SU UN CODICE CHE NON HA ANCORA LA FUNZIONE. Se `gradinoSeiArmato`
// mancasse, un `TypeError` fermerebbe il file a §1 e le sezioni §3-§4 — quelle che difendono il
// COMPORTAMENTO — non girerebbero mai. Un test che crolla dice «il simbolo non c'è»; quello che serve
// dice «il bot è stato fermato quando non doveva». Si sostituisce con una funzione che risponde
// «armato» a tutto, cioè il comportamento vecchio: così §3 misura davvero la differenza.
const ARMATO_SEMPRE = () => ({ armato: true, motivo: 'funzione assente: comportamento di prima' });
const gradinoSeiArmato = typeof SBLOCCO.gradinoSeiArmato === 'function' ? SBLOCCO.gradinoSeiArmato : ARMATO_SEMPRE;

console.log('\n══ 1 · IL VERSO DEL DIFETTO — solo «0» disarma, tutto il resto arma');
{
  const E = SBLOCCO.ENV_GRADINO6;
  ok('la manopola esiste', typeof SBLOCCO.gradinoSeiArmato === 'function');
  ok('il nome della manopola è uno solo', E === 'SBLOCCO_GRADINO6_ARMATO', String(E));
  ok('«0» disarma', gradinoSeiArmato({ [E]: '0' }).armato === false);
  ok('  e lo dice con un motivo leggibile',
    /disarmato/i.test(gradinoSeiArmato({ [E]: '0' }).motivo));
  // ⚠ IL RAMO CHE CONTA. Se un giorno il demone pm2 ripartisse da una shell pulita, la variabile
  // sparirebbe: la difesa deve tornare ARMATA da sola, non restare spenta in silenzio.
  ok('ASSENTE ⇒ armato (il difetto sicuro)', gradinoSeiArmato({}).armato === true);
  ok('  vuoto ⇒ armato', gradinoSeiArmato({ [E]: '' }).armato === true);
  ok('  spazi ⇒ armato', gradinoSeiArmato({ [E]: '   ' }).armato === true);
  ok('  illeggibile ⇒ armato', gradinoSeiArmato({ [E]: 'boh' }).armato === true);
  ok('  «1» ⇒ armato', gradinoSeiArmato({ [E]: '1' }).armato === true);
  ok('  «false» NON disarma: solo «0» lo fa, e il motivo lo dichiara',
    gradinoSeiArmato({ [E]: 'false' }).armato === true);
  ok('  env nullo ⇒ armato', gradinoSeiArmato(null).armato === true);
  // `'0'` con spazi intorno è la stessa richiesta: un ecosystem riscritto a mano non deve cambiare
  // il verso per uno spazio.
  ok('  « 0 » disarma come «0»', gradinoSeiArmato({ [E]: ' 0 ' }).armato === false);
  ok('  ma «00» no: si confronta il valore, non la sua truthiness',
    gradinoSeiArmato({ [E]: '00' }).armato === true);
}

console.log('\n══ 2 · IL DISARMO È DICHIARATO — nella configurazione, non in un\'assenza');
{
  // Si legge l'OGGETTO esportato, non il testo del file: è la stessa fonte che pm2 legge, e un test
  // che cercasse la stringa nel sorgente sarebbe soddisfatto anche da un commento (§5.3).
  const cfg = require(path.join(ROOT, 'agents', 'ecosystem.config.js'));
  const a41 = (cfg.apps || []).find((a) => a.name === 'agent41-realloc-scheduler');
  ok('agent41 esiste nell\'ecosystem', !!a41);
  ok('  e dichiara il disarmo ESPLICITAMENTE',
    !!a41 && a41.env && a41.env[SBLOCCO.ENV_GRADINO6] === '0', a41 && a41.env ? String(a41.env[SBLOCCO.ENV_GRADINO6]) : 'assente');
  ok('  e quel valore, letto dalla funzione vera, disarma davvero',
    !!a41 && gradinoSeiArmato(a41.env).armato === false);
  // Il gradino NON è stato tolto dalla scala: disarmare è una configurazione, non un'amputazione.
  const g6 = (SBLOCCO.SCALA || []).find((g) => g.livello === 6);
  ok('il gradino 6 è ancora nella scala', !!g6 && g6.azione === 'fermati-in-sicurezza');
  ok('  e la scala ha ancora sei gradini', (SBLOCCO.SCALA || []).length === 6);
}

const chiudi = () => {
  console.log(`\n${pass} verdi, ${fail} rossi`);
  process.exit(fail === 0 ? 0 : 1);
};

console.log('\n══ 3 · DISARMATO — non tocca l\'interruttore, e DICE che sarebbe scattato');
{
  const chiamate = [];
  const vera = BOT_ENABLED.impostaBot;
  BOT_ENABLED.impostaBot = (arg) => { chiamate.push(arg); return { ok: true }; };

  process.env[SBLOCCO.ENV_GRADINO6] = '0';
  let A41 = null, err = null;
  try { A41 = require(AGENT41); } catch (e) { err = e; }
  ok('agent41 si carica senza eseguire il ciclo', !!A41 && !err, err ? err.message : '');

  (async () => {
    if (A41) {
      let r = null, e2 = null;
      try { r = await A41.eseguiGradino('fermati-in-sicurezza'); } catch (e) { e2 = e; }
      ok('il gradino 6 non solleva', !e2, e2 ? e2.message : '');
      // ⚠ LE DUE ASSERZIONI CHE FALLISCONO SUL CODICE DI IERI: là il ramo non esisteva e la spia
      // veniva chiamata comunque.
      ok('L\'INTERRUTTORE NON È STATO CHIAMATO', chiamate.length === 0, 'chiamate=' + chiamate.length);
      ok('  e l\'esito si dichiara DISARMATO', !!(r && r.disarmato === true), r ? JSON.stringify(r.disarmato) : 'nessun esito');
      // Il dato per cui il disarmo esiste: domani si conta quante volte sarebbe intervenuto.
      ok('  dicendo che SAREBBE scattato', !!(r && /sarebbe scattato/i.test(String(r.dettaglio || ''))), r ? String(r.dettaglio || '').slice(0, 60) : '');
      ok('  e perché non lo ha fatto', !!(r && /disarmato/i.test(String(r.dettaglio || ''))));
      // Non è un guasto: `ok:false` lo farebbe contare fra i gradini falliti e il conteggio di domani
      // mescolerebbe «spento» con «rotto».
      ok('  e NON si dichiara fallito', !!(r && r.ok === true), r ? String(r.ok) : '');
      ok('  dichiarando che le difese vere restano attive',
        !!(r && /guardiano|KILL/i.test(String(r.dettaglio || ''))));
    }

    console.log('\n══ 4 · ARMATO — il comportamento di prima è intatto');
    {
      delete process.env[SBLOCCO.ENV_GRADINO6];
      chiamate.length = 0;
      if (A41) {
        let r = null;
        try { r = await A41.eseguiGradino('fermati-in-sicurezza'); } catch { /* riportato sotto */ }
        ok('senza configurazione l\'interruttore VIENE chiamato', chiamate.length === 1, 'chiamate=' + chiamate.length);
        ok('  chiedendo lo spegnimento', !!(chiamate[0] && chiamate[0].enabled === false));
        ok('  e l\'esito NON è disarmato', !!(r && r.disarmato !== true));
      }
    }

    BOT_ENABLED.impostaBot = vera;

    console.log('\n══ 5 · LE DIFESE VERE NON PASSANO DA QUESTA SCALA');
    {
      // La scala di sblocco non nomina il guardiano, la sentinella del collasso né il kill switch: se
      // un giorno lo facesse, disarmare il gradino 6 spegnerebbe qualcosa che l'operatore non ha
      // chiesto di spegnere. È la proprietà, non il conteggio delle righe.
      const src = fs.readFileSync(path.join(__dirname, 'sblocco-progressivo.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      ok('la scala non tocca il kill switch', !/kill-switch|killStatus/.test(src));
      ok('  né il guardiano delle perdite', !/guardian-perdite|guardian-state/.test(src));
      ok('  né la sentinella del collasso', !/sentinella-collasso/.test(src));
    }

    // ── LA CINTURA ─────────────────────────────────────────────────────────────────────────────────
    const dopoBytes = fs.existsSync(FILE_VERO) ? fs.readFileSync(FILE_VERO) : null;
    const dopoMtime = fs.existsSync(FILE_VERO) ? fs.statSync(FILE_VERO).mtimeMs : null;
    ok('\nL\'INTERRUTTORE VERO NON È STATO TOCCATO — contenuto',
      (primaBytes === null && dopoBytes === null) || (!!primaBytes && !!dopoBytes && primaBytes.equals(dopoBytes)));
    ok('  né la data di modifica', primaMtime === dopoMtime, `${primaMtime} → ${dopoMtime}`);
    chiudi();
  })();
}
