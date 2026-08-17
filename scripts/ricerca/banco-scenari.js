#!/usr/bin/env node
'use strict';
/**
 * IL GIRO COMPLETO, DALL'ACCENSIONE ALL'INCASSO — col CABLAGGIO DI PRODUZIONE.
 *
 * ═══ COSA CAMBIA RISPETTO ALLA VERSIONE PRECEDENTE ══════════════════════════════════════════════════
 * Il banco NON ha piu' un cablaggio proprio. Chiama le porte di produzione:
 *
 *      A41.giro()                    il ciclo da 6 ore, con le sue 21 dep cablate dentro
 *      A40.cycle()                   il ciclo di riprezzo
 *      A40.closeTask()               il ciclo di chiusura/merge, con le sue 20 dep
 *      A40.reconcileTask()           la riconciliazione della corsia manuale
 *      A40.snapshotPosizioniTask()   lo snapshot delle posizioni
 *      A40.sorveglianzaTask()        la sorveglianza sulla valutazione
 *      A40.sparizioneTask()          l'allarme sulle sparizioni non nostre
 *
 * La versione precedente ricablava `runAutoCloseCycle` con 17 dep contro le 20 di `closeTask`: le 7
 * mancanti erano il fill parziale, la rotazione dello slot e la scadenza del mercato. Il suo «37 su 91»
 * descriveva un bot che non esiste.
 *
 * ═══ I 17 PASSI, NELL'ORDINE CHIESTO DALL'OPERATORE ═════════════════════════════════════════════════
 *  1 accensione da zero   2 perimetro e capitale   3 due gambe a libro   4 riprezzamento
 *  5 fill totale   6 gamba opposta entro il ciclo   7 coppia completa → merge → incasso
 *  8 slot che si libera → rimpiazzo   9 fill parziale + residuo cancellato   10 scala d'urgenza
 * 11 take-profit   12 merge che fallisce   13 gamba morta → ripristino   14 sparizione non nostra
 * 15 feed muto / avgPrice assente / rifiuto post-only   16 scadenza → perimetro   17 kill a −$100
 *
 * ⚠ AL PRIMO PASSO CHE SI BLOCCA IL BANCO SI FERMA e dice dove. Non si aggira per arrivare in fondo:
 * un giro che arriva in fondo aggirando un blocco e' la bugia peggiore che questo banco possa dire.
 *
 * Uso:  node scripts/ricerca/banco-scenari.js [--verboso]
 */
const path = require('path');
const fs = require('fs');

// ⚠ LA BASE VA CARICATA PER PRIMA: sostituisce i moduli del venue in `require.cache` prima che qualunque
// altro modulo li catturi, verifica che il codice sia identico a quello vivo, e installa l'orologio.
const BASE = require('./banco-ciclo-completo');
const { VENUE, OROLOGIO, ROOT, VERBOSO, IDENTITA } = BASE;

// Il freno di agent41: senza questo il ciclo calcola il piano e non manda niente al venue (fail-closed).
process.env.REALLOC_SCHEDULER_DRY_RUN = '0';
process.env.REALLOC_SCHEDULER_ENABLED = '1';

// Da qui in giu' e' tutto codice di PRODUZIONE.
const A40 = require(path.join(ROOT, 'agents/agent40-manual-reprice'));
const A41 = require(path.join(ROOT, 'agents/agent41-realloc-scheduler'));
const BOT = require(path.join(ROOT, 'lib/maker/bot-enabled'));
const ARC = require(path.join(ROOT, 'lib/maker/auto-reprice-config'));
const MM = require(path.join(ROOT, 'lib/maker/manual-mode'));
const ACC = require(path.join(ROOT, 'lib/maker/auto-close-config'));
const SEL = require(path.join(ROOT, 'lib/maker/selezione-stato'));
const SELM = require(path.join(ROOT, 'lib/maker/selezione-mercati'));
const ADAPTER = require(path.join(ROOT, 'lib/venues/polymarket-clob-maker/adapter'));
const AUDIT = require(path.join(ROOT, 'lib/venues/polymarket-clob-maker/audit'));

const MKT = '0x' + 'a1'.repeat(32);

