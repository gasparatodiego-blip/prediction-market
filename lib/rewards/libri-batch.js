'use strict';
// lib/rewards/libri-batch.js — I LIBRI IN BLOCCO, E LA DIFFERENZA FRA «VUOTO» E «ASSENTE».
//
// ═══ PERCHE' ESISTE ══════════════════════════════════════════════════════════════════════════════
// `agent24` chiedeva un libro alla volta (`GET /book?token_id=`), due per mercato. Su una coda
// serializzata a `MAX_RPS = 1.5` sono **1,33 s per mercato di solo freno**, cioe' due delle sei
// chiamate che compongono i 2,74-3,80 s/mercato cronometrati. `POST /books` e' pubblico, senza
// credenziali, e prende una lista: **200 libri in 154 ms, 576 KB** (misurato il 21 agosto 2026).
//
// ⚠ NON E' IL COLLO PRINCIPALE, E VA DETTO QUI: il collo e' `MAX_RPS`, non la rete. Il batch toglie
// due chiamate su sei e basta — porta il tetto sostenibile del board da ~150 a ~300, non a 1.556.
// Chi cerca 1.556 deve guardare `MAX_RPS` e le altre quattro chiamate per mercato
// (`prices-history` ×2, `tick-size`, `markets/<cid>`), non questo file.
//
// ═══ LA REGOLA CHE CONTA PIU' DELLA VELOCITA': ASSENTE NON E' VUOTO ══════════════════════════════
// Un libro VUOTO e' una misura: nessuno quota quel token, la concorrenza e' zero, e zero e' il numero
// giusto. Un libro ASSENTE — il venue non ha risposto, il token non era nel lotto, la risposta era
// malformata — non e' una misura di niente. Trattarli allo stesso modo e' `Number(null) === 0` nella
// forma piu' costosa che questo repo conosca: la concorrenza a zero produce la **quota stimata
// massima**, quindi un mercato di cui NON abbiamo letto il libro si presenta come **il migliore del
// board**. Piu' si allarga la vista, piu' libri mancano, e piu' l'errore pesca in cima alla classifica.
//
// Qui si restituiscono due insiemi distinti — `libri` (letti davvero) e `mancanti` (non letti) — e il
// chiamante e' obbligato a distinguerli perche' non c'e' un valore di ripiego da confondere.

const https = require('https');

const DIM_LOTTO = 200;      // misurato: 200 libri in 154 ms. Oltre non e' stato provato, quindi non si usa.
const TENTATIVI = 2;        // un lotto che fallisce si ritenta UNA volta, poi i suoi token restano mancanti.

/** Il trasporto vero. Sostituibile nei test: qui dentro non c'e' nessuna decisione. */
function postBooksHttp(tokens, { timeoutMs = 20_000 } = {}) {
  const body = JSON.stringify(tokens.map((t) => ({ token_id: String(t) })));
  return new Promise((res, rej) => {
    const req = https.request({
      host: 'clob.polymarket.com', path: '/books', method: 'POST', timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (r) => {
      const chunks = [];
      r.on('data', (d) => chunks.push(d));
      r.on('end', () => {
        if (r.statusCode !== 200) return rej(new Error(`HTTP ${r.statusCode}`));
        try { res(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { rej(new Error(`JSON non valido: ${e.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`timeout dopo ${timeoutMs}ms`)); });
    req.on('error', rej);
    req.end(body);
  });
}

/**
 * Scarica i libri di una lista di token.
 *
 * @returns `{libri: Map<string,{bids,asks}>, mancanti: Set<string>, lotti: {…}}`
 *          `libri` contiene SOLO i token per cui il venue ha risposto con un libro riconoscibile.
 *          `mancanti` contiene tutti gli altri, per QUALUNQUE causa, e non e' mai implicito.
 */
async function scaricaLibri(tokenIds, { dimLotto = DIM_LOTTO, tentativi = TENTATIVI, post = postBooksHttp, log = null } = {}) {
  const voluti = [...new Set((tokenIds || []).map((t) => String(t)).filter(Boolean))];
  const libri = new Map();
  const lotti = { totali: 0, riusciti: 0, falliti: 0, ritentati: 0, errori: [] };

  for (let i = 0; i < voluti.length; i += dimLotto) {
    const lotto = voluti.slice(i, i + dimLotto);
    lotti.totali += 1;
    let ok = false;
    for (let t = 0; t < Math.max(1, tentativi) && !ok; t += 1) {
      if (t > 0) lotti.ritentati += 1;
      try {
        const r = await post(lotto);
        // ⚠ UNA RISPOSTA CHE NON E' UNA LISTA NON E' UNA RISPOSTA VUOTA: e' un lotto fallito. Con
        // `Array.isArray` falso si cadrebbe nel `for` senza iterazioni, cioe' in «zero libri» — che a
        // valle e' indistinguibile da «nessuno quota». Si dichiara fallito e si ritenta.
        if (!Array.isArray(r)) throw new Error('la risposta non e\' una lista');
        for (const b of r) {
          const id = b && (b.asset_id || b.token_id);
          if (!id) continue;
          // bids/asks assenti ⇒ liste vuote: QUI e' corretto, perche' il venue HA risposto per questo
          // token. E' la differenza fra «ha risposto e non c'e' nessuno» e «non ha risposto».
          libri.set(String(id), { bids: Array.isArray(b.bids) ? b.bids : [], asks: Array.isArray(b.asks) ? b.asks : [] });
        }
        ok = true;
        lotti.riusciti += 1;
      } catch (e) {
        if (t + 1 >= Math.max(1, tentativi)) {
          lotti.falliti += 1;
          lotti.errori.push({ da: i, quanti: lotto.length, errore: (e && e.message) || String(e) });
          if (log) log(`  ⚠ lotto libri ${i}-${i + lotto.length - 1} FALLITO dopo ${tentativi} tentativi: ${(e && e.message) || e}`
            + ' — quei token restano MANCANTI, e i loro mercati vengono esclusi invece che valutati a zero');
        }
      }
    }
  }

  // ⚠ Un token chiesto e non tornato e' mancante anche se il lotto e' «riuscito»: il venue puo'
  // rispondere 200 e omettere un asset. La verita' e' la mappa, non l'esito del lotto.
  const mancanti = new Set(voluti.filter((t) => !libri.has(t)));
  return { libri, mancanti, lotti, voluti: voluti.length };
}

module.exports = { scaricaLibri, postBooksHttp, DIM_LOTTO, TENTATIVI };
