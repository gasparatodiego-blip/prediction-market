'use strict';
// lib/maker/doppioni.js — SU UN TOKEN E UN LATO ESISTE AL PIU' UN ORDINE VIVO.
//
// ═══ IL DIFETTO CHE CHIUDE, MISURATO DUE VOLTE IN UN'ORA ═════════════════════════════════════════════
// 16 agosto 2026. Due `manual-replace` a 11:34:56 e 11:34:59 sullo stesso `orderId` hanno lasciato due
// ordini identici su `0x776841ce…` (BUY 78,0¢ × 57,1, stesso token). Poco dopo la stessa corsa ne ha
// prodotti altri due su `0xde0b0b24…` (BUY 73,0¢ × 57,1). Ogni singolo ordine era legale: il tetto per
// ordine li vedeva uno per volta, `maxOpenNotionalUsd` conta i fill riconciliati, e il tetto per mercato
// governava solo il piano. **Nessun gate sommava.** Risultato: $89,08 e $94,79 a riposo su mercati con
// tetto $61,25, e un lato del mercato coperto due volte mentre l'altro restava scoperto.
//
// ⚠ LA CAUSA PRIMA E' LA CORSA, ed e' chiusa da `lock-mercato`. Questo modulo e' la SECONDA rete: un
// lock protegge dalla concorrenza che conosce, non da un doppione arrivato per un'altra strada — un
// riavvio a meta' sequenza, un `replace` il cui cancel e' fallito, un ordine piazzato a mano. Una difesa
// che dipende dall'aver previsto tutte le cause non e' una difesa.
//
// ═══ QUALE SI TIENE, E PERCHE' NON E' INDIFFERENTE ═══════════════════════════════════════════════════
// Si tiene il PIU' VECCHIO. Su questo venue i premi maturano sul tempo a libro (`1.440 campioni al
// giorno`, §5-bis p.152): l'ordine piu' anziano ha gia' accumulato presenza che il gemello non ha, e
// cancellare lui per tenere il nuovo butterebbe via l'unica cosa che i due non condividono.
// Senza un istante leggibile si ripiega sull'`orderId` in ordine lessicografico: non e' «meglio», e'
// DETERMINISTICO — due giri sullo stesso libro devono cancellare lo stesso ordine, o il riconciliatore
// diventa esso stesso una sorgente di churn.

const norm = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const num = (x) => { const n = Number(x); return fin(n) ? n : null; };

/** La chiave dell'unicita': un mercato, un token, un lato. Non il prezzo — due ordini sullo stesso lato
 *  a prezzi diversi restano un doppione, e anzi sono il caso peggiore (due prezzi, due esposizioni). */
function chiaveGamba(o) {
  const c = norm(o && (o.marketId || o.conditionId));
  const t = norm(o && (o.tokenId || o.asset_id || o.assetId));
  const s = norm(o && o.side);
  if (!t || !s) return null;          // senza token o lato non si puo' affermare che siano gemelli
  return `${c}|${t}|${s}`;
}

function istante(o) {
  for (const k of ['createdAt', 'created_at', 'placedAt', 'ts', 'at']) {
    const v = num(o && o[k]);
    if (v !== null && v > 0) return v;
  }
  return null;
}

/**
 * I doppioni gia' a libro.
 * @returns {{gruppi:Array, daCancellare:Array<{orderId,chiave,motivo}>, tenuti:string[], illeggibili:number}}
 */