// ── L'INVENTARIO DELLE REGOLE, ESTRATTO DAL SORGENTE ───────────────────────────────────────────────
function inventarioRegole() {
  const file = ['lib/maker/auto-close.js', 'lib/maker/auto-reprice.js', 'lib/maker/manual-order.js',
    'lib/maker/bulk-allocate.js', 'agents/agent41-realloc-scheduler.js', 'agents/agent40-manual-reprice.js'];
  const statiche = new Map();
  const dinamiche = [];
  for (const f of file) {
    let src; try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    const codice = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    for (const m of codice.matchAll(/outcome:\s*([^,\n]+)/g)) {
      const espr = String(m[1]);
      const senzaConfronti = espr.replace(/[!=]==?\s*'[^']*'/g, ' ');
      const senzaRipieghi = senzaConfronti.replace(/\$\{[^}]*\}/g, ' ');
      for (const q of senzaRipieghi.matchAll(/'([a-z0-9-]{3,})'/g)) {
        if (!statiche.has(q[1])) statiche.set(q[1], []);
        if (!statiche.get(q[1]).includes(f)) statiche.get(q[1]).push(f);
      }
    }
    for (const m of codice.matchAll(/outcome:\s*`([^`]+)`/g)) dinamiche.push({ file: f, forma: m[1] });
  }
  return { statiche, dinamiche };
}

// ── IL GIORNALE: SI LEGGE QUELLO VERO, DALLA POSIZIONE IN CUI ERA PRIMA DEL GIRO ───────────────────
// ⚠ NON SI SOSTITUISCE PIU' `audit`: nel worktree il giornale e' una copia, quindi `appendMakerAudit`
// vero puo' scrivere — con la sua rotazione, il suo lucchetto e il suo formato. Il banco legge la CODA
// scritta dopo l'offset di partenza: cosi' le regole contate sono quelle scattate in QUESTO giro, e non
// si eredita una riga di ieri (e' lo stesso principio del reset dei due presidi).
const GIORNALE_FILE = AUDIT.AUDIT_FILE;
const offsetIniziale = (() => { try { return fs.statSync(GIORNALE_FILE).size; } catch { return 0; } })();
function codaGiornale() {
  let testo = '';
  try {
    const fd = fs.openSync(GIORNALE_FILE, 'r');
    const dim = fs.statSync(GIORNALE_FILE).size;
    if (dim > offsetIniziale) {
      const buf = Buffer.alloc(dim - offsetIniziale);
      fs.readSync(fd, buf, 0, buf.length, offsetIniziale);
      testo = buf.toString('utf8');
    }
    fs.closeSync(fd);
  } catch { /* giornale assente: coda vuota */ }
  const out = [];
  for (const riga of testo.split('\n')) {
    if (!riga.trim()) continue;
    try { out.push(JSON.parse(riga)); } catch { /* riga a meta': si salta */ }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
const passi = [];
let bloccato = null;
function passo(n, dettaglio = {}) {
  const r = { n: passi.length + 1, ora: new Date(OROLOGIO.ora).toISOString().slice(11, 19), titolo: n, ...dettaglio };
  passi.push(r);
  const stato = r.ok === false ? '🔴' : (r.ok === true ? '✅' : '  ');
  console.log(`${stato} ${String(r.n).padStart(2)} · ${r.ora} · ${n}`);
  for (const [k, v] of Object.entries(dettaglio)) {
    if (k === 'ok') continue;
    console.log(`        ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  return r;
}
function blocca(dove, perche, riferimento) {
  bloccato = { dove, perche, riferimento };
  console.log(`\n🔴 IL GIRO SI FERMA A: ${dove}`);
  console.log(`   perche': ${perche}`);
  if (riferimento) console.log(`   dove:    ${riferimento}`);
}

