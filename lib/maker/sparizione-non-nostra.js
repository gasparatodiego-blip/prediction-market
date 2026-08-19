'use strict';
// lib/maker/sparizione-non-nostra.js — UNA POSIZIONE CHE SPARISCE SENZA UN NOSTRO ORDINE. PURO.
//
// ═══ IL FATTO ═══════════════════════════════════════════════════════════════════════════════════════
// 16 agosto 2026, 19:27:32 e 19:27:37: due vendite da **57,1 share esatte** — la size precisa delle
// nostre due gambe su FL-02 — a cinque secondi l'una dall'altra. Alle 19:28:18 le posizioni non
// c'erano piu'.
// Nella stessa finestra i nostri processi hanno mandato al venue **848 `listOpenOrders`, 6
// `cancelOrder` e ZERO `postOrder`**: l'unico tentativo d'ordine era `dry-run-validated`, cioe'
// costruito e non inviato — agent40 era stato riavviato alle 19:22:53 e disarmato in silenzio.
// **Qualcuno con la chiave di quel wallet ha chiuso da fuori dal nostro sistema.**
// L'operatore dice di non essere stato lui, e lo si e' scoperto il GIORNO DOPO, ricostruendo il tape.
//
// ═══ COSA FA QUESTO MODULO, E COSA NON PUO' FARE ════════════════════════════════════════════════════
// Confronta due cose che nessuno confrontava: le posizioni che SPARISCONO e gli ordini che ABBIAMO
// MANDATO. Se una posizione se ne va e nessun nostro invio puo' spiegarla, e' un allarme — subito, non
// il giorno dopo.
//
// ⚠ NON PUO' DIRE CHI E' STATO. Il tape del venue e' il feed pubblico `last_trade_price` e non porta
// indirizzi. Questo modulo risponde a «e' stato uno dei nostri ordini?» — e la risposta «no» e' gia'
// tutto cio' che serve per svegliare qualcuno.
//
// ═══ LE TRE SPIEGAZIONI LEGITTIME, che vanno escluse PRIMA di gridare ════════════════════════════════
//   ① un nostro SELL inviato di recente sullo stesso token, per una size compatibile;
//   ② un MERGE riuscito: la coppia si fonde e le DUE gambe spariscono insieme, senza nessun SELL;
//   ③ una RISOLUZIONE o un riscatto: il mercato e' chiuso, le posizioni si redimono.
// Un allarme che non le esclude urlerebbe a ogni chiusura normale, e in due giorni verrebbe ignorato —
// che e' il modo in cui un presidio muore.
//
// ⚠ LA FINESTRA E' GENEROSA DI PROPOSITO (difetto 10 minuti): fra l'invio di un SELL e la sparizione
// della posizione passano il match, la conferma e il giro di snapshot. Sbagliare stretti produce falsi
// allarmi; sbagliare larghi ne produce di mancati. Fra i due si sceglie il primo errore, perche' un
// falso allarme costa una lettura e un allarme mancato costa una posizione.
//
// ⚠ ZERO `require`: stessa disciplina di `copertura-gambe`, `presa-di-profitto`, `carico-di-ripiego`.

const FINESTRA_MS = 10 * 60_000;
const TOLLERANZA_SIZE = 0.02;   // share: le size arrivano con arrotondamenti diversi da fonti diverse

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const norm = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');

/** La fotografia delle posizioni, indicizzata per token. */
function indicizza(posizioni) {
  const m = new Map();
  for (const p of (Array.isArray(posizioni) ? posizioni : [])) {
    const t = norm(p && (p.tokenId ?? p.asset));
    const s = Number(p && p.size);
    if (!t || !fin(s) || Math.abs(s) <= 0) continue;
    m.set(t, { tokenId: t, size: s, marketId: norm(p.marketId ?? p.conditionId), avgPrice: Number(p.avgPrice) });
  }
  return m;
}

