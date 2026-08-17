'use strict';
// lib/maker/ultimo-nostro-prezzo.js — IL PREZZO DELL'ULTIMO NOSTRO BUY SU UN LATO, DAL GIORNALE.
//
// ═══ IL BUCO CHE CHIUDE (§5.2 p.41, aperto il 17 agosto 2026, chiuso la sera dello stesso giorno) ═════
// `carico-di-ripiego.caricoDaUsare` ha TRE livelli: ① `avgPrice` del venue, ② il residuo ancora a libro,
// ③ `ultimoNostroPrezzo`. **Il terzo non era raggiungibile**, perche' nessuno passava quella dep:
// `auto-close.js:2105` la legge come `typeof deps.ultimoNostroPrezzo === 'function' ? … : null`, e
// `closeTask` non la cablava. Risultato: con un fill **TOTALE** — l'ordine sparisce dal libro, quindi il
// livello ② non ha dati — l'uscita finiva a `skip-no-entry-price`, cioe' la posizione restava senza
// prezzo di carico e quindi senza uscita, che e' esattamente il caso per cui il ripiego esiste.
//
// ⚠ **SETTIMA OCCORRENZA** della classe «dep non cablata ⇒ valore di difetto che nessuno ha chiesto»
// (§5.3): `readDepth`, `signerProvider`, `{file}` invece di `{auditFile}`, `deps.stato` con `||`,
// `preparaMercatoNuovo` col primo argomento sbagliato, `resolveLimits`/`posizioniPerSelezione` del
// 17 agosto — e questa. La forma e' sempre la stessa: il codice che DECIDE e' scritto e provato, il
// codice che lo COLLEGA no, e i test iniettano la dep che la produzione non passa.
//
// ═══ DA DOVE VIENE IL NUMERO, E PERCHE' DAL GIORNALE E NON DALLA MEMORIA ═════════════════════════════
// Dal giornale maker (`polymarket-maker-audit.jsonl`), che e' l'unico registro DUREVOLE di cio' che
// abbiamo mandato al venue. `agent40` tiene anche una lista in memoria (`nostriInvii`, per il presidio
// sulle sparizioni) ma **non porta il prezzo** e si azzera a ogni riavvio: un carico che sparisce al
// riavvio e' un'uscita che sparisce al riavvio.
//
// SI CONTANO SOLO GLI INVII ACCETTATI (`outcome: 'sent'`). Un `dry-run-validated` non e' mai arrivato al
// libro e non puo' aver prodotto un fill; un `reject-*` nemmeno. Contarli darebbe un carico costruito su
// un ordine che non e' esistito.
//
// ⚠ E SOLO I `BUY`. La chiave e' `(mercato, lato)` e non il token, perche' il giornale scrive `marketRef`
// + `requested.book` — il token lo risolve `placeManualOrder` a valle. `manual-replace` ha ricevuto il
// campo `side` la sera del 17 agosto proprio per questo: senza, un rimpiazzo era indistinguibile fra
// acquisto e vendita, e **un record senza `side` viene SALTATO** invece di essere interpretato.
//
// ⚠ LETTURA INCREMENTALE, e non e' un'ottimizzazione: `readFileSync` su questo file ha gia' fallito
// CHIUSO a 731 MB (§5-bis p.71). Si usa `giornale-incrementale.scansiona`, lo stesso meccanismo di
// `mappaOrigini` e `attribuzione-ordini`: la mappa e' accumulativa fra le chiamate — corretto su un
// giornale append-only — e una rotazione la fa ricostruire da zero.
//
// ⚠ NON SI INVENTA NIENTE: chiave assente ⇒ `null`, e `caricoDaUsare` resta al suo terzo «nessun ripiego»
// (cioe' `skip-no-entry-price`, il comportamento di prima). Questo modulo puo' solo AGGIUNGERE un dato
// che c'era e non veniva letto.

const path = require('path');
const { scansiona } = require('./giornale-incrementale');

const CHIAVE = 'ultimo-nostro-buy';
const OP_VALIDE = new Set(['manual-place', 'manual-replace']);

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const prezzoValido = (p) => fin(p) && p > 0 && p < 1;
const norm = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');

