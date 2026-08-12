'use strict';
// lib/maker/osservabilita-coda.test.js — `inCoda` E `priceAdjusted` ARRIVANO DOVE SERVE.
//
// Erano due variabili locali: calcolate, applicate al prezzo, e poi in parte buttate via. Il giornale
// maker e il valore di ritorno le avevano già; `execution-audit.jsonl` — il registro su cui si
// ricostruisce cosa è successo a un ordine, e l'unico che l'idempotenza legge — no.
//
// Il difetto che questo chiude: dopo il fatto non c'era modo di sapere, da execution-audit, se un ordine
// fosse finito dove è finito per DECISIONE o per caso. E su un RIFIUTO per «mai primo sul libro» non si
// sapeva contro CHI fosse stato misurato il concorrente.

const fs = require('fs');
const path = require('path');
const EA = require('../safety/execution-audit');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

// ⚠ IL REGISTRO VERO NON SI TOCCA: si scrive in un file temporaneo iniettato.
//
// ⚠⚠ E LA PROVA CHE NON SI TOCCHI STA QUI SOTTO, perché scriverlo è già successo: la prima stesura di
// questo file iniettava `{ file: tmp }` mentre `cfg()` legge `auditFile`, quindi la dep veniva ignorata
// in SILENZIO e una riga di test è finita nel registro di produzione (rimossa, con backup). È la stessa
// trappola dei punti 53, 55 e 57 di §5, per una terza strada: una dep col nome sbagliato non è un
// errore, è un valore di difetto che nessuno ha chiesto.
//
// La difesa non è ricordarsi il nome giusto: è misurare il registro vero prima e dopo. Se questo file
// tornerà a scriverci, il test diventerà ROSSO invece di lasciare un residuo che si scopre per caso.
const tmp = path.join(require('os').tmpdir(), `exec-audit-test-${process.pid}.jsonl`);
const deps = { auditFile: tmp, now: () => 1_700_000_000_000 };
try { fs.unlinkSync(tmp); } catch { /* non esisteva */ }
const REGISTRO_VERO = path.join(__dirname, '..', '..', 'data', 'execution-audit.jsonl');
const righePrima = (() => { try { return fs.readFileSync(REGISTRO_VERO, 'utf8').split('\n').length; } catch { return null; } })();

