#!/usr/bin/env node
'use strict';
// scripts/simula-capitale-al-lavoro.js — I QUATTRO SCENARI DEL «CAPITALE AL LAVORO», SENZA CAPITALE.
//
// ═══ PERCHE' NON PUO' PIAZZARE, E NON PER BUONA VOLONTA' ════════════════════════════════════════════
// Esegue le funzioni VERE — `miniCiclo` di agent41 e `runAutoCloseCycle` — con le sole dipendenze che
// toccano il venue sostituite da REGISTRATORI che scrivono cosa avrebbero mandato e restituiscono
// `sent:false`. La corsia verso il venue, in questa esecuzione, e' occupata da funzioni senza rete: un
// ordine vero richiederebbe di cancellare quelle righe. E' lo stesso schema di
// scripts/simula-trigger-capitale.js, esteso ai quattro scenari del lavoro dell'8 agosto 2026.
//
// Sostituito anche `registraMercatoAperto`: nella realta' SCRIVE il file dell'interruttore, e una
// simulazione non deve poter toccare uno stato vero nemmeno per contare.
//
// Uso:  node scripts/simula-capitale-al-lavoro.js            (tutti gli scenari, piano finto)
//       node scripts/simula-capitale-al-lavoro.js --ricalcolo-vero   (scenario 1 e 3 col piano VERO)

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const A = require(path.join(ROOT, 'agents/agent41-realloc-scheduler'));
const TRIG = require(path.join(ROOT, 'lib/maker/trigger-capitale-fermo'));
const UTIL = require(path.join(ROOT, 'lib/maker/utilizzo-capitale'));
const { runAutoCloseCycle } = require(path.join(ROOT, 'lib/maker/auto-close'));
const { statoBot } = require(path.join(ROOT, 'lib/maker/bot-enabled'));
const killSwitch = require(path.join(ROOT, 'lib/safety/kill-switch'));

const RICALCOLO_VERO = process.argv.includes('--ricalcolo-vero');
const usd = (v) => (Number.isFinite(v) ? `$${v.toFixed(2)}` : '—');
const si = (b) => (b ? '✓' : '✗');
let falliti = 0;
const check = (cond, testo) => { if (!cond) falliti += 1; console.log(`    ${si(cond)} ${testo}`); };

// ── UN PIANO FINTO MA REALISTICO ────────────────────────────────────────────────────────────────────
// Quattro mercati da $130: con $668 liberi e un tetto al 20% ($134) nessuno da solo puo' assorbire il
// capitale — che e' esattamente la situazione in cui il vecchio mini-ciclo si fermava dopo uno.
function riga(id, nome, valore) {
  return { marketId: id, name: nome, capital: 130, realisticBestPerDay: valore,
    mid: 0.50, tick: 0.01, maxSpreadCents: 4.5, minSizeShares: 20, pairCostUsd: 0.98,
    computedDefaultOffsetTicks: 1, rif: { scoringMid: 0.50, bestBid: 0.49, bestAsk: 0.51 } };
}
const RIGHE = [riga('0xAAA', 'Mercato A', 9), riga('0xBBB', 'Mercato B', 8),
  riga('0xCCC', 'Mercato C', 7), riga('0xDDD', 'Mercato D', 6), riga('0xEEE', 'Mercato E', 5)];

