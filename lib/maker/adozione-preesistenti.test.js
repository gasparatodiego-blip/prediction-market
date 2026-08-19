'use strict';
// lib/maker/adozione-preesistenti.test.js
//
// DUE PROPRIETA', nate dalla stessa serata.
//
// ① L'ADOZIONE. La regola dei pre-esistenti serve a non toccare gli ordini di una sessione precedente,
//    e va tenuta — ma non distingueva «sessione precedente» da «me stesso, riavviato trenta secondi
//    fa». Col piazzamento armato questo significava che ogni deploy condannava il libro alla morte per
//    GTD: misurato il 18 agosto, riavvio alle 22:44:45 e sei ordini scaduti alle 22:50 senza rinnovo.
//    Si adotta SOLO cio' che soddisfa tutte e tre: origine `auto` provata, mercato nel piano, token
//    corrispondente. Il dubbio lascia l'ordine dov'e'.
//
// ② IL FALSO POSITIVO DI `sparizione-non-nostra`. Un invio registrato col token VUOTO — perche' le
//    spec portano `book` e la traduzione puo' fallire — era inattribuibile quanto uno mancante, e
//    l'allarme di FURTO scattava su una nostra vendita per attraversamento. Misurato alle 00:20:44.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('./ordini-preesistenti');
const S = require('./sparizione-non-nostra');