function trovaDoppioni(ordini) {
  const per = new Map();
  let illeggibili = 0;
  for (const o of (ordini || [])) {
    const k = chiaveGamba(o);
    // ⚠ Un ordine di cui non si legge token o lato NON viene contato come gemello di nessuno: non si
    // cancella su un dubbio. Si dichiara, perche' un doppione invisibile e' peggio di uno noto.
    if (!k || !norm(o.orderId)) { illeggibili += 1; continue; }
    if (!per.has(k)) per.set(k, []);
    per.get(k).push(o);
  }
  const gruppi = []; const daCancellare = []; const tenuti = [];
  for (const [k, lista] of per) {
    if (lista.length <= 1) { if (lista.length === 1) tenuti.push(norm(lista[0].orderId)); continue; }
    const ordinati = lista.slice().sort((a, b) => {
      const ta = istante(a), tb = istante(b);
      if (ta !== null && tb !== null && ta !== tb) return ta - tb;     // il piu' vecchio per primo
      if (ta !== null && tb === null) return -1;
      if (ta === null && tb !== null) return 1;
      return norm(a.orderId) < norm(b.orderId) ? -1 : 1;              // deterministico
    });
    const [tenuto, ...altri] = ordinati;
    tenuti.push(norm(tenuto.orderId));
    for (const o of altri) {
      daCancellare.push({ orderId: norm(o.orderId), chiave: k,
        motivo: `doppione: stesso mercato, token e lato di ${norm(tenuto.orderId).slice(0, 12)}…`
          + `${istante(tenuto) !== null ? ' (si tiene il piu\' vecchio: ha gia\' maturato presenza a libro)' : ' (si tiene il primo in ordine di id: deterministico)'}` });
    }
    gruppi.push({ chiave: k, quanti: lista.length, tenuto: norm(tenuto.orderId), cancellati: altri.map((o) => norm(o.orderId)) });
  }
  return { gruppi, daCancellare, tenuti, illeggibili };
}

/**
 * PRIMA DI INVIARE: esiste gia' una gemella su questo token+lato?
 * @returns {{esiste:boolean, identico:boolean, ordine:object|null, motivo:string|null}}
 *   `identico` ⇒ stesso prezzo e stessa size: il nuovo ordine non aggiunge niente e va RIFIUTATO.
 *   `esiste && !identico` ⇒ il chiamante deve cancellare la vecchia PRIMA di piazzare.
 */