/** Il mini-ciclo vero, con ogni corsia che tocca il mondo esterno sostituita. */
async function giro({ saldo, piano, ordini = [], forzato = false, ricalcolo = null, posizioni = [] }) {
  const mandati = [];
  const aperture = [];
  const d = TRIG.decidiTrigger({
    abilitato: true, botAttivo: true, cicloInCorso: false, killAttivo: false,
    saldo: { readable: true, usd: saldo }, ignoraAttese: forzato,
    motivoForzatura: forzato ? 'AVVIA appena premuto' : null,
  });
  if (!d.scatta) return { d, r: null, mandati, aperture };
  const t0 = Date.now();
  const r = await A.miniCiclo(d, {
    leggiPiano: () => piano,
    listOrders: async () => ({ ok: true, orders: ordini }),
    etaBoardMs: 60_000,
    diag: { readable: true, openNotionalUsd: 0 },
    leggiPosizioni: () => ({ readable: true, ageMs: 0, positions: posizioni }),
    // `aperturaNuoviMercati` NON viene sostituita: e' pura (nessun file, nessuna rete) e dal 9 agosto
    // 2026 e' la regola vera che decide quanti mercati nuovi si aprono. Sostituirla vorrebbe dire
    // simulare tutto TRANNE la cosa che si sta verificando.
    registraMercatoAperto: ({ marketId }) => { aperture.push(marketId); return { ok: true, giaPresente: false }; },
    ...(ricalcolo ? { pianoLeggero: ricalcolo } : {}),
    piazza: async (rows) => {
      mandati.push(...rows);
      return { ok: true, placed: rows.length, refused: 0, skipped: 0,
        results: rows.map((x) => ({ ...x, esito: 'SIMULATO — non inviato' })) };
    },
  });
  return { d, r, mandati, aperture, durataMs: Date.now() - t0 };
}