/**
 * LE SPARIZIONI NON SPIEGATE.
 *
 * @param a.prima        posizioni al campione precedente
 * @param a.dopo         posizioni adesso
 * @param a.nostriInvii  [{ts, tokenId, side, size}] — gli ordini che ABBIAMO mandato al venue
 * @param a.mercatiChiusi  [conditionId] — mercati risolti/non piu' accettanti: la ③
 * @param a.mergeRiusciti  [conditionId] — merge andati a buon fine in finestra: la ②
 * @param a.ora
 * @param a.finestraMs
 * @returns {{allarmi:[], spiegate:[], motivo:string}}
 */
function sparizioniNonSpiegate(a = {}) {
  const ora = fin(a.ora) ? a.ora : null;
  const finestra = fin(a.finestraMs) && a.finestraMs > 0 ? a.finestraMs : FINESTRA_MS;

  // ⚠ FAIL-CLOSED VERSO IL SILENZIO. Senza una delle due fotografie non si puo' dire che qualcosa sia
  // sparito: `Array.isArray(null)` falso ⇒ mappa vuota ⇒ TUTTE le posizioni sembrerebbero sparite, e
  // il primo giro dopo un riavvio genererebbe un allarme per ognuna. E' la stessa regola di
  // `sorveglianza-valutazione`: un allarme su un dato che non si e' letto insegna a ignorare gli allarmi.
  if (!Array.isArray(a.prima) || !Array.isArray(a.dopo)) {
    return { allarmi: [], spiegate: [],
      motivo: 'una delle due fotografie delle posizioni non e\' leggibile: non si giudica (una lettura mancante non e\' una sparizione)' };
  }
  if (ora == null) return { allarmi: [], spiegate: [], motivo: 'istante non leggibile: non si giudica' };

  const prima = indicizza(a.prima);
  const dopo = indicizza(a.dopo);
  const chiusi = new Set((Array.isArray(a.mercatiChiusi) ? a.mercatiChiusi : []).map(norm).filter(Boolean));
  const fusi = new Set((Array.isArray(a.mergeRiusciti) ? a.mergeRiusciti : []).map(norm).filter(Boolean));
  const invii = (Array.isArray(a.nostriInvii) ? a.nostriInvii : []).filter((o) => o && fin(Number(o.ts)));

  const allarmi = []; const spiegate = [];
  for (const [tok, p] of prima) {
    const ora2 = dopo.get(tok);
    const sizeDopo = ora2 ? ora2.size : 0;
    const uscita = p.size - sizeDopo;
    // Solo le RIDUZIONI: una posizione che cresce non e' una sparizione.
    if (!(uscita > TOLLERANZA_SIZE)) continue;

    // ③ mercato chiuso o risolto ⇒ la posizione se ne va da sola.
    if (p.marketId && chiusi.has(p.marketId)) {
      spiegate.push({ tokenId: tok, uscita, spiegazione: 'mercato chiuso o risolto' });
      continue;
    }
    // ② merge riuscito ⇒ le due gambe spariscono insieme, e senza nessun SELL.
    if (p.marketId && fusi.has(p.marketId)) {
      spiegate.push({ tokenId: tok, uscita, spiegazione: 'merge on-chain riuscito su questo mercato' });
      continue;
    }
    // ① un nostro SELL recente e abbastanza grande.
    // ⚠ SI SOMMA su tutti gli invii in finestra, non si cerca il singolo che combacia: una posizione
    // puo' uscire in due tranche, e pretendere una corrispondenza uno-a-uno produrrebbe un allarme su
    // una chiusura perfettamente nostra.
    // ⚠ IL TOKEN PUO' MANCARE, E UN INVIO SENZA TOKEN NON E' UN INVIO ALTRUI — 19 agosto 2026.
    // Le spec di piazzamento portano `book`, non `tokenId`: chi registra l'invio prova a tradurre
    // leggendo le regole del mercato, e quando non ci riesce registra col token VUOTO — di proposito,
    // perche' un invio non registrato produrrebbe un allarme falso. Ma un token vuoto non combacia con
    // niente, quindi l'allarme falso arrivava lo stesso: misurato il 19 agosto alle 00:20:44, dove una
    // nostra vendita per ATTRAVERSAMENTO di 57 secondi prima ha prodotto «0.00 share su 0 ordini —
    // qualcuno con la chiave di questo wallet ha venduto da fuori dal nostro sistema».
    // Quindi un invio si accetta se combacia il TOKEN **oppure**, quando il token non c'e', il MERCATO.
    // ⚠ NON E' UN ALLENTAMENTO: un invio su un altro mercato continua a non spiegare niente, e la
    // corrispondenza per mercato vale solo dove il token e' assente — cioe' solo dove il confronto
    // stretto non e' possibile per un difetto nostro, non per un dubbio sull'ordine.
    const combacia = (o) => {
      const t = norm(o.tokenId);
      if (t) return t === tok;
      const m = norm(o.marketId);
      return !!m && !!p.marketId && m === p.marketId;
    };
    let venduto = 0; const usati = [];
    for (const o of invii) {
      if (!combacia(o)) continue;
      if (String(o.side || '').toUpperCase() !== 'SELL') continue;
      if (ora - Number(o.ts) > finestra) continue;
      // ⚠ Un invio nel FUTURO non spiega niente: `ora - ts` negativo passerebbe il confronto sopra.
      if (Number(o.ts) > ora + 1000) continue;
      const s = Number(o.size);
      if (!fin(s) || s <= 0) continue;
      venduto += s; usati.push(o);
    }
    if (venduto + TOLLERANZA_SIZE >= uscita) {
      spiegate.push({ tokenId: tok, uscita, venduto, ordini: usati.length, spiegazione: 'coperta da nostri SELL in finestra' });
      continue;
    }

    allarmi.push({
      tokenId: tok, marketId: p.marketId || null,
      sizePrima: p.size, sizeDopo, uscita: +uscita.toFixed(6),
      spiegatoDaNostriInvii: +venduto.toFixed(6),
      nonSpiegato: +(uscita - venduto).toFixed(6),
      carico: fin(p.avgPrice) ? p.avgPrice : null,
      valoreAlCaricoUsd: fin(p.avgPrice) ? +((uscita - venduto) * p.avgPrice).toFixed(4) : null,
      motivo: `${(uscita - venduto).toFixed(2)} share uscite da questa posizione senza nessun nostro ordine che le spieghi`
        + ` (nostri SELL in finestra: ${venduto.toFixed(2)} share su ${usati.length} ordini; mercato non chiuso, nessun merge riuscito).`
        + ' Qualcuno con la chiave di questo wallet ha venduto da fuori dal nostro sistema.',
    });
  }

  return { allarmi, spiegate,
    motivo: allarmi.length
      ? `${allarmi.length} sparizione/i NON spiegata/e da nostri ordini`
      : `nessuna sparizione non spiegata (${spiegate.length} spiegate)` };
}

