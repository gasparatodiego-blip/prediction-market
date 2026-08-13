'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *  IL RISCATTO AUTOMATICO — l'unica uscita che i residui sotto soglia hanno davvero
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ IL FATTO. Un residuo scoperto sotto `min_incentive_size` non è né ripiazzabile né vendibile senza
 * perderci: **ogni percorso che passa dal LIBRO è chiuso per costruzione** — riposizionare vuole un
 * ordine ≥ minSize, completare la coppia vuole comprare `manca` che è sotto minSize, e vendere paga uno
 * spread di 7-9¢ su una size minuscola. Resta una sola strada, e non passa dal libro: la **risoluzione
 * del mercato**, dopo la quale il token vincente vale $1 e quello perdente $0.
 *
 * Ma `redeemPosition` esisteva, era provata on-chain, e **non aveva nessun chiamante**: il capitale
 * tornava solo se un umano se ne accorgeva. Questo modulo è quel chiamante.
 *
 * ═══ IL SEGNALE: `payoutDenominator > 0`, NON «il mercato è chiuso» ═════════════════════════════════
 * Sono due cose diverse e confonderle costa una transazione fallita a ogni giro. `closed`/
 * `acceptingOrders` dicono che il venue **non accetta più ordini** — succede ore prima che l'oracolo
 * riporti l'esito. `redeemPositions` esige che i **payout siano già stati riportati** sul contratto
 * CTF, e il modo di saperlo è chiederlo al contratto: `payoutDenominator(conditionId) > 0` è vero
 * **se e solo se** la condizione è risolta. È una lettura on-chain, autorevole e senza credenziali.
 *
 * ⚠ E se non si riesce a leggerlo, **non si riscatta**: un tentativo alla cieca costa gas al relayer e
 * produce un revert che non dice niente. L'incognita non è un via libera, qui come altrove.
 *
 * ═══ IDEMPOTENZA ═══════════════════════════════════════════════════════════════════════════════════
 * Un riscatto già avvenuto **non si ripete**: il registro su disco tiene `conditionId ⇒ {esito, tx}`, e
 * una voce riuscita chiude il caso per sempre. Non basta guardare la posizione — fra l'invio e la
 * sparizione del token dallo snapshot passano secondi, e in quella finestra un secondo giro
 * riproverebbe. Il registro è la memoria che quella finestra non ce l'ha.
 *
 * ═══ COSA NON FA ═══════════════════════════════════════════════════════════════════════════════════
 * Non compra, non vende, non tocca il book, non cancella niente. `redeemPositions` converte token
 * **già nostri** in collaterale: è l'unica operazione del sistema, col merge, che **libera** capitale
 * invece di impegnarlo. Non ha bisogno di nessun tetto perché non apre nessuna esposizione.
 *
 * Modulo **puro** nella parte che decide; la rete e il disco arrivano iniettati.
 */

const fin = (v) => Number.isFinite(v);
const normId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** Quanti tentativi, e con che attesa. Il relayer può essere momentaneamente giù o rifiutare per
 *  nonce: si riprova, ma non all'infinito nello stesso giro — il giro dopo arriva fra un minuto. */
const MAX_TENTATIVI = 3;
const ATTESA_BASE_MS = 2000;
/** Dopo un fallimento non si ritenta subito lo stesso mercato: 10 minuti. Un mercato che il relayer
 *  rifiuta per una ragione strutturale (payout non ancora riportati davvero) non deve produrre una
 *  transazione al minuto per sempre. */
const RITENTA_MS = 10 * 60_000;
/** Al più tre mercati per giro: il riscatto è manutenzione, non ha fretta, e ogni transazione costa
 *  gas al relayer di Polymarket — che è un servizio di terzi, non una risorsa nostra. */
const MAX_PER_GIRO = 3;

/**
 * QUALI POSIZIONI SONO RISCATTABILI ADESSO.
 *
 * @param posizioni  `[{conditionId, size, negRisk}]` dallo snapshot del venue
 * @param registro   `{ [conditionId]: {esito:'riuscito'|'fallito', at, tx} }`
 * @param risolto    `(conditionId) => true|false|null` — `null` = non si sa, e allora NON si riscatta
 * @returns `{daRiscattare:[], giaFatte:[], nonRisolte:[], inAttesa:[]}`
 */