/** `cid_ab12…` → `0xab12…`; un `marketRef` di altra forma non si traduce e non si indovina. */
function daMarketRef(ref) {
  const s = norm(ref);
  if (!s.startsWith('cid_')) return '';
  const hex = s.slice(4);
  return /^[0-9a-f]{6,}$/.test(hex) ? `0x${hex}` : '';
}

function chiaveDi(marketId, book) {
  const m = norm(marketId);
  const b = norm(book) === 'no' ? 'no' : (norm(book) === 'yes' ? 'yes' : '');
  return (m && b) ? `${m}|${b}` : '';
}

function fileGiornale(deps = {}) {
  if (deps.auditFile) return deps.auditFile;
  try { return path.join(require('../safety/store').DATA_DIR, 'polymarket-maker-audit.jsonl'); }
  catch { return null; }
}

/** La mappa `(mercato, lato)` → `{price, ts}` dell'ultimo BUY accettato. Accumulativa. */
function mappaUltimiBuy(deps = {}) {
  const file = fileGiornale(deps);
  if (!file) return new Map();
  return scansiona({
    file, chiave: CHIAVE,
    crea: () => new Map(),
    ingest: (riga, acc) => {
      // Il pre-filtro sulla stringa evita di parsare il 99% delle righe (il giornale e' fatto quasi tutto
      // di `manual-list`): stessa disciplina di `mappaOrigini`.
      if (!riga || riga.indexOf('"sent"') === -1) return;
      let r; try { r = JSON.parse(riga); } catch { return; }
      if (!r || !OP_VALIDE.has(r.op) || r.outcome !== 'sent') return;
      const q = r.requested;
      if (!q || String(q.side || '').toUpperCase() !== 'BUY') return;   // `side` assente ⇒ si SALTA
      const k = chiaveDi(daMarketRef(r.marketRef), q.book);
      if (!k) return;
      const p = Number(q.price);
      if (!prezzoValido(p)) return;
      const ts = fin(Number(r.ts)) ? Number(r.ts) : null;
      const prima = acc.get(k);
      // ⚠ IL PIU' RECENTE VINCE, e «recente» si misura sul `ts` quando c'e'. Un giornale append-only
      // arriva gia' in ordine, ma fidarsi dell'ordine di scrittura per una decisione sul capitale
      // sarebbe fidarsi di una proprieta' che nessuno verifica: se il `ts` c'e' su entrambi si
      // confronta, se manca vince l'ultimo letto.
      if (prima && fin(prima.ts) && fin(ts) && ts < prima.ts) return;
      acc.set(k, { price: p, ts, op: r.op });
    },
  });
}

/**
 * IL PREZZO, per un lato di un mercato. `null` quando il giornale non ne parla.
 * @param a.marketId  conditionId del mercato
 * @param a.book      'yes' | 'no'
 * @param a.deps      {auditFile} per i test
 */
function prezzoUltimoNostroBuy(a = {}) {
  const k = chiaveDi(a.marketId, a.book);
  if (!k) return null;
  let m;
  try { m = mappaUltimiBuy(a.deps || {}); } catch { return null; }
  const v = m.get(k);
  return v && prezzoValido(v.price) ? v.price : null;
}