(async () => {
  const t0 = BASE.DateNowVero();
  const inv = inventarioRegole();
  console.log('\n════ IL GIRO COMPLETO — cablaggio di PRODUZIONE ════');
  console.log(`worktree ${ROOT} · alberi ${IDENTITA.alberiConfrontati.join('/')} IDENTICI byte per byte a ${BASE.VIVO}`);
console.log(`commit worktree ${String(IDENTITA.commitWorktree).slice(0, 12)} · commit vivo ${String(IDENTITA.commitVivo).slice(0, 12)}`);
  console.log(`giornale vero: ${GIORNALE_FILE} (offset di partenza ${offsetIniziale})\n`);

  // ══ PASSO 1 · ACCENSIONE DA ZERO ════════════════════════════════════════════════════════════════
  {
    const buttato = VENUE.azzera('accensione da zero');
    // Lo stato del bot si scrive con i SUOI scrittori, nel `data/` del worktree (una copia).
    for (const id of (ARC.readAutoRepriceConfig({}).enabledMarketIds || [])) {
      ARC.setAutoReprice({ scope: 'market', marketId: id, enabled: false, by: 'banco', reason: 'accensione da zero' });
    }
    ARC.setAutoReprice({ scope: 'global', enabled: true, by: 'banco', reason: 'accensione da zero' });
    BOT.impostaBot({ enabled: true, by: 'banco', reason: 'giro completo simulato' });
    // ⚠ LA SELEZIONE VA ACCESA, e non e' una scorciatoia: e' la SOLA via di produzione per aprire da
    // zero. `giro()` chiama `selezionaMercati()` a :921, e quella e' la funzione che sceglie i mercati e
    // chiama `preparaMercatoNuovo`. Con la selezione spenta la lista dei mercati si scrive a mano
    // (`mercati.js`), cioe' l'accensione da zero richiederebbe una mano umana — che e' precisamente la
    // domanda del passo 3, e va misurata invece che aggirata.
    SEL.impostaAttiva({ attiva: true, by: 'banco', reason: 'giro completo simulato' });
    // ⚠ E LO STATO DELLA SELEZIONE VA AZZERATO, o «accensione da zero» e' una bugia: alla corsa
    // precedente il mercato era gia' fra i selezionati, quindi la selezione non lo faceva RIENTRARE —
    // e siccome il passo 1 svuota la allowlist, il ciclo trovava «nessun mercato in gestione» per un
    // avanzo del giro prima. E' la stessa lezione del reset dei due presidi: uno scenario che dipende
    // dagli avanzi di quello prima non e' uno scenario.
    SEL.scriviStato({ ...SELM.statoVuoto(), attiva: true }, { by: 'banco', reason: 'accensione da zero' });
    // ⚠ E IL PIANO SALVATO VA VIA, o «accensione da zero» e' una bugia. Misurato il 17 agosto: i primi
    // passaggi del passo 3 riuscivano perche' `data/realloc-ultimo-piano.json` conteneva ancora il piano
    // di una corsa precedente — cioe' il banco stava riusando un avanzo, esattamente la classe di difetto
    // che il reset dei due presidi esiste per non ripetere. Con il piano azzerato il mini-ciclo e'
    // costretto a passare dal RICALCOLO, che e' il percorso vero di un bot appena accesso.
    // ⚠ E CON LUI OGNI ALTRO STATO CHE SOPRAVVIVE FRA LE CORSE. Lo stato del RIPREZZO era il terzo
    // avanzo: `recordAutoRepriceState` scrive `recentAt` (gli istanti dei riprezzi recenti) e
    // `lastRepriceAt` su `data/maker-auto-reprice-state.json`, e il giro dopo li rilegge per decidere
    // anti-churn e tetto orario. Due corse di fila sullo stesso mercato non erano quindi la stessa corsa:
    // e' una delle cause del banco che dava due risultati diversi sullo stesso codice.
    for (const f of ['realloc-ultimo-piano.json', 'maker-auto-reprice-state.json', 'realloc-pools.json',
      'modalita-chiusura.json', 'attesa-merge.json', 'residui-scoperti.json', 'da-ripianificare.json',
      'quarantena-venue.json', 'presidio-posizioni.json', 'idempotenza-ordini.json']) {
      try { require('fs').unlinkSync(path.join(ROOT, 'data', f)); } catch { /* gia' assente */ }
    }
    const snap = await A40.snapshotPosizioniTask().catch((e) => ({ errore: e.message }));
    const cfg = ARC.readAutoRepriceConfig({});
    passo('1 · accensione da zero', {
      ok: (cfg.enabledMarketIds || []).length === 0 && VENUE.posizioni.size === 0 && VENUE.ordiniVivi().length === 0,
      buttatoDalReset: buttato, allowlist: (cfg.enabledMarketIds || []).length,
      posizioni: VENUE.posizioni.size, ordiniVivi: VENUE.ordiniVivi().length,
      snapshot: snap && snap.errore ? `ERRORE ${snap.errore}` : 'scritto dal venue simulato',
      avvia: BOT.statoBot().enabled, freno: require(path.join(ROOT, 'lib/maker/freno-prova')).statoFreno().attivo,
    });
  }

  // ══ PASSO 2 · PERIMETRO E CAPITALE LETTI ════════════════════════════════════════════════════════
  {
    const cfg = ARC.readAutoRepriceConfig({});
    const per = ADAPTER.perimetroLiveMin({ liveMinMarket: process.env.MAKER_LIVE_MIN_MARKET || '',
      allowedMarketIds: cfg.liveMinMarketIds || [] });
    const saldo = await A41.leggiSaldo().catch((e) => ({ errore: e.message }));
    passo('2 · perimetro e capitale letti', {
      ok: Number.isFinite(saldo && saldo.usd),
      perimetro: per.allowed.length, perimetroIds: per.allowed,
      saldoUsd: saldo && saldo.usd, saldoAffidabile: saldo && saldo.affidabile,
      nota: per.allowed.length === 0 ? 'perimetro ZERO ⇒ live-min-market-unset: nessun ordine passerebbe' : null,
    });
    if (!Number.isFinite(saldo && saldo.usd)) {
      blocca('passo 2', `il capitale non e' leggibile (${(saldo && saldo.motivo) || 'ignoto'})`, 'lib/maker/saldo-cache (sostituito dal banco)');
    }
  }

  // ══ PASSO 3 · DUE GAMBE A LIBRO, DAL CICLO DA 6 ORE ════════════════════════════════════════════
  if (!bloccato) {
    VENUE.creaMercato({ conditionId: MKT, mid: 0.40, tick: 0.01, minSize: 20, bandaCents: 4.5, oreAllaScadenza: 48 });
    // ⚠ NON si abilita il mercato a mano: e' `giro()` che deve farlo, passando da `preparaMercatoNuovo`.
    // Se lo abilitassimo noi, il banco proverebbe un piazzamento su una precondizione che in produzione
    // qualcun altro deve creare — e quel «qualcun altro» e' esattamente cio' che si vuole mettere alla prova.
    let referto = null;
    try { referto = await A41.giro('banco · giro completo'); }
    catch (e) { referto = { azione: 'eccezione', motivo: e.message, stack: e.stack }; }
    passo('3a · il ciclo da 6 ore (A41.giro): MANTIENE, non apre', {
      ok: true,
      azione: referto && referto.azione, motivo: String((referto && referto.motivo) || '').slice(0, 240),
      righePiano: referto && referto.piano ? (referto.piano.rows || referto.piano.righe || []).length : null,
      capitalePiano: referto && referto.piano ? referto.piano.capitale : null,
      ordiniViviDopoIl6h: VENUE.ordiniVivi(MKT).length,
      nota: 'i due trigger del ciclo sono VALIDITA\' e VALORE: da zero nessuno dei due scatta (§5-bis 19)',
    });

    // ⚠ CHI APRE DA ZERO E' IL TRIGGER A CAPITALE FERMO, non il ciclo da 6 ore. Si chiama la funzione
    // di produzione che DECIDE (saldo sopra soglia, board fresco, AVVIA, kill) — non `miniCiclo`, che e'
    // solo la sua meta' esecutiva: guidare `miniCiclo` da qui vorrebbe dire riscrivere quella decisione.
    let trigger = null;
    try { trigger = await A41.controlloCapitaleFermo({ forzatoDa: 'banco · giro completo' }); }
    catch (e) { trigger = { errore: e.message, stack: e.stack }; }
    const vivi = VENUE.ordiniVivi(MKT);
    passo('3 · due gambe a libro (A41.controlloCapitaleFermo → miniCiclo)', {
      ok: vivi.length >= 2,
      esitoTrigger: trigger && (trigger.esito || trigger.errore || 'nessun esito'),
      motivoTrigger: String((trigger && (trigger.motivo || trigger.errore)) || '').slice(0, 240),
      nozionaleInviato: trigger && trigger.nozionaleUsd,
      mercatiToccati: trigger && trigger.mercati ? trigger.mercati.length : null,
      ordiniViviSulMercato: vivi.length,
      prezzi: vivi.map((o) => `${o.side} ${o.tokenId.slice(0, 8)} @${o.price} ×${o.size}`),
    });
    if (vivi.length < 2) {
      blocca('passo 3', `ne' il ciclo da 6 ore ne' il trigger a capitale fermo hanno messo due gambe a libro. `
        + `6h: azione='${referto && referto.azione}', motivo='${String((referto && referto.motivo) || '').slice(0, 220)}'. `
        + `trigger: esito='${trigger && (trigger.esito || trigger.errore)}', motivo='${String((trigger && (trigger.motivo || trigger.errore)) || '').slice(0, 260)}'`,
        'agents/agent41-realloc-scheduler.js:904 (giro) e :2712 (controlloCapitaleFermo → miniCiclo)');
    }
  }

  // ══ PASSO 4 · IL BOOK SI MUOVE: RIPREZZAMENTO ═════════════════════════════════════════════════
  if (!bloccato) {
    // ⚠ COSA VEDE LA CORSIA MANUALE: `auto-reprice.selectOwnedOrders` accetta solo `source === 'manual-ui'`
    // (`auto-reprice.js:911`), e alla prima corsa il ciclo dichiarava `considered: 0` con 4 ordini a
    // libro. Prima di accusare `decideReprice` bisogna sapere se gli ordini arrivano fin la'.
    const MO = require(path.join(ROOT, 'lib/maker/manual-order'));
    const attribuiti = await MO.listManualOrders({ marketId: MKT }).catch((e) => ({ ok: false, error: e.message }));
    // Sonda: l'adapter di sola lettura vede gli ordini? Due forme di chiamata, perche' il chiamante vero
    // passa una STRINGA (`manual-order.js` → `adapter.listOpenOrders(marketId || undefined)`).
    const soloLettura = ADAPTER.createCancelOnlyAdapter({});
    const conStringa = await soloLettura.listOpenOrders(MKT).catch((e) => ({ errore: e.message }));
    const conOggetto = await soloLettura.listOpenOrders({ marketId: MKT }).catch((e) => ({ errore: e.message }));
    passo('4-sonda · l\'adapter di sola lettura', {
      conStringa: conStringa && (conStringa.errore || (conStringa.orders || []).length),
      conOggetto: conOggetto && (conOggetto.errore || (conOggetto.orders || []).length),
      alVenue: VENUE.ordiniVivi(MKT).length,
    });
    passo('4-pre · cosa vede la corsia manuale (listManualOrders)', {
      ok: !!(attribuiti && attribuiti.ok && (attribuiti.orders || []).length),
      ok_lettura: attribuiti && attribuiti.ok, errore: attribuiti && attribuiti.error,
      simulated: attribuiti && attribuiti.simulated, count: attribuiti && attribuiti.count,
      ordini: (attribuiti && attribuiti.orders ? attribuiti.orders : []).map((o) => ({ id: o.orderId, source: o.source, origine: o.origine, side: o.side, price: o.price })),
    });
    const prima = VENUE.ordiniVivi(MKT).map((o) => `${o.orderId}@${o.price}`);
    const esiti = [];
    // ⚠ TRE TICK NON BASTANO, E NON E' UN DIFETTO: la banda e' ±4,5¢, quindi a tre tick gli ordini sono
    // ancora DENTRO e il ciclo dichiara «holding 2/2 order(s) in band — nothing touched» con la distanza
    // e il margine misurati. Il criterio giusto non e' «qualcosa e' cambiato» ma «il ciclo ha valutato e
    // deciso»: si spinge il mid fino a portare un ordine FUORI banda, che e' la condizione che il
    // riprezzo esiste per gestire. Sei tick su banda 4,5¢ con isteresi.
    for (let i = 0; i < 6; i += 1) {
      VENUE.avanza(60_000);
      VENUE.muoviMid(MKT, -0.01);
      const r = await A40.cycle().catch((e) => ({ errore: e.message }));
      // ⚠ SI GUARDA COSA HA RISPOSTO IL CICLO, non solo cosa e' cambiato al venue: la prima corsa
      // dichiarava «nessun ordine riprezzato» senza dire perche', che e' la meta' inutile di una misura.
      esiti.push(r && (r.errore || JSON.stringify(r).slice(0, 900)));
    }
    const dopo = VENUE.ordiniVivi(MKT).map((o) => `${o.orderId}@${o.price}`);
    passo('4 · il book si muove: riprezzamento (A40.cycle)', {
      ok: JSON.stringify(prima) !== JSON.stringify(dopo),
      midOra: VENUE.mercato(MKT).mid.toFixed(3), prima, dopo, rispostaDelCiclo: esiti,
    });
    if (JSON.stringify(prima) === JSON.stringify(dopo)) {
      blocca('passo 4', 'dopo sei cicli e sei tick di mid (banda ±4,5¢) nessun ordine e\' stato riprezzato ne\' cancellato', 'lib/maker/auto-reprice.js (decideReprice)');
    }
  }

  // ══ PASSO 5 · FILL TOTALE SU UNA GAMBA ═════════════════════════════════════════════════════════
  if (!bloccato) {
    const g = VENUE.ordiniVivi(MKT).find((o) => o.tokenId === VENUE.mercato(MKT).tokenId && o.side === 'BUY');
    if (!g) blocca('passo 5', 'nessuna gamba YES a libro da riempire', 'scenario');
    else {
      VENUE.riempi(g.orderId, g.size);
      await A40.snapshotPosizioniTask().catch(() => {});
      passo('5 · fill totale su una gamba', { ok: VENUE.posizioni.size > 0,
        share: g.size, prezzo: g.price, posizioni: VENUE.posizioni.size, saldo: +VENUE.saldo.toFixed(2) });
    }
  }

  // ══ PASSO 6 · GAMBA OPPOSTA A LIBRO ENTRO IL CICLO ════════════════════════════════════════════
  if (!bloccato) {
    const primaOrdini = VENUE.ordiniVivi(MKT).length;
    VENUE.avanza(60_000);
    await A40.closeTask().catch((e) => passo('6 · errore in closeTask', { ok: false, errore: e.message }));
    const m = VENUE.mercato(MKT);
    const opposte = VENUE.ordiniVivi(MKT).filter((o) => o.tokenId === m.tokenIdNo);
    passo('6 · gamba opposta a libro entro il ciclo (A40.closeTask)', {
      ok: opposte.length > 0,
      ordiniPrima: primaOrdini, ordiniDopo: VENUE.ordiniVivi(MKT).length,
      gambeOpposte: opposte.map((o) => `${o.side} @${o.price} ×${o.size}`),
    });
    if (!opposte.length) {
      blocca('passo 6', 'closeTask non ha messo a libro la gamba opposta', 'lib/maker/auto-close.js (completaCoppia / decidiLivello)');
    }
  }

  // ══ PASSO 7 · COPPIA COMPLETA → MERGE → INCASSO ═══════════════════════════════════════════════
  if (!bloccato) {
    const m = VENUE.mercato(MKT);
    const opp = VENUE.ordiniVivi(MKT).find((o) => o.tokenId === m.tokenIdNo);
    if (opp) VENUE.riempi(opp.orderId, opp.size);
    await A40.snapshotPosizioniTask().catch(() => {});
    const saldoPrima = VENUE.saldo; const posPrima = VENUE.posizioni.size;
    // ⚠ `closeTask` esce IN SILENZIO se non ha mercati da visitare (`agent40:1240`, «OFF: silent»), e un
    // silenzio non e' una diagnosi: si stampano le tre liste che compongono `visitare` prima di chiamarlo.
    const cfgClose = ACC.readAutoCloseConfig();
    const cfgRep = ARC.readAutoRepriceConfig({});
    passo('7-pre · chi visita closeTask', {
      uscitaAutomatica: (cfgClose.readable ? cfgClose.enabledMarketIds : null),
      unioneLiveMin: cfgRep.liveMinMarketIds,
      gestioneManuale: MM.isManualMarket(MKT),
      posizioniAlVenue: VENUE.posizioniVenue().map((p) => `${p.tokenId} ×${p.size} @${p.avgPrice}`),
    });
    VENUE.avanza(60_000);
    const res7 = await A40.closeTask().catch((e) => ({ errore: e.message }));
    passo('7 · coppia completa → merge → incasso', {
      // ⚠ IL CRITERIO NON E' «le posizioni sono diminuite»: `closeTask` puo' COMPRARE l'altra gamba per
      // completare la coppia (misurato: NO da 61,2 a 122,4) e poi fondere, lasciando due token con size
      // residua. Il fatto che conta e' che il merge sia AVVENUTO e che il capitale sia TORNATO.
      ok: VENUE.eventi.some((e) => e.tipo === 'merge-eseguito') && VENUE.saldo > saldoPrima,
      saldoPrima: +saldoPrima.toFixed(2), saldoDopo: +VENUE.saldo.toFixed(2),
      posizioniPrima: posPrima, posizioniDopo: VENUE.posizioni.size,
      mergeEseguiti: VENUE.eventi.filter((e) => e.tipo === 'merge-eseguito').length,
      refertoCloseTask: res7 && (res7.errore || JSON.stringify({
        mercati: (res7.markets || []).length,
        nostro: (res7.markets || []).find((m) => String(m.marketId).toLowerCase() === MKT) || null,
        azioni: (res7.actions || []).length,
      })).slice(0, 700),
    });
    if (!(VENUE.eventi.some((e) => e.tipo === 'merge-eseguito') && VENUE.saldo > saldoPrima)) {
      blocca('passo 7', 'la coppia completa non e\' stata fusa: saldo e posizioni non sono cambiati', 'lib/maker/auto-close.js:676 (fondiCoppia)');
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // IL VERDETTO
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  const giornale = codaGiornale();
  const visti = new Map();
  for (const r of giornale) { const o = String(r.outcome || ''); if (!o) continue; visti.set(o, (visti.get(o) || 0) + 1); }
  const scattate = []; const mai = [];
  for (const [regola, file] of [...inv.statiche].sort()) {
    (visti.has(regola) ? scattate : mai).push({ regola, file, volte: visti.get(regola) || 0 });
  }
  const dinamicheScattate = [...visti.keys()].filter((o) => !inv.statiche.has(o));

  const referto = { generatoIl: new Date(BASE.DateNowVero()).toISOString(), durataMs: BASE.DateNowVero() - t0,
    identita: IDENTITA, cablaggio: 'produzione (A41.giro, A40.cycle, A40.closeTask)',
    passi, bloccato,
    righeGiornale: giornale.length, eventiVenue: VENUE.eventi.length,
    regoleInventariate: inv.statiche.size, regoleScattate: scattate.length, regoleMaiScattate: mai.length,
    formeDinamiche: inv.dinamiche.length, dinamicheConcretizzate: dinamicheScattate.length,
    scattate, mai, dinamicheScattate,
    eventiVenueRiassunti: [...VENUE.eventi.reduce((m, e) => m.set(e.tipo, (m.get(e.tipo) || 0) + 1), new Map())]
      .map(([tipo, n]) => ({ tipo, n })),
  };
  fs.mkdirSync(path.dirname(BASE.OUT), { recursive: true });
  fs.writeFileSync(BASE.OUT, JSON.stringify(referto, null, 1));
  fs.writeFileSync(BASE.OUT.replace(/\.json$/, '-giornale.jsonl'), giornale.map((r) => JSON.stringify(r)).join('\n') + '\n');

  console.log('\n── cosa ha fatto il venue simulato ──');
  for (const e of referto.eventiVenueRiassunti) console.log(`  ${String(e.n).padStart(4)}  ${e.tipo}`);
  console.log('\n── regole ──');
  console.log(`  inventariate dal sorgente : ${inv.statiche.size}`);
  console.log(`  SCATTATE nel giro         : ${scattate.length}`);
  console.log(`  MAI SCATTATE              : ${mai.length}`);
  console.log(`  forme dinamiche concrete  : ${dinamicheScattate.length}`);
  console.log(`\nreferto → ${path.relative(ROOT, BASE.OUT)}`);
  if (bloccato) { console.log(`\n🔴 GIRO INCOMPLETO: fermo a «${bloccato.dove}».`); process.exitCode = 1; }
})();