let passati = 0;
const ok = (c, n, x) => { assert.ok(c, n + (x ? ` — ${x}` : '')); passati += 1; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adozione-'));
const FILE = path.join(TMP, 'preesistenti.json');
const reset = () => { try { fs.unlinkSync(FILE); } catch { /* non c'era */ } };

const MKT = '0xaaa';
const TOK_YES = '111';
const TOK_NO = '222';
const ord = (id, over = {}) => ({
  orderId: id, marketId: MKT, tokenId: TOK_YES, side: 'BUY', price: 0.5, size: 50, ...over,
});
const listed = (orders) => ({ ok: true, simulated: false, orders });

// ══ ① SENZA PREDICATO, IL COMPORTAMENTO E' QUELLO DI PRIMA ═══════════════════════════════════════
{
  reset();
  const f = P.fotografaPreesistenti({ listed: listed([ord('0x1'), ord('0x2')]), file: FILE, now: 1000 });
  ok(f.marcati === 2, '① senza `adotta` tutti restano pre-esistenti (comportamento di prima)');
  ok((f.adottati || []).length === 0, '①   e nessuno e adottato');
}

// ══ ② LE TRE CONDIZIONI, UNA ALLA VOLTA ═════════════════════════════════════════════════════════
{
  // Il predicato che il chiamante costruisce: origine auto · mercato nel piano · token del mercato.
  const piano = new Set([MKT]);
  const origini = new Map([['0xauto', 'auto'], ['0xman', 'manual'], ['0xchius', 'auto-chiusura']]);
  const adotta = (o) => {
    if ((origini.get(o.orderId) || 'ignota') !== 'auto') return false;
    if (!piano.has(String(o.marketId || '').toLowerCase())) return false;
    return String(o.tokenId) === TOK_YES || String(o.tokenId) === TOK_NO;
  };

  reset();
  const f = P.fotografaPreesistenti({
    file: FILE, now: 1000, adotta,
    listed: listed([
      ord('0xauto'),                                   // tutte e tre ⇒ ADOTTATO
      ord('0xman'),                                    // origine manual ⇒ no
      ord('0xchius'),                                  // origine auto-chiusura ⇒ no
      ord('0xignoto'),                                 // origine ignota ⇒ no
      ord('0xfuoripiano', { marketId: '0xbbb' }),      // mercato fuori piano ⇒ no
      ord('0xaltrotoken', { tokenId: '999' }),         // token estraneo ⇒ no
    ]),
  });
  const adottatiIds = (f.adottati || []).map((x) => x.orderId);
  ok(adottatiIds.length === 1 && adottatiIds[0] === '0xauto',
    '② ⚑ adottato SOLO chi soddisfa tutte e tre', adottatiIds.join(',') || '(nessuno)');
  ok(f.marcati === 5, '②   e gli altri cinque restano invisibili', `marcati ${f.marcati}`);

  // ⚑ La prova che conta: l'adottato NON e' nel deposito, quindi il motore lo vede.
  const ids = P.idsPreesistenti({ file: FILE });
  ok(!ids.has('0xauto'), '② ⚑ l adottato NON e fra i pre-esistenti: il motore lo riprezza e lo rinnova');
  for (const id of ['0xman', '0xchius', '0xignoto', '0xfuoripiano', '0xaltrotoken']) {
    ok(ids.has(id), `②   «${id}» resta invisibile`);
  }
}

// ══ ③ FAIL-CLOSED: un predicato che esplode non adotta ══════════════════════════════════════════
{
  reset();
  const f = P.fotografaPreesistenti({
    listed: listed([ord('0x1')]), file: FILE, now: 1000,
    adotta: () => { throw new Error('registro illeggibile'); },
  });
  ok(f.marcati === 1 && (f.adottati || []).length === 0,
    '③ ⚑ predicato che solleva ⇒ NESSUNA adozione: il dubbio lascia l ordine dov e');

  // E un predicato che risponde qualcosa che non e' `true` non adotta.
  for (const v of [1, 'si', {}, null, undefined]) {
    reset();
    const r = P.fotografaPreesistenti({ listed: listed([ord('0x1')]), file: FILE, now: 1000, adotta: () => v });
    ok(r.marcati === 1, `③ risposta ${JSON.stringify(v)} non e \`true\` ⇒ non si adotta`);
  }
}

// ══ ④ IL FALSO POSITIVO DI SPARIZIONE: token vuoto, mercato che combacia ════════════════════════
{
  const ORA = 1_000_000;
  const pos = (tok, size, mkt) => ({ tokenId: tok, size, marketId: mkt, avgPrice: 0.72 });

  // ⚑ IL CASO ROTTO: la nostra vendita per attraversamento, registrata col token VUOTO perche' la
  //   traduzione da `book` non e' riuscita. Prima produceva un allarme di FURTO.
  const conMercato = S.sparizioniNonSpiegate({
    prima: [pos(TOK_NO, 56.5, MKT)], dopo: [], ora: ORA,
    nostriInvii: [{ ts: ORA - 57_000, tokenId: '', marketId: MKT, side: 'SELL', size: 56.5 }],
  });
  ok(conMercato.allarmi.length === 0,
    '④ ⚑ invio col token vuoto ma MERCATO che combacia ⇒ NESSUN allarme');
  ok(conMercato.spiegate.length === 1, '④   ed e dichiarato come spiegato');

  // ⚑ IL CASO GIUSTO CHE NON DEVE CAMBIARE: un invio su un ALTRO mercato non spiega niente.
  const altroMercato = S.sparizioniNonSpiegate({
    prima: [pos(TOK_NO, 56.5, MKT)], dopo: [], ora: ORA,
    nostriInvii: [{ ts: ORA - 57_000, tokenId: '', marketId: '0xaltro', side: 'SELL', size: 56.5 }],
  });
  ok(altroMercato.allarmi.length === 1,
    '④ ⚑ invio col token vuoto su un ALTRO mercato ⇒ l allarme resta: non e un allentamento');

  // E nessun invio affatto ⇒ allarme, come prima.
  const nessuno = S.sparizioniNonSpiegate({
    prima: [pos(TOK_NO, 56.5, MKT)], dopo: [], ora: ORA, nostriInvii: [],
  });
  ok(nessuno.allarmi.length === 1, '④ nessun invio ⇒ allarme, come prima');

  // Il token che combacia continua a spiegare, e ha la precedenza.
  const conToken = S.sparizioniNonSpiegate({
    prima: [pos(TOK_NO, 56.5, MKT)], dopo: [], ora: ORA,
    nostriInvii: [{ ts: ORA - 5_000, tokenId: TOK_NO, marketId: '0xaltro', side: 'SELL', size: 56.5 }],
  });
  ok(conToken.allarmi.length === 0, '④ il TOKEN che combacia spiega, e ha la precedenza sul mercato');

  // ⚠ Un BUY non spiega una sparizione, nemmeno col mercato giusto.
  const buy = S.sparizioniNonSpiegate({
    prima: [pos(TOK_NO, 56.5, MKT)], dopo: [], ora: ORA,
    nostriInvii: [{ ts: ORA - 5_000, tokenId: '', marketId: MKT, side: 'BUY', size: 56.5 }],
  });
  ok(buy.allarmi.length === 1, '④ ⚑ un BUY non spiega una sparizione, nemmeno sul mercato giusto');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
console.log(`adozione pre-esistenti: ${passati}/${passati} verdi, 0 rossi`);
