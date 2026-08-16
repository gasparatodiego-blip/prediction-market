'use strict';
// lib/maker/lock-mercato.js — UN SOLO RIPREZZO PER VOLTA SU UNO STESSO MERCATO.
//
// ═══ IL DIFETTO, MISURATO SUL VENUE ══════════════════════════════════════════════════════════════════
// 16 agosto 2026, mercato `0x776841ce…`. Due `manual-replace` a **11:34:56 e 11:34:59** — tre secondi —
// **entrambi con lo stesso `orderId` da sostituire** (`0x7dd17698…`), entrambi `sent`. Risultato: due
// ordini vivi identici sullo STESSO token, stesso lato, stesso prezzo, stessa size, e nessuna gamba
// sorella. $44,54 di esposizione non voluta, e il nozionale a riposo del mercato a **$89,08** contro un
// tetto per mercato di $61,25.
//
// ⚠ E L'ANTI-CHURN C'ERA GIA', ED ERA GIA' ANCORATO AL MERCATO. `auto-reprice.js` lo dice da sempre:
// «THE RATE LIMIT IS PER MARKET, NOT PER ORDER ID», e `minIntervalMs` vale 30 s. Non ha protetto per un
// motivo che non c'entra con la chiave: `readAutoRepriceState` legge lo stato all'INIZIO del ciclo e
// `recordAutoRepriceState` lo scrive alla FINE. Due cicli che si sovrappongono leggono entrambi lo
// stato di prima, e per entrambi «l'ultimo riprezzo» e' vecchio di minuti. E' una corsa fra lettura e
// scrittura, non un errore di chiave — riancorare la chiave non l'avrebbe chiusa.
//
// ⚠ PERCHE' E' DIVENTATO PROBABILE ADESSO: `MAKER_AUTO_REPRICE_POLL_MS` e' passato a **1000 ms** e il
// feed di agent34 e' agganciato in PUSH, quindi la valutazione parte a ogni tick del book invece che
// ogni 5 s. La finestra fra lettura e scrittura non e' cambiata; e' aumentato di venti volte il numero
// di volte che qualcuno ci passa dentro.
//
// ═══ COSA FA, E COSA NON FA ══════════════════════════════════════════════════════════════════════════
// Un lock IN PROCESSO per `conditionId`, preso PRIMA della cancellazione e rilasciato DOPO che il nuovo
// ordine e' stato registrato. Chiude la sequenza cancel+place, non la singola chiamata: e' l'intervallo
// in cui lo stato su disco non descrive ancora la realta'.
//
// NON e' un lock fra processi. Vive nella memoria di chi lo importa, e va bene perche' il riprezzo di
// un mercato ha UN SOLO motore (`agent40`), per costruzione: un mercato sotto tracking non e' toccato
// dal watcher reattivo, e il file lo dice gia'. Un lock su file darebbe la stessa garanzia al prezzo di
// un altro stato durevole da riconciliare, e non risolverebbe niente di piu'.
//
// ═══ LA SCADENZA, CHE E' LA META' CHE CONTA ══════════════════════════════════════════════════════════
// Se un `replace` muore a meta' — eccezione, timeout di rete, processo che rallenta — un lock senza
// scadenza terrebbe quel mercato fermo PER SEMPRE, e un mercato che non si riprezza piu' perde gli
// ordini per GTD in 23 minuti senza che nessuno dica perche'. Quindi il lock **scade da solo** dopo
// `TTL_MS`, e chi lo trova scaduto lo prende dichiarando che lo stato di quel mercato e' INCOERENTE:
// non «e' libero», ma «il precedente non ha chiuso, e non so a che punto era arrivato».
//
// ⚠ INCOERENTE NON VUOL DIRE «VIA LIBERA». Chi riceve `incoerente: true` deve trattarlo come una
// ragione per RILEGGERE gli ordini vivi dal venue prima di agire, non per agire piu' in fretta: fra un
// cancel riuscito e un place mai partito c'e' un ordine in meno, e fra un cancel fallito e un place
// riuscito ce n'e' uno in piu'. Sono i due casi che hanno prodotto il duplicato.
//
// TTL = 20 s: piu' lungo del piazzamento piu' lento osservato (i due `postOrder` del 16/08 hanno preso
// 5,1 s e 2,6 s) e piu' corto del `minIntervalMs` di 30 s, cosi' un lock scaduto non puo' mai
// sopravvivere all'intervallo che lo renderebbe superfluo.

const TTL_MS = 20_000;

const _presi = new Map();   // conditionId → { at, da, scadeA }

const norm = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Prova a prendere il lock del mercato.
 *
 * @returns {{preso:boolean, incoerente:boolean, motivo:string|null, tenutoDaMs:number|null}}
 *   `preso:false`  ⇒ un'altra sequenza e' in corso su questo mercato: NON si tocca niente.
 *   `preso:true, incoerente:true` ⇒ il lock precedente e' scaduto senza essere rilasciato: si procede,
 *   ma lo stato del mercato non e' quello che il chiamante crede e va riletto dal venue.
 */