function gemellaEsistente(ordini, { conditionId = null, tokenId = null, side = null, price = null, size = null } = {}) {
  const k = chiaveGamba({ marketId: conditionId, tokenId, side });
  if (!k) return { esiste: false, identico: false, ordine: null, motivo: 'token o lato non leggibili: nessun confronto possibile' };
  for (const o of (ordini || [])) {
    if (chiaveGamba(o) !== k) continue;
    const p = num(o.price), s = num(o.sizeRemaining != null ? o.sizeRemaining : o.size);
    const identico = fin(price) && fin(size) && p !== null && s !== null
      && Math.abs(p - price) < 1e-9 && Math.abs(s - size) < 1e-6;
    return { esiste: true, identico, ordine: o,
      motivo: identico
        ? `esiste gia' un ordine IDENTICO su questo token e lato (${norm(o.orderId).slice(0, 12)}…, ${p}×${s}):`
          + ' inviarne un altro creerebbe un doppione senza cambiare niente'
        : `esiste gia' un ordine su questo token e lato (${norm(o.orderId).slice(0, 12)}…, ${p}×${s}):`
          + ' va cancellato PRIMA di piazzarne un altro, o restano entrambi a libro' };
  }
  return { esiste: false, identico: false, ordine: null, motivo: null };
}

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c) => { if (c) { p += 1; console.log(`  ✓ ${n}`); } else { f += 1; console.log(`  ✗ ${n}`); } };
  console.log('\n════ doppioni ════');
  const O = (id, tok, side, price, size, ts) => ({ orderId: id, marketId: '0xAA', tokenId: tok, side, price, size, createdAt: ts });

  const uno = trovaDoppioni([O('0x1', 'tokA', 'BUY', 0.7, 10, 100)]);
  ok('un ordine solo non e\' un doppione', uno.daCancellare.length === 0 && uno.tenuti.length === 1);

  const due = trovaDoppioni([O('0x2', 'tokA', 'BUY', 0.73, 57.1, 200), O('0x1', 'tokA', 'BUY', 0.73, 57.1, 100)]);
  ok('due gemelli ⇒ uno da cancellare — il caso reale del 16/08', due.daCancellare.length === 1);
  ok('  e si tiene il PIU\' VECCHIO', due.tenuti[0] === '0x1' && due.daCancellare[0].orderId === '0x2');

  const coppia = trovaDoppioni([O('0x1', 'tokYES', 'BUY', 0.2, 57, 100), O('0x2', 'tokNO', 'BUY', 0.73, 57, 100)]);
  ok('una COPPIA (token diversi) non e\' un doppione', coppia.daCancellare.length === 0 && coppia.tenuti.length === 2);

  const lati = trovaDoppioni([O('0x1', 'tokA', 'BUY', 0.2, 57, 100), O('0x2', 'tokA', 'SELL', 0.9, 57, 100)]);
  ok('stesso token ma lati opposti non e\' un doppione', lati.daCancellare.length === 0);

  const prezziDiversi = trovaDoppioni([O('0x1', 'tokA', 'BUY', 0.70, 57, 100), O('0x2', 'tokA', 'BUY', 0.75, 57, 200)]);
  ok('stesso token+lato a prezzi DIVERSI e\' comunque un doppione', prezziDiversi.daCancellare.length === 1);

  const senzaTs = trovaDoppioni([{ orderId: '0xbb', marketId: '0xAA', tokenId: 'tokA', side: 'BUY' },
    { orderId: '0xaa', marketId: '0xAA', tokenId: 'tokA', side: 'BUY' }]);
  ok('senza istante si ordina per id, deterministico', senzaTs.tenuti[0] === '0xaa');
  const senzaTs2 = trovaDoppioni([{ orderId: '0xaa', marketId: '0xAA', tokenId: 'tokA', side: 'BUY' },
    { orderId: '0xbb', marketId: '0xAA', tokenId: 'tokA', side: 'BUY' }]);
  ok('  e l\'ordine di ingresso non cambia il risultato', senzaTs2.tenuti[0] === '0xaa');

  const rotto = trovaDoppioni([O('0x1', null, 'BUY', 0.7, 10, 100), O('0x2', 'tokA', 'BUY', 0.7, 10, 100)]);
  ok('un ordine senza token NON si cancella su un dubbio, e si dichiara',
    rotto.daCancellare.length === 0 && rotto.illeggibili === 1);

  const vivi = [O('0x1', 'tokA', 'BUY', 0.73, 57.1, 100)];
  const g1 = gemellaEsistente(vivi, { conditionId: '0xAA', tokenId: 'tokA', side: 'BUY', price: 0.73, size: 57.1 });
  ok('gemella IDENTICA riconosciuta', g1.esiste === true && g1.identico === true);
  const g2 = gemellaEsistente(vivi, { conditionId: '0xAA', tokenId: 'tokA', side: 'BUY', price: 0.72, size: 57.1 });
  ok('gemella a prezzo diverso: esiste ma NON identica', g2.esiste === true && g2.identico === false);
  const g3 = gemellaEsistente(vivi, { conditionId: '0xAA', tokenId: 'tokNO', side: 'BUY', price: 0.2, size: 57.1 });
  ok('l\'altra gamba della coppia non e\' una gemella', g3.esiste === false);
  const g4 = gemellaEsistente(vivi, { conditionId: '0xAA', tokenId: null, side: 'BUY', price: 0.2, size: 1 });
  ok('token non leggibile ⇒ nessun confronto, e lo dice', g4.esiste === false && /non leggibil/.test(g4.motivo));

  console.log(`\ndoppioni: ${p} passati, ${f} falliti`);
  return f === 0;
}

module.exports = { chiaveGamba, trovaDoppioni, gemellaEsistente, selfcheck };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);