// ── SELFCHECK ─────────────────────────────────────────────────────────────────────────────────────
function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c, x) => { c ? (p++, console.log(`  ok  ${n}${x ? ' — ' + x : ''}`)) : (f++, console.log(`  NO  ${n}${x ? ' — ' + x : ''}`)); };
  console.log('\n════ sparizione-non-nostra ════');

  const T = 1_000_000_000;
  const pos = (tok, size, mkt = '0xMKT', avg = 0.54) => ({ tokenId: tok, size, marketId: mkt, avgPrice: avg });
  const sell = (tok, size, ts = T - 60_000) => ({ ts, tokenId: tok, side: 'SELL', size });

  // IL CASO DEL 16 AGOSTO, numero per numero.
  const fl02 = sparizioniNonSpiegate({ prima: [pos('A', 57.1), pos('B', 57.1)], dopo: [],
    nostriInvii: [], ora: T });
  ok('due gambe sparite senza nostri ordini ⇒ DUE allarmi', fl02.allarmi.length === 2, fl02.motivo);
  ok('  e l\'allarme quantifica il non spiegato', fl02.allarmi[0].nonSpiegato === 57.1);
  ok('  e lo valorizza al carico', fl02.allarmi[0].valoreAlCaricoUsd === +(57.1 * 0.54).toFixed(4));

  // ① un nostro SELL spiega tutto.
  ok('① un nostro SELL in finestra spiega la sparizione',
    sparizioniNonSpiegate({ prima: [pos('A', 57.1)], dopo: [], nostriInvii: [sell('A', 57.1)], ora: T }).allarmi.length === 0);
  ok('  anche in due tranche', sparizioniNonSpiegate({ prima: [pos('A', 57.1)], dopo: [],
    nostriInvii: [sell('A', 30), sell('A', 27.1)], ora: T }).allarmi.length === 0);
  ok('  ma un SELL TROPPO PICCOLO lascia l\'allarme sul resto', (() => {
    const r = sparizioniNonSpiegate({ prima: [pos('A', 57.1)], dopo: [], nostriInvii: [sell('A', 20)], ora: T });
    return r.allarmi.length === 1 && Math.abs(r.allarmi[0].nonSpiegato - 37.1) < 1e-6;
  })());
  ok('  un SELL FUORI finestra non spiega niente',
    sparizioniNonSpiegate({ prima: [pos('A', 57.1)], dopo: [], nostriInvii: [sell('A', 57.1, T - 3_600_000)], ora: T }).allarmi.length === 1);
  ok('  un SELL nel FUTURO non spiega niente',
    sparizioniNonSpiegate({ prima: [pos('A', 57.1)], dopo: [], nostriInvii: [sell('A', 57.1, T + 3_600_000)], ora: T }).allarmi.length === 1);
  ok('  un BUY non spiega una sparizione',
    sparizioniNonSpiegate({ prima: [pos('A', 57.1)], dopo: [],
      nostriInvii: [{ ts: T - 60_000, tokenId: 'A', side: 'BUY', size: 57.1 }], ora: T }).allarmi.length === 1);
  ok('  un SELL su un ALTRO token non spiega',
    sparizioniNonSpiegate({ prima: [pos('A', 57.1)], dopo: [], nostriInvii: [sell('Z', 57.1)], ora: T }).allarmi.length === 1);

  // ② e ③
  ok('② un merge riuscito spiega entrambe le gambe',
    sparizioniNonSpiegate({ prima: [pos('A', 57.1), pos('B', 57.1)], dopo: [], nostriInvii: [],
      mergeRiusciti: ['0xMKT'], ora: T }).allarmi.length === 0);
  ok('③ un mercato chiuso spiega la sparizione',
    sparizioniNonSpiegate({ prima: [pos('A', 57.1)], dopo: [], nostriInvii: [],
      mercatiChiusi: ['0xMKT'], ora: T }).allarmi.length === 0);

  // Rumore e casi degeneri
  ok('una posizione che CRESCE non e una sparizione',
    sparizioniNonSpiegate({ prima: [pos('A', 40)], dopo: [pos('A', 57.1)], nostriInvii: [], ora: T }).allarmi.length === 0);
  ok('una riduzione sotto la tolleranza non allarma',
    sparizioniNonSpiegate({ prima: [pos('A', 57.1)], dopo: [pos('A', 57.09)], nostriInvii: [], ora: T }).allarmi.length === 0);
  ok('una riduzione PARZIALE non spiegata allarma', (() => {
    const r = sparizioniNonSpiegate({ prima: [pos('A', 57.1)], dopo: [pos('A', 20)], nostriInvii: [], ora: T });
    return r.allarmi.length === 1 && Math.abs(r.allarmi[0].nonSpiegato - 37.1) < 1e-6;
  })());
  ok('⚠ posizioni PRIMA non leggibili ⇒ nessun allarme (non e una sparizione)',
    sparizioniNonSpiegate({ prima: null, dopo: [], nostriInvii: [], ora: T }).allarmi.length === 0);
  ok('⚠ posizioni DOPO non leggibili ⇒ nessun allarme',
    sparizioniNonSpiegate({ prima: [pos('A', 57.1)], dopo: null, nostriInvii: [], ora: T }).allarmi.length === 0);
  ok('orologio non leggibile ⇒ nessun allarme',
    sparizioniNonSpiegate({ prima: [pos('A', 57.1)], dopo: [], nostriInvii: [], ora: null }).allarmi.length === 0);

  console.log(`\nsparizione-non-nostra selfcheck: ${p} verdi, ${f} rossi`);
  return f === 0;
}

module.exports = { sparizioniNonSpiegate, FINESTRA_MS, TOLLERANZA_SIZE, selfcheck };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);