function prendi(conditionId, { da = 'ignoto', ora = Date.now(), ttlMs = TTL_MS } = {}) {
  const id = norm(conditionId);
  if (!id) return { preso: false, incoerente: false, motivo: 'conditionId non leggibile: nessun lock, nessuna azione', tenutoDaMs: null };
  const p = _presi.get(id);
  if (p) {
    const eta = ora - p.at;
    if (ora < p.scadeA) {
      return { preso: false, incoerente: false, tenutoDaMs: eta,
        motivo: `riprezzo gia' in corso su questo mercato da ${Math.round(eta / 1000)}s (preso da ${p.da})` };
    }
    // Scaduto: si prende, ma si DICHIARA che il precedente non ha chiuso.
    _presi.set(id, { at: ora, da, scadeA: ora + (fin(ttlMs) ? ttlMs : TTL_MS) });
    return { preso: true, incoerente: true, tenutoDaMs: eta,
      motivo: `il lock precedente (${p.da}) e' SCADUTO dopo ${Math.round(eta / 1000)}s senza essere rilasciato:`
        + ' la sequenza cancel+place non e\' arrivata in fondo e lo stato di questo mercato non e\' affidabile'
        + ' — rileggere gli ordini vivi dal venue prima di agire' };
  }
  _presi.set(id, { at: ora, da, scadeA: ora + (fin(ttlMs) ? ttlMs : TTL_MS) });
  return { preso: true, incoerente: false, motivo: null, tenutoDaMs: null };
}

/** Rilascia il lock. Idempotente: rilasciare un lock che non si ha non e' un errore, e' un no-op —
 *  il chiamante puo' metterlo in un `finally` senza sapere se era arrivato a prenderlo. */
function rilascia(conditionId) {
  const id = norm(conditionId);
  if (!id) return false;
  return _presi.delete(id);
}

/** Solo per diagnosi e test: chi e' tenuto adesso. Non decide niente. */
function stato(ora = Date.now()) {
  const out = [];
  for (const [id, p] of _presi) out.push({ id, da: p.da, tenutoDaMs: ora - p.at, scaduto: ora >= p.scadeA });
  return out;
}

function azzera() { _presi.clear(); }

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c) => { if (c) { p += 1; console.log(`  ✓ ${n}`); } else { f += 1; console.log(`  ✗ ${n}`); } };
  console.log('\n════ lock-mercato ════');
  azzera();
  const T = 1_000_000;
  ok('il primo lo prende', prendi('0xAA', { da: 'ciclo1', ora: T }).preso === true);
  const secondo = prendi('0xAA', { da: 'ciclo2', ora: T + 3_000 });
  ok('  il secondo a 3s NON lo prende — e\' il caso reale del 16/08', secondo.preso === false && secondo.incoerente === false);
  ok('  e dice da quanto e\' tenuto', secondo.tenutoDaMs === 3_000);
  ok('un altro mercato non e\' bloccato', prendi('0xBB', { da: 'ciclo2', ora: T + 3_000 }).preso === true);
  ok('rilasciato, si puo\' riprendere', rilascia('0xAA') === true && prendi('0xAA', { da: 'ciclo3', ora: T + 4_000 }).preso === true);
  ok('  rilasciare due volte non e\' un errore', rilascia('0xAA') === true && rilascia('0xAA') === false);

  azzera();
  prendi('0xCC', { da: 'morto', ora: T });
  const dopo = prendi('0xCC', { da: 'ciclo-nuovo', ora: T + TTL_MS + 1 });
  ok('un lock SCADUTO si prende…', dopo.preso === true);
  ok('  …ma dichiarando lo stato INCOERENTE', dopo.incoerente === true && /SCADUTO/.test(dopo.motivo));
  ok('  e il lock non resta appeso per sempre', stato(T + TTL_MS + 2).length === 1);
  ok('appena sotto la scadenza NON si prende',
    (azzera(), prendi('0xDD', { da: 'x', ora: T }), prendi('0xDD', { da: 'y', ora: T + TTL_MS - 1 }).preso === false));

  ok('conditionId illeggibile ⇒ nessun lock e nessuna azione',
    prendi(null, { ora: T }).preso === false && prendi('', { ora: T }).preso === false);
  ok('TTL < minIntervalMs (30s), o un lock scaduto sopravvivrebbe all\'intervallo che lo rende superfluo',
    TTL_MS < 30_000);

  console.log(`\nlock-mercato: ${p} passati, ${f} falliti`);
  return f === 0;
}

module.exports = { prendi, rilascia, stato, azzera, TTL_MS, selfcheck };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);