// ── SELFCHECK ─────────────────────────────────────────────────────────────────────────────────────
function selfcheck() {
  const fs = require('fs');
  const os = require('os');
  let p = 0; let f = 0;
  const ok = (n, c, x) => { c ? (p++, console.log(`  ok  ${n}${x ? ' — ' + x : ''}`)) : (f++, console.log(`  NO  ${n}${x ? ' — ' + x : ''}`)); };
  console.log('\n════ ultimo-nostro-prezzo ════');

  const M = '0xAbCd12';
  const riga = (o) => JSON.stringify(o);
  const tmp = path.join(os.tmpdir(), `unp-${process.pid}-${p}-${Math.floor(process.uptime() * 1000)}.jsonl`);
  const scrivi = (righe) => fs.writeFileSync(tmp, righe.map(riga).join('\n') + '\n');

  ok('cid_ → 0x, e una forma diversa NON si traduce',
    daMarketRef('cid_abcd12') === '0xabcd12' && daMarketRef('0xabcd12') === '' && daMarketRef('cid_zz') === '');

  scrivi([
    { op: 'manual-place', outcome: 'sent', ts: 1000, marketRef: 'cid_abcd12', requested: { book: 'yes', side: 'BUY', price: 0.30 } },
    { op: 'manual-place', outcome: 'sent', ts: 2000, marketRef: 'cid_abcd12', requested: { book: 'yes', side: 'BUY', price: 0.34 } },
    { op: 'manual-place', outcome: 'sent', ts: 1500, marketRef: 'cid_abcd12', requested: { book: 'no', side: 'BUY', price: 0.62 } },
  ]);
  ok('il piu RECENTE vince sul lato YES', prezzoUltimoNostroBuy({ marketId: M, book: 'yes', deps: { auditFile: tmp } }) === 0.34);
  ok('  e i due lati sono separati', prezzoUltimoNostroBuy({ marketId: M, book: 'no', deps: { auditFile: tmp } }) === 0.62);
  ok('  il confronto del mercato e insensibile a maiuscole', prezzoUltimoNostroBuy({ marketId: '0xabcd12', book: 'yes', deps: { auditFile: tmp } }) === 0.34);
  ok('un mercato mai visto ⇒ null', prezzoUltimoNostroBuy({ marketId: '0xffff', book: 'yes', deps: { auditFile: tmp } }) === null);
  ok('book mancante ⇒ null (non si indovina il lato)', prezzoUltimoNostroBuy({ marketId: M, deps: { auditFile: tmp } }) === null);
  ok('file assente ⇒ null, e non solleva', prezzoUltimoNostroBuy({ marketId: M, book: 'yes', deps: { auditFile: `${tmp}.non-esiste` } }) === null);

  // ⚠ CIO' CHE NON DEVE ENTRARE. Un file nuovo per ogni caso, o la mappa accumulativa terrebbe il
  // valore del caso precedente e il test passerebbe per il motivo sbagliato.
  const casi = [
    ['un `dry-run-validated` NON conta (non e mai arrivato al libro)',
      { op: 'manual-place', outcome: 'dry-run-validated', ts: 3000, marketRef: 'cid_abcd12', requested: { book: 'yes', side: 'BUY', price: 0.99 } }],
    ['un `reject-*` NON conta', { op: 'manual-place', outcome: 'reject-stale-book', ts: 3000, marketRef: 'cid_abcd12', requested: { book: 'yes', side: 'BUY', price: 0.99 } }],
    ['una SELL NON conta', { op: 'manual-place', outcome: 'sent', ts: 3000, marketRef: 'cid_abcd12', requested: { book: 'yes', side: 'SELL', price: 0.99 } }],
    ['un record SENZA `side` viene SALTATO, non interpretato',
      { op: 'manual-place', outcome: 'sent', ts: 3000, marketRef: 'cid_abcd12', requested: { book: 'yes', price: 0.99 } }],
    ['un prezzo fuori da (0,1) NON conta', { op: 'manual-place', outcome: 'sent', ts: 3000, marketRef: 'cid_abcd12', requested: { book: 'yes', side: 'BUY', price: 1 } }],
    ['un `op` di un altro percorso NON conta', { op: 'close', outcome: 'sent', ts: 3000, marketRef: 'cid_abcd12', requested: { book: 'yes', side: 'BUY', price: 0.99 } }],
  ];
  let i = 0;
  for (const [nome, r] of casi) {
    i += 1;
    const f2 = `${tmp}.${i}`;
    fs.writeFileSync(f2, `${riga(r)}\n`);
    ok(nome, prezzoUltimoNostroBuy({ marketId: M, book: 'yes', deps: { auditFile: f2 } }) === null);
    try { fs.unlinkSync(f2); } catch { /* ignora */ }
  }

  // Una riga malformata in mezzo non deve far perdere le altre.
  const f3 = `${tmp}.rotta`;
  fs.writeFileSync(f3, `{non json "sent"\n${riga({ op: 'manual-place', outcome: 'sent', ts: 10, marketRef: 'cid_abcd12', requested: { book: 'yes', side: 'BUY', price: 0.41 } })}\n`);
  ok('una riga malformata non fa perdere le buone', prezzoUltimoNostroBuy({ marketId: M, book: 'yes', deps: { auditFile: f3 } }) === 0.41);
  try { fs.unlinkSync(f3); fs.unlinkSync(tmp); } catch { /* ignora */ }

  console.log(`\n  ${p} ok, ${f} NO`);
  return f === 0;
}

module.exports = { prezzoUltimoNostroBuy, mappaUltimiBuy, chiaveDi, daMarketRef, selfcheck };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);