console.log('── 1 · I DUE CAMPI ARRIVANO IN execution-audit, COME CAMPI PROPRI');
{
  const inCoda = { ok: true, mode: 'dietro-al-migliore', onTop: false, bestOther: 0.40, reason: null,
    ownOrders: { conteggio: 2, dalVenue: 2, dalPannello: 0, duplicati: 1, venueLetto: true } };
  const priceAdjusted = { inCoda: { from: 0.42, to: 0.39, mode: 'dietro-al-migliore', onTop: false, bestOther: 0.40 } };

  const r = EA.recordIntent({
    idempotencyKey: 'k-1', userId: 'u', venue: 'polymarket', market: 'tok', side: 'BUY',
    price: 0.39, size: 100, notionalUsd: 39, inCoda, priceAdjusted,
  }, deps);
  ok('la riga di intent è stata scritta', r.recorded === true);

  const righe = fs.readFileSync(tmp, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const intent = righe.find((x) => x.kind === 'intent');
  ok('`inCoda` è un campo di primo livello, non dentro `decision`',
    intent.inCoda != null && intent.decision == null);
  ok('  e porta il concorrente misurato', intent.inCoda.bestOther === 0.40);
  ok('  e la provenienza dei nostri ordini sottratti',
    intent.inCoda.ownOrders.dalVenue === 2 && intent.inCoda.ownOrders.venueLetto === true);
  ok('`priceAdjusted` è un campo di primo livello', intent.priceAdjusted != null);
  ok('  e dice da dove a dove', intent.priceAdjusted.inCoda.from === 0.42 && intent.priceAdjusted.inCoda.to === 0.39);

  // ── LA PROPRIETÀ CHE RENDE UTILE IL CAMPO PROPRIO: si conta con un grep ─────────────────────
  ok('«quante volte la coda ha spostato un prezzo» si risponde contando, non leggendo prosa',
    fs.readFileSync(tmp, 'utf8').split('\n').filter((l) => l.includes('"priceAdjusted":{')).length === 1);
}

console.log('\n── 2 · ASSENTI ⇒ `null`, NON UN OGGETTO VUOTO');
{
  const r = EA.recordIntent({
    idempotencyKey: 'k-2', userId: 'u', venue: 'polymarket', market: 'tok2', side: 'SELL',
    price: 0.61, size: 50, notionalUsd: 30.5,
  }, deps);
  ok('un chiamante che non li calcola scrive comunque la riga', r.recorded === true);
  const righe = fs.readFileSync(tmp, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const intent = righe.find((x) => x.idempotencyKey === 'k-2');
  ok('  e i due campi valgono `null`', intent.inCoda === null && intent.priceAdjusted === null);
  ok('  cioè «non li ho calcolati», non «li ho calcolati e non ho trovato niente»',
    intent.inCoda !== undefined && JSON.stringify(intent.inCoda) !== '{}');
}
try { fs.unlinkSync(tmp); } catch { /* pulizia best-effort */ }

console.log('\n── 3 · IL CABLAGGIO: I DUE CAMPI FANNO TUTTO IL PERCORSO');
{
  const srcMO = fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
  const srcAD = fs.readFileSync(path.join(__dirname, '..', 'venues', 'polymarket-clob-maker', 'adapter.js'), 'utf8');
  const srcEA = fs.readFileSync(path.join(__dirname, '..', 'safety', 'execution-audit.js'), 'utf8');

  ok('la corsia manuale li passa all\'adapter',
    /inCoda: inCodaEsito,\s*\n\s*priceAdjusted,/.test(srcMO));
  ok('l\'adapter li mette nella riga di intent, in ENTRAMBI i punti in cui la scrive',
    (srcAD.match(/inCoda: s\.inCoda \|\| null, priceAdjusted: s\.priceAdjusted \|\| null/g) || []).length === 2);
  ok('il registro li dichiara come campi propri', /^\s*inCoda: intent\.inCoda/m.test(srcEA));
  ok('  con la ragione scritta accanto (non dentro `decision`, che è testo libero)',
    srcEA.includes('CAMPI PROPRI E NON DENTRO `decision`'));

  ok('restano anche nel giornale maker e nel valore di ritorno, come prima',
    (srcMO.match(/inCoda: inCodaEsito,/g) || []).length >= 3);
}

console.log('\n── 4 · IL PANNELLO LI MOSTRA, ANCHE SUL RIFIUTO');
{
  const srcP = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'components', 'OrderPanel.tsx'), 'utf8');
  ok('il riepilogo della coda esiste', srcP.includes('data-op-qs-in-coda-riepilogo'));
  // ⚠ LA PARTE CHE CONTA: la riga NON è condizionata a `result.ok`. È sul rifiuto che serve di più —
  // «mai-primo-sul-libro» è un gate che rifiuta, e senza questa riga il pannello diceva PERCHÉ senza
  // dire contro CHI.
  const blocco = srcP.slice(srcP.indexOf('data-op-qs-in-coda-riepilogo') - 400, srcP.indexOf('data-op-qs-in-coda-riepilogo'));
  ok('  e NON è condizionato al buon esito', /\{result\.inCoda && \(/.test(blocco) && !/result\.ok && result\.inCoda && \(/.test(blocco));
  ok('  mostra il miglior concorrente misurato', srcP.includes('miglior concorrente'));
  ok('  e quanti dei NOSTRI ordini sono stati sottratti, e da dove',
    srcP.includes('nostri sottratti') && srcP.includes('venue non letto'));
  ok('l\'arretramento per profondità ha la sua riga', srcP.includes('data-op-qs-profondita'));
  ok('  con i numeri, non con un aggettivo', srcP.includes('depthAhead') && srcP.includes('ticksBack'));
  ok('e il banner dello spostamento di prezzo resta dov\'era', srcP.includes('Prezzo spostato per non essere primo sul libro'));
}

console.log('\n── 5 · IL REGISTRO DI PRODUZIONE NON È STATO TOCCATO');
{
  const righeDopo = (() => { try { return fs.readFileSync(REGISTRO_VERO, 'utf8').split('\n').length; } catch { return null; } })();
  ok('`data/execution-audit.jsonl` ha lo stesso numero di righe di prima',
    righePrima != null && righeDopo === righePrima, `prima ${righePrima} · dopo ${righeDopo}`);
  ok('  e non contiene le chiavi di questo test',
    !(fs.readFileSync(REGISTRO_VERO, 'utf8').includes('"idempotencyKey":"k-1"')));
}

console.log(`\n${falliti === 0 ? '✅ TUTTI VERDI' : '❌ ROSSI'}: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);