function selezionaRiscattabili({
  posizioni = [], registro = {}, risolto = null, now = Date.now(), maxPerGiro = MAX_PER_GIRO,
} = {}) {
  const daRiscattare = [];
  const giaFatte = [];
  const nonRisolte = [];
  const inAttesa = [];
  const visti = new Set();

  for (const p of (posizioni || [])) {
    if (!p) continue;
    const cid = normId(p.conditionId || p.marketId);
    const size = Number(p.size);
    if (!cid || visti.has(cid)) continue;
    visti.add(cid);
    // Una posizione a zero non ha niente da riscattare, e chiedere il payout costerebbe una lettura.
    if (!fin(size) || size <= 0) continue;

    const r = registro && registro[cid];
    if (r && r.esito === 'riuscito') { giaFatte.push({ conditionId: cid, at: r.at, tx: r.tx }); continue; }
    if (r && r.esito === 'fallito' && fin(r.at) && (now - r.at) < RITENTA_MS) {
      inAttesa.push({ conditionId: cid, riprovaFra: Math.round((RITENTA_MS - (now - r.at)) / 1000) });
      continue;
    }

    let ris = null;
    // Una lettura che ESPLODE vale «non so», mai «sì»: si finisce fra le non risolte, non fra quelle
    // da riscattare. È la direzione che non spende gas su una condizione che forse non è risolta.
    try { ris = typeof risolto === 'function' ? risolto(cid) : null; } catch { ris = null; }
    if (ris !== true) {
      nonRisolte.push({ conditionId: cid, size, motivo: ris === false ? 'mercato non ancora risolto' : 'risoluzione non verificabile: non si riscatta al buio' });
      continue;
    }
    daRiscattare.push({ conditionId: cid, size, negRisk: typeof p.negRisk === 'boolean' ? p.negRisk : null });
    if (daRiscattare.length >= maxPerGiro) break;
  }
  return { daRiscattare, giaFatte, nonRisolte, inAttesa };
}

/**
 * IL RISCATTO VERO, con i ritentativi.
 *
 * @param riscatta  `async ({conditionId, negRisk}) => {ok, transactionHash?, error?}` — di difetto
 *                  `ctf-relayer.redeemPosition`, iniettato perché il test non tocchi la rete
 * @param attende   `async (ms) => void`, iniettabile perché il test non aspetti davvero
 */
async function riscattaTutte({
  posizioni = [], registro = {}, risolto = null, riscatta = null, attende = null,
  now = Date.now(), maxPerGiro = MAX_PER_GIRO, maxTentativi = MAX_TENTATIVI, audit = null,
} = {}) {
  const sel = selezionaRiscattabili({ posizioni, registro, risolto, now, maxPerGiro });
  const reg = { ...registro };
  const riusciti = [];
  const falliti = [];

  if (typeof riscatta !== 'function') {
    return { ...sel, riusciti, falliti, registro: reg, motivo: 'nessun riscattatore iniettato: non si tocca la rete' };
  }

  for (const p of sel.daRiscattare) {
    // ⚠ `negRisk` non booleano ⇒ NON si tenta: decide QUALE adapter CTF riceve la chiamata, e con
    // quello sbagliato la transazione reverte senza dire perché. Stessa regola del merge on-chain.
    if (typeof p.negRisk !== 'boolean') {
      falliti.push({ conditionId: p.conditionId, motivo: 'negRisk non leggibile: non si sceglie l\'adapter a caso' });
      reg[p.conditionId] = { esito: 'fallito', at: now, motivo: 'negRisk non leggibile' };
      continue;
    }
    let esito = null;
    for (let tent = 1; tent <= maxTentativi; tent += 1) {
      try { esito = await riscatta({ conditionId: p.conditionId, negRisk: p.negRisk }); }
      catch (e) { esito = { ok: false, error: (e && e.message) || 'eccezione senza messaggio' }; }
      if (esito && esito.ok === true) break;
      if (tent < maxTentativi && typeof attende === 'function') await attende(ATTESA_BASE_MS * (2 ** (tent - 1)));
    }
    if (esito && esito.ok === true) {
      const tx = esito.transactionHash || esito.transactionID || null;
      reg[p.conditionId] = { esito: 'riuscito', at: now, tx };
      riusciti.push({ conditionId: p.conditionId, size: p.size, tx });
      if (typeof audit === 'function') {
        try {
          audit({ ts: now, venue: 'polymarket', source: 'agent40', op: 'riscatto-automatico',
            reason: 'mercato risolto: il collaterale torna nel saldo', outcome: 'riscatto-eseguito',
            requested: { conditionId: p.conditionId, negRisk: p.negRisk },
            observed: { shareRiscattate: p.size, importoMaxUsd: p.size, transactionHash: tx } });
        } catch { /* l'audit non annulla un riscatto già avvenuto */ }
      }
    } else {
      const motivo = (esito && esito.error) || 'il relayer non ha confermato';
      reg[p.conditionId] = { esito: 'fallito', at: now, motivo };
      falliti.push({ conditionId: p.conditionId, motivo });
      if (typeof audit === 'function') {
        try {
          audit({ ts: now, venue: 'polymarket', source: 'agent40', op: 'riscatto-automatico',
            reason: 'mercato risolto', outcome: 'riscatto-fallito',
            requested: { conditionId: p.conditionId, negRisk: p.negRisk }, observed: { motivo, tentativi: maxTentativi } });
        } catch { /* idem */ }
      }
    }
  }
  return { ...sel, riusciti, falliti, registro: reg, motivo: null };
}