(async () => {
  const bot = statoBot();
  let kill = { effectivelyKilled: null };
  try { kill = killSwitch.killStatus(); } catch { /* ignoto */ }
  console.log('\n' + '═'.repeat(100));
  console.log('SIMULAZIONE «CAPITALE AL LAVORO» — nessun ordine reale, ogni corsia verso il venue è un registratore');
  console.log('═'.repeat(100));
  console.log(`stato reale: bot ${bot.enabled ? 'AVVIATO' : 'FERMO'} · kill ${kill.effectivelyKilled ? 'ATTIVO' : 'non attivo'}`);
  console.log(`obiettivo di utilizzo ${Math.round(UTIL.TARGET_UTILIZZO * 100)}% · soglia trigger $${TRIG.SOGLIA_USD}`
    + ` · minimo per ordine $${TRIG.MIN_ALLOCAZIONE_USD} · max ${TRIG.MAX_MERCATI_PER_GIRO} mercati per giro`);

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n\n① BOT APPENA AVVIATO, NESSUN PIANO RECENTE — il primo piazzamento entro 2 minuti?');
  console.log('─'.repeat(100));
  {
    // Il caso vero dell'8 agosto: `data/realloc-ultimo-piano.json` non esiste ancora.
    const senzaPiano = { ok: false, righe: [], motivo: 'nessun piano salvato finora: il primo ciclo completo lo scrive' };
    let ricalcoloChiamato = 0; let msRicalcolo = 0;
    const ricalcolo = RICALCOLO_VERO
      ? async (opts) => { const t = Date.now(); ricalcoloChiamato += 1; const p = await A.pianoLeggero(opts); msRicalcolo = Date.now() - t; return p; }
      : async () => { ricalcoloChiamato += 1; msRicalcolo = 13_000; return { rows: RIGHE }; };

    const t0 = Date.now();
    const g = await giro({ saldo: 668.25, piano: senzaPiano, forzato: true, ricalcolo });
    const totMs = Date.now() - t0;
    console.log(`  esito: ${g.r.esito} · fonte: ${g.r.fonte}`);
    console.log(`  ricalcolo leggero: ${ricalcoloChiamato} volta/e${RICALCOLO_VERO ? ` · ${msRicalcolo} ms (piano VERO, finestra ${A.FINESTRA_LEGGERA_ORE}h)` : ' (simulato a 13 s, il valore misurato)'}`);
    console.log(`  mercati toccati: ${(g.r.mercati || []).length} · capitale al lavoro: ${usd(g.r.allocatoUsd)} · ordini mandati: ${g.mandati.length}`);
    console.log(`  utilizzo: ${g.r.utilizzo.pct}% → ${g.r.utilizzoStimatoDopo.pct}% (obiettivo ${g.r.utilizzo.targetPct}%)`);
    const stimaTotale = 15_000 + (RICALCOLO_VERO ? msRicalcolo : 13_000) + 5_000;   // rilevazione + ricalcolo + venue
    check(g.d.scatta === true && g.d.forzato === true, 'un AVVIA forza il trigger saltando cooldown e quiete');
    check(ricalcoloChiamato === 1, 'senza piano salvato il mini-ciclo RICALCOLA invece di rispondere «nessuna azione»');
    check(g.r.esito === 'allocato', 'e arriva a piazzare');
    check(stimaTotale < 120_000, `il conto dei due minuti regge: ~${Math.round(stimaTotale / 1000)}s (rilevazione ≤15s + ricalcolo + venue) contro un limite di 120s`);
    check((g.r.mercati || []).length > 1, 'e non un mercato solo: con un tetto al 20% servivano 5 giri e 50 minuti di cooldown');
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n\n② FILL SU UNA GAMBA SOLA — si forza la seconda, non si cancella la prima');
  console.log('─'.repeat(100));
  {
    const MERCATO = '0x' + 'ab'.repeat(32);
    const TOK_YES = '111'; const TOK_NO = '222';
    async function ciclo({ asks, ordini = [], attese = {}, now = 5_000_000 }) {
      const piazzati = []; const cancellati = [];
      const m = new Map(Object.entries(attese));
      const res = await runAutoCloseCycle({
        now: () => now, marketIds: [MERCATO],
        killStatus: () => ({ effectivelyKilled: false, readable: true }),
        isEnabled: () => ({ enabled: true }), isManual: () => ({ manual: true, readable: true }),
        resolveRules: () => ({ readable: true, tokenId: TOK_YES, tokenIdNo: TOK_NO, tick: 0.01, minSize: 5, maxSpreadCents: 4.5,
          books: { yes: { scoringMid: 0.80, bestBid: 0.79 }, no: { scoringMid: 0.20, bestBid: 0.19 } } }),
        readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
        readPositions: async () => ({ ok: true, positions: [{ tokenId: TOK_YES, size: 32.27, avgPrice: 0.80 }] }),
        listOrders: async () => ({ ok: true, orders: ordini }),
        readDepth: () => ({ readable: true, yes: { asks: null }, no: { asks } }),
        attesaMerge: { leggi: (k) => m.get(k) || null, segna: (k, r) => m.set(k, r), pulisci: (k) => m.delete(k) },
        placeOrder: async (s) => { piazzati.push(s); return { ok: true, sent: false, orderId: 'sim-' + piazzati.length }; },
        cancelOrder: async (s) => { cancellati.push(s); return { ok: true }; },
        audit: () => {},
      });
      return { res, piazzati, cancellati, attese: m };
    }
    const CHIAVE = `${MERCATO}:${TOK_YES}`;

    // (a) gamba YES riempita, nessuna uscita a riposo, ask del NO cara ⇒ Livello 2 maker
    const a = await ciclo({ asks: [{ price: 0.90, size: 100 }] });
    console.log(`  (a) fill su YES, nessuna uscita a riposo → ${a.piazzati.map((p) => `${p.side} ${p.book.toUpperCase()} ${p.size}@${p.price}`).join(' | ') || 'niente'}`);
    check(a.piazzati.length === 1 && a.piazzati[0].side === 'BUY', 'si compra la SECONDA gamba, non si vende la prima');
    check(!a.piazzati.some((p) => p.side === 'SELL'), 'la gamba riempita NON viene messa in uscita per il solo fatto di essere sbilanciata');
    check(a.attese.size === 1, 'e parte l\'orologio del Livello 2 (60 minuti), non un\'attesa senza scadenza');

    // (b) ask conveniente ⇒ Livello 1, taker immediato: il completamento «più aggressivo»
    const b = await ciclo({ asks: [{ price: 0.15, size: 100 }] });
    console.log(`  (b) ask del NO dentro il tetto → ${b.piazzati.map((p) => `${p.side} ${p.book.toUpperCase()} @${p.price}${p.attraversaApposta ? ' (taker)' : ''}`).join(' | ')}`);
    check(b.piazzati[0] && b.piazzati[0].attraversaApposta === true, 'quando conviene si PRENDE l\'ask invece di aspettare (Livello 1)');

    // (c) l'ask scende MENTRE il Livello 2 aspetta ⇒ si passa al Livello 1 senza attendere il timeout
    const c = await ciclo({ asks: [{ price: 0.15, size: 100 }], attese: { [CHIAVE]: { at: 5_000_000 - 10 * 60_000, orderId: 'compl-1' } } });
    console.log(`  (c) attesa in corso e ask che scende → cancellati ${c.cancellati.length}, piazzati ${c.piazzati.length}`);
    check(c.cancellati.some((x) => x.orderId === 'compl-1') && c.piazzati.some((p) => p.attraversaApposta), 'il completamento a riposo lascia il posto al taker: più aggressivo verso il completamento');

    // (d) timeout scaduto ⇒ Livello 3, e solo allora si vende
    const d3 = await ciclo({ asks: [{ price: 0.90, size: 100 }], attese: { [CHIAVE]: { at: 5_000_000 - 61 * 60_000, orderId: 'compl-1' } } });
    console.log(`  (d) 61 minuti di attesa → ${d3.piazzati.map((p) => p.side).join(' | ')}`);
    check(d3.piazzati.some((p) => p.side === 'SELL'), 'a timeout scaduto la gerarchia arriva al Livello 3: il merge non è un rinvio infinito');
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n\n③ TRIGGER A $50 CON UN PIANO VECCHIO/INADEGUATO — ricalcola o resta inerte?');
  console.log('─'.repeat(100));
  {
    // (a) piano FRESCO ma i cui mercati sono tutti già pieni: prima era «nessuna azione».
    const pianoPieno = { ok: true, at: new Date().toISOString(), righe: [riga('0xPIENO', 'Già pieno', 9)] };
    const ordiniPieni = [{ marketId: '0xPIENO', price: 0.50, size: 260, orderId: 'o1' }];
    let ric = 0;
    const ga = await giro({ saldo: 400, piano: pianoPieno, ordini: ordiniPieni, ricalcolo: async () => { ric += 1; return { rows: RIGHE }; } });
    console.log(`  (a) piano fresco ma saturo → esito ${ga.r.esito} · fonte ${ga.r.fonte} · ricalcoli ${ric}`);
    check(ric === 1, 'il piano fresco ma senza spazio fa scattare il RICALCOLO (era il caso che restava inerte)');
    check(ga.r.esito === 'allocato' && ga.mandati.length > 0, 'e il capitale trova dove andare');

    // (b) piano VECCHIO di due ore: si ricalcola senza nemmeno provarlo.
    const pianoVecchio = { ok: true, at: new Date(Date.now() - 2 * 3600_000).toISOString(), righe: RIGHE };
    let ric2 = 0;
    const gb = await giro({ saldo: 400, piano: pianoVecchio, ricalcolo: async () => { ric2 += 1; return { rows: RIGHE }; } });
    console.log(`  (b) piano di 2 ore fa → esito ${gb.r.esito} · fonte ${gb.r.fonte} · ricalcoli ${ric2}`);
    check(ric2 === 1, `un piano più vecchio di ${A.PIANO_FRESCO_MAX_MS / 60000} minuti non si usa: si ricalcola`);

    // (c) piano FRESCO e con spazio: NON si ricalcola. Il caso comune non paga i tredici secondi.
    let ric3 = 0;
    const gc = await giro({ saldo: 400, piano: { ok: true, at: new Date().toISOString(), righe: RIGHE }, ricalcolo: async () => { ric3 += 1; return { rows: RIGHE }; } });
    console.log(`  (c) piano fresco e con spazio → esito ${gc.r.esito} · fonte ${gc.r.fonte} · ricalcoli ${ric3}`);
    check(ric3 === 0, 'il caso comune non paga il ricalcolo: si parte dal piano salvato');

    // (d) e se il ricalcolo non trova NIENTE, si dice che non c'è dove metterlo — non si forza.
    const gd = await giro({ saldo: 400, piano: { ok: false, righe: [], motivo: 'nessun piano' }, ricalcolo: async () => ({ rows: [] }) });
    console.log(`  (d) ricalcolo a vuoto → esito ${gd.r.esito}`);
    check(gd.r.esito === 'nessuna-azione' && gd.mandati.length === 0, 'nessun mercato ammissibile ⇒ il capitale resta liquido, non si forza un ordine');
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n\n④ TARGET 90% CON CAPITALE VERO E MERCATI SUFFICIENTI');
  console.log('─'.repeat(100));
  {
    const SALDO = 668.25;   // il saldo reale letto su questa macchina l'8 agosto 2026, 17:30 UTC
    const g = await giro({ saldo: SALDO, piano: { ok: true, at: new Date().toISOString(), righe: RIGHE } });
    const capPerMercato = SALDO * 0.20;
    console.log(`  capitale ${usd(SALDO)} · tetto per mercato ${usd(capPerMercato)} (20%)`);
    console.log(`  utilizzo prima: ${g.r.utilizzo.pct}% · dopo il giro: ${g.r.utilizzoStimatoDopo.pct}% (obiettivo ${g.r.utilizzo.targetPct}%)`);
    console.log(`  mercati: ${(g.r.mercati || []).map((m) => `${m.marketId} ${usd(m.allocatoUsd)}`).join(' · ')}`);
    console.log(`  residuo liquido: ${usd(g.r.residuoUsd)} · motivo dello stop: ${g.r.motivoStop}`);
    const maxPerMercato = Math.max(...(g.r.mercati || []).map((m) => m.allocatoUsd));
    check(g.r.utilizzo.pct === 0, 'si parte da un conto interamente liquido: utilizzo 0%');
    check(g.r.utilizzoStimatoDopo.pct >= 89, `il giro porta l'utilizzo a ${g.r.utilizzoStimatoDopo.pct}%, cioè alla soglia`);
    check(maxPerMercato <= capPerMercato + 0.01, `nessun mercato supera il tetto del 20% (max ${usd(maxPerMercato)} ≤ ${usd(capPerMercato)})`);
    check((g.r.mercati || []).length <= TRIG.MAX_MERCATI_PER_GIRO, 'e il tetto di mercati per giro è rispettato');
    check(g.r.allocatoUsd <= SALDO, 'non si impegna più del liquido disponibile');
    // La prova che il target NON è un permesso: con meno mercati validi si resta sotto e lo si dichiara.
    const scarso = await giro({ saldo: SALDO, piano: { ok: true, at: new Date().toISOString(), righe: [riga('0xAAA', 'unico', 9)] }, ricalcolo: async () => ({ rows: [] }) });
    console.log(`  con UN solo mercato valido: utilizzo ${scarso.r.utilizzoStimatoDopo.pct}% · ${scarso.r.utilizzoStimatoDopo.motivo.slice(0, 90)}`);
    check(scarso.r.utilizzoStimatoDopo.pct < 90 && scarso.r.utilizzoStimatoDopo.raggiunto === false,
      'con mercati insufficienti si resta SOTTO il 90% e lo si dichiara: il target non scavalca nessun tetto');
  }

  console.log('\n' + '═'.repeat(100));
  console.log(falliti === 0 ? '✅  TUTTI I CONTROLLI PASSATI — nessun ordine reale è stato inviato in questa esecuzione'
    : `❌  ${falliti} controlli falliti`);
  console.log('═'.repeat(100) + '\n');
  if (falliti) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