/**
 * IL SEGNALE DI RISOLUZIONE, dal contratto CTF. `payoutDenominator(conditionId) > 0` è vero **se e solo
 * se** l'oracolo ha riportato l'esito — che è precisamente la precondizione di `redeemPositions`.
 *
 * Restituisce una funzione SINCRONA a partire da una mappa già letta: la lettura on-chain la fa il
 * chiamante in modo asincrono e passa il risultato, così la decisione resta pura e testabile.
 */
function risoltoDaMappa(mappa) {
  return (cid) => {
    const v = mappa && Object.prototype.hasOwnProperty.call(mappa, normId(cid)) ? mappa[normId(cid)] : undefined;
    if (v === undefined || v === null) return null;      // non letto ⇒ non si sa
    if (typeof v === 'boolean') return v;
    const n = Number(v);
    return fin(n) ? n > 0 : null;                        // payoutDenominator
  };
}

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c) => { if (c) p += 1; else { f += 1; console.error('  ✗', n); } };
  const T = 1e12;
  const A = '0x' + 'a'.repeat(64);
  const B = '0x' + 'b'.repeat(64);
  const pos = (cid, o = {}) => ({ conditionId: cid, size: 15.49, negRisk: false, ...o });

  ok('una posizione su mercato risolto è riscattabile',
    selezionaRiscattabili({ posizioni: [pos(A)], risolto: () => true, now: T }).daRiscattare.length === 1);
  ok('un mercato NON risolto non si tocca',
    selezionaRiscattabili({ posizioni: [pos(A)], risolto: () => false, now: T }).nonRisolte.length === 1);
  ok('risoluzione non verificabile ⇒ NON si riscatta al buio', (() => {
    const s = selezionaRiscattabili({ posizioni: [pos(A)], risolto: () => null, now: T });
    return s.daRiscattare.length === 0 && /non si riscatta al buio/.test(s.nonRisolte[0].motivo);
  })());
  ok('una lettura che esplode vale «non so»',
    selezionaRiscattabili({ posizioni: [pos(A)], risolto: () => { throw new Error('rpc giu'); }, now: T }).daRiscattare.length === 0);
  ok('IDEMPOTENZA: un riscatto già riuscito non si ripete', (() => {
    const s = selezionaRiscattabili({ posizioni: [pos(A)], registro: { [A]: { esito: 'riuscito', at: T - 1e6, tx: '0x1' } }, risolto: () => true, now: T });
    return s.daRiscattare.length === 0 && s.giaFatte.length === 1;
  })());
  ok('un fallimento recente non si ritenta subito',
    selezionaRiscattabili({ posizioni: [pos(A)], registro: { [A]: { esito: 'fallito', at: T - 60_000 } }, risolto: () => true, now: T }).inAttesa.length === 1);
  ok('  e dopo la finestra si riprova',
    selezionaRiscattabili({ posizioni: [pos(A)], registro: { [A]: { esito: 'fallito', at: T - RITENTA_MS - 1 } }, risolto: () => true, now: T }).daRiscattare.length === 1);
  ok('una posizione a zero non si riscatta',
    selezionaRiscattabili({ posizioni: [pos(A, { size: 0 })], risolto: () => true, now: T }).daRiscattare.length === 0);
  ok('il tetto per giro morde',
    selezionaRiscattabili({ posizioni: [pos(A), pos(B), pos('0x' + 'c'.repeat(64)), pos('0x' + 'd'.repeat(64))], risolto: () => true, now: T, maxPerGiro: 2 }).daRiscattare.length === 2);

  ok('payoutDenominator > 0 significa risolto, 0 no, assente «non so»', (() => {
    const r = risoltoDaMappa({ [A]: 1, [B]: 0 });
    return r(A) === true && r(B) === false && r('0x' + 'e'.repeat(64)) === null;
  })());

  return (async () => {
    let chiamate = 0;
    let r = await riscattaTutte({ posizioni: [pos(A)], risolto: () => true, now: T,
      riscatta: async () => { chiamate += 1; return { ok: true, transactionHash: '0xdead' }; } });
    ok('il riscatto riuscito finisce nel registro con la tx', r.riusciti.length === 1 && r.registro[A].esito === 'riuscito' && r.registro[A].tx === '0xdead');
    ok('  e una sola chiamata', chiamate === 1);

    chiamate = 0;
    r = await riscattaTutte({ posizioni: [pos(A)], risolto: () => true, now: T, attende: async () => {},
      riscatta: async () => { chiamate += 1; return { ok: false, error: 'relayer 503' }; } });
    ok('un fallimento si ritenta tre volte e poi si arrende', chiamate === 3 && r.falliti.length === 1);
    ok('  e il fallimento è memorizzato per non martellare', r.registro[A].esito === 'fallito');

    chiamate = 0;
    r = await riscattaTutte({ posizioni: [pos(A)], risolto: () => true, now: T, attende: async () => {},
      riscatta: async (x) => { chiamate += 1; return chiamate < 2 ? { ok: false, error: 'nonce' } : { ok: true, transactionHash: '0xok' }; } });
    ok('un ritentativo che riesce chiude il caso', r.riusciti.length === 1 && chiamate === 2);

    r = await riscattaTutte({ posizioni: [pos(A, { negRisk: null })], risolto: () => true, now: T,
      riscatta: async () => { throw new Error('non deve essere chiamata'); } });
    ok('negRisk non leggibile ⇒ non si sceglie l\'adapter a caso', r.falliti.length === 1 && /negRisk/.test(r.falliti[0].motivo));

    const righe = [];
    await riscattaTutte({ posizioni: [pos(A)], risolto: () => true, now: T, audit: (x) => righe.push(x),
      riscatta: async () => ({ ok: true, transactionHash: '0xaudit' }) });
    ok('il riscatto è registrato nel giornale con l\'importo', righe.length === 1 && righe[0].observed.shareRiscattate === 15.49 && righe[0].observed.transactionHash === '0xaudit');

    r = await riscattaTutte({ posizioni: [pos(A)], risolto: () => true, now: T });
    ok('senza riscattatore iniettato non si tocca la rete', r.riusciti.length === 0 && /nessun riscattatore/.test(r.motivo));

    console.log(`riscatto-automatico selfcheck: ${p} passati, ${f} falliti`);
    return f === 0;
  })();
}

module.exports = {
  selezionaRiscattabili, riscattaTutte, risoltoDaMappa, selfcheck,
  MAX_TENTATIVI, RITENTA_MS, MAX_PER_GIRO,
};

if (require.main === module) selfcheck().then((v) => process.exit(v ? 0 : 1));
