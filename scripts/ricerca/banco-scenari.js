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
// ⚠ `manual-order` VA RICHIESTO IN CIMA, e la sua assenza qui ha prodotto il difetto piu' insidioso di
// questa stesura: `MO` era dichiarato con un `const` DENTRO il blocco del passo 4, quindi i passi da 9 in
// giu' morivano con `ReferenceError: MO is not defined` — e morivano PRIMA che il referto venisse scritto.
// Il banco non stampava niente di rosso: io leggevo il referto della corsa PRECEDENTE e vedevo il passo 8
// fallire a corse alterne. Tre diagnosi sono andate a vuoto su una lettura stantia. Un banco che muore
// senza scrivere il verbale e' peggio di un banco che si ferma.
const MO = require(path.join(ROOT, 'lib/maker/manual-order'));
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
    const primaDettaglio = VENUE.ordiniVivi(MKT).map((o) => `${o.orderId} ${o.side} ${o.tokenId.slice(0, 8)} @${o.price} ×${o.size}`);
    VENUE.avanza(60_000);
    const res6 = await A40.closeTask().catch((e) => ({ errore: e.message }));
    const m = VENUE.mercato(MKT);
    const opposte = VENUE.ordiniVivi(MKT).filter((o) => o.tokenId === m.tokenIdNo);
    // ⚠ IL CRITERIO ERA TROPPO STRETTO, e l'ha mostrato il referto di `closeTask`: chiedeva un ordine a
    // RIPOSO sul lato opposto, e il ciclo ha fatto una cosa MIGLIORE — `merge-livello-1`, il taker
    // immediato: ha comprato il NO a 0,67 attraversando lo spread invece di aspettare che il proprio bid
    // a 0,63 venisse riempito. La coppia si completa nello stesso ciclo e il libro resta vuoto, quindi
    // «nessuna gamba opposta a libro» era vero E il passo era riuscito. Il passo chiede «la gamba opposta
    // ENTRO IL CICLO»: si accettano entrambe le forme, e si DICHIARA quale delle due e' avvenuta.
    const posOpposta = Number((VENUE.posizioni.get(m.tokenIdNo) || {}).size || 0);
    passo('6 · gamba opposta entro il ciclo (A40.closeTask)', {
      ok: opposte.length > 0 || posOpposta > 0,
      comeEStataPresa: posOpposta > 0 ? 'ESEGUITA al mercato (Livello 1, taker)' : (opposte.length ? 'a RIPOSO sul libro' : 'non presa'),
      posizioneOppostaShare: posOpposta,
      ordiniPrima: primaOrdini, dettaglioPrima: primaDettaglio,
      ordiniDopo: VENUE.ordiniVivi(MKT).length,
      dettaglioDopo: VENUE.ordiniVivi(MKT).map((o) => `${o.orderId} ${o.side} ${o.tokenId.slice(0, 8)} @${o.price} ×${o.size}`),
      gambeOpposte: opposte.map((o) => `${o.side} @${o.price} ×${o.size}`),
      // ⚠ IL REFERTO DI `closeTask` SERVE QUI: senza, «la gamba opposta non c'e'» non dice se il ciclo
      // non l'ha proposta, l'ha proposta e il venue l'ha rifiutata, o l'ha CANCELLATA e non ripiazzata.
      refertoCloseTask: res6 && (res6.errore || JSON.stringify({
        nostro: (res6.markets || []).find((m) => String(m.marketId).toLowerCase() === MKT) || null,
        azioni: (res6.actions || []).map((a) => ({ a: a.action, ok: a.ok, gate: a.gate, book: a.book,
          size: a.size, price: a.price, reason: String(a.reason || '').slice(0, 120) })),
      })).slice(0, 1200),
    });
    if (!opposte.length && !(posOpposta > 0)) {
      blocca('passo 6', 'closeTask non ha preso la gamba opposta: ne\' a riposo ne\' al mercato', 'lib/maker/auto-close.js (completaCoppia / decidiLivello)');
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


  // ══ PASSO 8 · LO SLOT CHE SI LIBERA → RIMPIAZZO ═════════════════════════════════════════════════
  // La rotazione di §4.13: un mercato che riceve un fill ESCE dal conteggio dei tre attivi e resta in
  // gestione; contemporaneamente ne entra uno nuovo. Il passo arriva all'ESECUZIONE quando il mercato
  // nuovo e' ABILITATO — cioe' quando `preparaMercatoNuovo` ha scritto le sue quattro cose — non quando
  // la selezione dichiara di volerlo.
  if (!bloccato) {
    const M2 = `0x${'b2'.repeat(32)}`;
    // ⚠ `minSize 50`, cioe' scaglione «ALTO», e non e' un dettaglio: la composizione di §4.13 vuole
    // 1 basso (minSize ≤ 20) + 2 alti (≤ 50), e UNO SCAGLIONE VUOTO NON SI RIEMPIE COL VICINO. Il mercato
    // del giro ha minSize 20 e occupa il solo posto «basso»: un secondo candidato a 20 viene scartato per
    // composizione — misurato alla prima stesura, «1 mercati ammissibili, ENTRATI nessuno».
    VENUE.creaMercato({ conditionId: M2, mid: 0.45, tick: 0.01, minSize: 50, bandaCents: 4.5,
      oreAllaScadenza: 60, question: 'banco · candidato di rimpiazzo' });
    const primaAbilitati = (ARC.readAutoRepriceConfig({}).enabledMarketIds || []).map((x) => x.toLowerCase());
    const selPrima = Object.keys(((SEL.leggiStato().stato || {}).selezionati) || {}).map((x) => x.slice(0, 12));
    let sel = null;
    try { sel = await A41.selezionaMercati(); } catch (e) { sel = { errore: e.message }; }
    const dopoAbilitati = (ARC.readAutoRepriceConfig({}).enabledMarketIds || []).map((x) => x.toLowerCase());
    const nuoviAbilitati = dopoAbilitati.filter((x) => !primaAbilitati.includes(x));
    passo('8 · lo slot si libera → il mercato nuovo viene ABILITATO', {
      ok: nuoviAbilitati.includes(M2.toLowerCase()),
      esitoSelezione: sel && (sel.errore || sel.esito || 'senza esito'),
      abilitatiPrima: primaAbilitati.length, abilitatiDopo: dopoAbilitati.length,
      nuovi: nuoviAbilitati.map((x) => x.slice(0, 12)),
      entrati: sel && sel.entrati ? sel.entrati.map((e) => String(e.id || e).slice(0, 12)) : null,
      inGestione: sel && sel.inGestione ? sel.inGestione.length : null,
      selezionatiPrima: selPrima,
      selezionatiDopo: Object.keys(((SEL.leggiStato().stato || {}).selezionati) || {}).map((x) => x.slice(0, 12)),
      fileAllowlist: Object.entries(((() => { try { return JSON.parse(require('fs').readFileSync(path.join(ROOT, 'data', 'maker-auto-reprice.json'), 'utf8')).markets || {}; } catch { return {}; } })())).filter(([, v]) => v && v.enabled === true).map(([k]) => k.slice(0, 12)),
      scartatiPerComposizione: sel && sel.scartatiPerComposizione ? sel.scartatiPerComposizione.length : null,
      postiNonAssegnati: sel && sel.postiNonAssegnati ? sel.postiNonAssegnati : null,
    });
    if (!nuoviAbilitati.includes(M2.toLowerCase())) {
      blocca('passo 8', `la selezione non ha abilitato il mercato nuovo (esito='${sel && (sel.esito || sel.errore)}')`,
        'agents/agent41-realloc-scheduler.js:1632 (selezionaMercati) → preparaMercatoNuovo');
    }
  }

  // ══ PASSO 9 · FILL PARZIALE: OPPOSTA PER LA QUANTITA' RIEMPITA, RESIDUO CANCELLATO ══════════════
  // ⚠ IL FILL E' DI 1,82 SHARE SU `minSize 20`: e' il caso del 16 agosto, quello in cui il completamento
  // non e' un ordine valido e tutte le vie si chiudono insieme. Il passo arriva all'esecuzione quando il
  // residuo E' USCITO DAL LIBRO (non quando qualcuno lo dichiara).
  if (!bloccato) {
    const M3 = `0x${'c3'.repeat(32)}`;
    const m3 = VENUE.creaMercato({ conditionId: M3, mid: 0.40, tick: 0.01, minSize: 20, bandaCents: 4.5,
      oreAllaScadenza: 60, question: 'banco · fill parziale' });
    MM.setManualMode({ marketId: M3, manual: true, by: 'banco', reason: 'passo 9' });
    ARC.setAutoReprice({ scope: 'market', marketId: M3, enabled: true, by: 'banco', reason: 'passo 9' });
    ACC.setAutoClose({ scope: 'market', marketId: M3, enabled: true, by: 'banco', reason: 'passo 9' });
    const r9 = await MO.placeManualOrder({ marketId: M3, book: 'yes', side: 'BUY', price: 0.38, size: 40,
      userId: 'operator', inCoda: true }, {});
    const ordine = VENUE.ordiniVivi(M3).find((o) => o.side === 'BUY');
    if (ordine) VENUE.riempi(ordine.orderId, 1.82);
    const daQui9 = codaGiornale().length;
    VENUE.avanza(60_000);
    await A40.closeTask().catch(() => {});
    const dopo9 = codaGiornale().slice(daQui9);
    const residuoVia = !VENUE.ordiniVivi(M3).some((o) => o.orderId === (ordine || {}).orderId);
    const oppostaM3 = VENUE.ordiniVivi(M3).filter((o) => o.tokenId === m3.tokenIdNo);
    passo('9 · fill parziale: residuo CANCELLATO e opposta per la quantita\' riempita', {
      ok: residuoVia,
      piazzato: r9.ok, gate: r9.gate || null,
      fillato: 1.82, minSizeDelVenue: 20,
      residuoUscitoDalLibro: residuoVia,
      esitiResiduo: dopo9.filter((x) => /residuo/.test(String(x.outcome))).map((x) => x.outcome),
      oppostaALibro: oppostaM3.map((o) => `${o.side} @${o.price} ×${o.size}`),
      posizioneRestante: Number((VENUE.posizioni.get(m3.tokenId) || {}).size || 0),
    });
    if (!residuoVia) {
      blocca('passo 9', 'il residuo dell\'ordine parzialmente riempito e\' ancora a libro dopo un ciclo di chiusura',
        'lib/maker/auto-close.js (residuiDellaGambaRiempita) → modalita-chiusura.residuiDaCancellare');
    }
  }

  // ══ PASSO 10 · LA SCALA D'URGENZA FINO ALL'USCITA COLPITA CONTRO IL BID ════════════════════════
  // ⚠ IL PASSO CHIEDE L'ESECUZIONE, non il permesso: non basta che il pavimento scenda gradino per
  // gradino — l'uscita deve essere PRESA dal bid. Serve quindi che la coppia NON sia disponibile (ask
  // caro), o il Livello 1 completa e la posizione non resta scoperta.
  if (!bloccato) {
    const M4 = `0x${'d4'.repeat(32)}`;
    const m4 = VENUE.creaMercato({ conditionId: M4, mid: 0.50, tick: 0.01, minSize: 20, bandaCents: 4.5,
      oreAllaScadenza: 60, question: 'banco · scala d urgenza' });
    MM.setManualMode({ marketId: M4, manual: true, by: 'banco', reason: 'passo 10' });
    ARC.setAutoReprice({ scope: 'market', marketId: M4, enabled: true, by: 'banco', reason: 'passo 10' });
    ACC.setAutoClose({ scope: 'market', marketId: M4, enabled: true, by: 'banco', reason: 'passo 10' });
    const caro = () => { m4.book.no.asks = [{ price: 0.60, size: 500 }]; m4.book.no.bestAsk = 0.60; VENUE.pubblicaFeed(); };
    caro();
    const r10 = await MO.placeManualOrder({ marketId: M4, book: 'yes', side: 'BUY', price: 0.48, size: 40,
      userId: 'operator', inCoda: true }, {});
    const g10 = VENUE.ordiniVivi(M4).find((o) => o.side === 'BUY');
    if (g10) VENUE.riempi(g10.orderId, g10.size);
    const daQui10 = codaGiornale().length;
    const prezzi = [];
    for (let k = 0; k < 30; k += 1) {
      VENUE.avanza(10 * 60_000);           // 10 minuti per giro: la scala ha gradini a 30, 60 e 240 min
      caro();                              // `muoviMid` ricostruisce il book: l'ask caro va rimesso
      await A40.closeTask().catch(() => {});
      const u = VENUE.ordiniVivi(M4).find((o) => o.side === 'SELL');
      if (u) prezzi.push(u.price);
      if (!VENUE.posizioni.get(m4.tokenId)) break;   // l'uscita e' stata eseguita: la posizione e' via
    }
    const dopo10 = codaGiornale().slice(daQui10);
    const eseguita = !VENUE.posizioni.get(m4.tokenId);
    const fillSell = VENUE.eventi.filter((e) => e.tipo === 'fill' && e.side === 'SELL');
    passo('10 · la scala d\'urgenza arriva all\'uscita ESEGUITA', {
      ok: eseguita && fillSell.length > 0,
      piazzato: r10.ok, gate: r10.gate || null,
      prezziDellUscita: [...new Set(prezzi)],
      gradiniVisti: [...new Set(dopo10.map((x) => x.observed && x.observed.urgenzaLivello).filter((x) => x != null))],
      esitiUscita: [...new Set(dopo10.map((x) => x.outcome).filter((o) => /uscita|urgenz|attraversa|close/.test(String(o))))].slice(0, 8),
      fillInVendita: fillSell.map((f) => `${f.quanto}@${f.price}`),
      posizioneRestante: Number((VENUE.posizioni.get(m4.tokenId) || {}).size || 0),
    });
    if (!(eseguita && fillSell.length > 0)) {
      blocca('passo 10', 'la scala e\' salita ma l\'uscita non e\' stata ESEGUITA contro il bid',
        'lib/maker/urgenza-scoperto.js (pavimento) + lib/maker/auto-close.js (already-covered → uscita-da-abbassare)');
    }
  }

  // ══ PASSO 11 · IL TAKE-PROFIT CHE ESEGUE ══════════════════════════════════════════════════════
  // `presa-di-profitto` decide sul BID CAMMINATO: si scatta quando `bid + ask > 1 + margine` (la coppia
  // e' disponibile) oppure quando la coppia sfonda il tetto e `bid > carico + margine`. Qui si costruisce
  // il secondo caso, che e' quello che non ha alternative: ask caro, e il bid sopra il carico.
  if (!bloccato) {
    const M5 = `0x${'e5'.repeat(32)}`;
    const m5 = VENUE.creaMercato({ conditionId: M5, mid: 0.30, tick: 0.01, minSize: 20, bandaCents: 4.5,
      oreAllaScadenza: 60, question: 'banco · take profit' });
    MM.setManualMode({ marketId: M5, manual: true, by: 'banco', reason: 'passo 11' });
    ARC.setAutoReprice({ scope: 'market', marketId: M5, enabled: true, by: 'banco', reason: 'passo 11' });
    ACC.setAutoClose({ scope: 'market', marketId: M5, enabled: true, by: 'banco', reason: 'passo 11' });
    const r11 = await MO.placeManualOrder({ marketId: M5, book: 'yes', side: 'BUY', price: 0.28, size: 40,
      userId: 'operator', inCoda: true }, {});
    const g11 = VENUE.ordiniVivi(M5).find((o) => o.side === 'BUY');
    if (g11) VENUE.riempi(g11.orderId, g11.size);
    // Il mercato va A FAVORE: il mid sale da 0,30 a 0,45, quindi il bid (0,44) e' molto sopra il carico
    // (0,28). E la coppia resta inaccessibile: l'ask del NO e' fuori dal tetto di 101c.
    VENUE.muoviMid(M5, 0.15);
    m5.book.no.asks = [{ price: 0.90, size: 500 }]; m5.book.no.bestAsk = 0.90; VENUE.pubblicaFeed();
    const daQui11 = codaGiornale().length;
    VENUE.avanza(60_000);
    await A40.closeTask().catch(() => {});
    const dopo11 = codaGiornale().slice(daQui11);
    const fill11 = VENUE.eventi.filter((e) => e.tipo === 'fill' && e.side === 'SELL' && e.tokenId === m5.tokenId);
    passo('11 · il take-profit ESEGUE contro il bid', {
      ok: fill11.length > 0,
      piazzato: r11.ok, carico: 0.28, midOra: VENUE.mercato(M5).mid,
      bid: VENUE.mercato(M5).book.yes.bestBid, askDelNo: VENUE.mercato(M5).book.no.bestAsk,
      esiti: [...new Set(dopo11.map((x) => x.outcome))].slice(0, 10),
      fillInVendita: fill11.map((f) => `${f.quanto}@${f.price}`),
      posizioneRestante: Number((VENUE.posizioni.get(m5.tokenId) || {}).size || 0),
    });
    if (!fill11.length) {
      blocca('passo 11', 'la presa di profitto non ha eseguito: nessun fill in vendita sul lato posseduto',
        'lib/maker/presa-di-profitto.js → lib/maker/auto-close.js (decideClose, prima di already-covered)');
    }
  }


  // ══ PASSO 12 · IL MERGE CHE FALLISCE: ANOMALIA DICHIARATA, NON RIPROVATO IN SILENZIO ════════════
  // Il passo arriva all'esecuzione quando l'esito `merge-onchain-fallito` E' NEL GIORNALE e il capitale
  // NON e' tornato — cioe' quando il fallimento e' un fatto registrato e non un silenzio.
  if (!bloccato) {
    const M6 = `0x${'f6'.repeat(32)}`;
    const m6 = VENUE.creaMercato({ conditionId: M6, mid: 0.50, tick: 0.01, minSize: 20, bandaCents: 4.5,
      oreAllaScadenza: 60, question: 'banco · merge che fallisce' });
    MM.setManualMode({ marketId: M6, manual: true, by: 'banco', reason: 'passo 12' });
    ARC.setAutoReprice({ scope: 'market', marketId: M6, enabled: true, by: 'banco', reason: 'passo 12' });
    ACC.setAutoClose({ scope: 'market', marketId: M6, enabled: true, by: 'banco', reason: 'passo 12' });
    // La coppia si costruisce direttamente al venue: qui si prova il MERGE, non il modo di arrivarci.
    VENUE.posizioni.set(m6.tokenId, { size: 40, costoTotale: 40 * 0.48, nascondiPerCicli: 0 });
    VENUE.posizioni.set(m6.tokenIdNo, { size: 40, costoTotale: 40 * 0.50, nascondiPerCicli: 0 });
    VENUE.scenari.mergeFallisce = true;
    const daQui12 = codaGiornale().length;
    const saldo12 = VENUE.saldo;
    VENUE.avanza(60_000);
    await A40.closeTask().catch(() => {});
    const dopo12 = codaGiornale().slice(daQui12);
    // Il secondo giro: un fallimento non deve diventare un martellamento muto.
    VENUE.avanza(60_000);
    await A40.closeTask().catch(() => {});
    const dopo12b = codaGiornale().slice(daQui12);
    VENUE.scenari.mergeFallisce = false;
    const falliti = dopo12b.filter((x) => x.outcome === 'merge-onchain-fallito');
    passo('12 · il merge che FALLISCE lascia un\'anomalia dichiarata', {
      ok: falliti.length > 0 && VENUE.saldo === saldo12,
      esitiPrimoGiro: [...new Set(dopo12.map((x) => x.outcome))].slice(0, 8),
      mergeOnchainFallito: falliti.length,
      tentativiAlVenue: VENUE.eventi.filter((e) => e.tipo === 'merge-fallito').length,
      capitaleTornato: VENUE.saldo !== saldo12,
      motivoRegistrato: falliti[0] ? String(falliti[0].reason || '').slice(0, 90) : null,
    });
    if (!(falliti.length > 0 && VENUE.saldo === saldo12)) {
      blocca('passo 12', falliti.length ? 'il merge e\' fallito ma il capitale risulta tornato' : 'il merge fallito non ha lasciato `merge-onchain-fallito` nel giornale',
        'lib/maker/auto-close.js:676-700 (fondiCoppia, il ramo del catch)');
    }
    // Si sgombra: la coppia di questo passo non deve restare a decidere i passi dopo.
    VENUE.posizioni.delete(m6.tokenId); VENUE.posizioni.delete(m6.tokenIdNo);
  }

  // ══ PASSO 13 · GAMBA MORTA: RIPRISTINO ENTRO UN CICLO ═══════════════════════════════════════════
  // `riconciliaCopertura` → `ripristinaGamba`, in servizio da stamattina e mai esercitato su un mercato
  // vero. Il passo arriva all'esecuzione quando la gamba mancante E' TORNATA A LIBRO.
  //
  // ⚠ SI UCCIDE UNA GAMBA SU UN MERCATO CHE STA NEL PIANO SALVATO, e non su uno nuovo: la prima stesura
  // creava un mercato apposta e il ripristino rispondeva — correttamente — «nessuna riga nel piano salvato
  // per questo mercato: si dichiara e NON si ricalcola» (§5-bis p.171, e' una delle tre cose che quel
  // presidio NON fa di proposito). Lo scenario misurava un rifiuto giusto e lo chiamava fallimento.
  if (!bloccato) {
    // Il mercato con piu' gambe vive: e' uno che il percorso di produzione ha aperto, quindi ha una riga
    // nel piano. Si sceglie dai FATTI del venue, non da un id deciso a priori.
    const perMercato = new Map();
    for (const o of VENUE.ordiniVivi()) perMercato.set(o.marketId, (perMercato.get(o.marketId) || []).concat([o]));
    // ⚠ SI SCEGLIE UN MERCATO COPERTO SUI DUE LATI e si uccide TUTTO UN LATO. La prima stesura uccideva
    // un ordine solo e misurava «gambe dopo > gambe prima»: il mercato scelto aveva un DOPPIONE, la
    // riconciliazione l'ha rimosso — cosa giusta — e il conteggio e' SCESO da 3 a 2 mentre la copertura
    // era perfetta. Il criterio non e' quante gambe ci sono: e' se i DUE LATI sono coperti.
    const lati = (id) => {
      const o = VENUE.ordiniVivi(id); const m = VENUE.mercato(id);
      return { yes: o.filter((x) => x.tokenId === m.tokenId).length, no: o.filter((x) => x.tokenId === m.tokenIdNo).length };
    };
    const candidati13 = [...perMercato.keys()].filter((id) => { const l = lati(id); return l.yes > 0 && l.no > 0; });
    const idScelto = candidati13[0] || null;
    const gambePrima = idScelto ? VENUE.ordiniVivi(idScelto) : [];
    const latiPrima = idScelto ? lati(idScelto) : null;
    if (idScelto) {
      const m = VENUE.mercato(idScelto);
      for (const o of VENUE.ordiniVivi(idScelto)) if (o.tokenId === m.tokenIdNo) VENUE.cancelOrder(o.orderId);
    }
    const latiDopoMorte = idScelto ? lati(idScelto) : null;
    const gambeDopoMorte = idScelto ? VENUE.ordiniVivi(idScelto).length : 0;
    VENUE.avanza(120_000);
    let ric = null;
    try { ric = await A41.riconciliaCopertura(); } catch (e) { ric = { errore: e.message }; }
    const gambeDopoRipristino = idScelto ? VENUE.ordiniVivi(idScelto).length : 0;
    const giornale13 = fs.existsSync(path.join(ROOT, 'data', 'realloc-scheduler.jsonl'))
      ? fs.readFileSync(path.join(ROOT, 'data', 'realloc-scheduler.jsonl'), 'utf8').trim().split('\n').slice(-30)
        .map((l) => { try { return JSON.parse(l); } catch { return {}; } }).filter((x) => x.tipo === 'ripristino-gamba')
      : [];
    passo('13 · gamba morta → ripristino entro un ciclo', {
      ok: idScelto != null && latiDopoMorte && latiDopoMorte.no === 0 && lati(idScelto).no > 0,
      mercato: idScelto ? idScelto.slice(0, 12) : '(nessun mercato coperto sui due lati)',
      latiPrima, latiDopoLaMorte: latiDopoMorte, latiDopoIlRipristino: idScelto ? lati(idScelto) : null,
      gambePrima: gambePrima.length, dopoLaMorte: gambeDopoMorte, dopoIlRipristino: gambeDopoRipristino,
      esitiRipristino: giornale13.slice(-3).map((x) => `${x.esito}${x.mancanti ? ` (${x.mancanti.length} mancanti)` : ''}`),
      erroreCopertura: ric && ric.errore ? ric.errore : null,
    });
    if (!(idScelto != null && latiDopoMorte && latiDopoMorte.no === 0 && lati(idScelto).no > 0)) {
      blocca('passo 13', idScelto == null ? 'nessun mercato coperto sui due lati da cui uccidere un lato'
        : `il lato NO ucciso non e' tornato a libro (lati dopo il ripristino: ${JSON.stringify(lati(idScelto))})`,
      'agents/agent41-realloc-scheduler.js (riconciliaCopertura → ripristinaGamba) + lib/maker/ripristino-gambe.js');
    }
  }

  // ══ PASSO 14 · POSIZIONE SPARITA SENZA UN NOSTRO ORDINE: ALLARME ════════════════════════════════
  // ⚠ SU SLATE PULITO E CON agent40 RICARICATO: i due presidi vivono su memoria di modulo
  // (`posizioniPrecedenti`, `nostriInvii`), e un avanzo di una fase precedente SPEGNE l'allarme.
  if (!bloccato) {
    const daQui14 = codaGiornale().length;
    const buttato14 = VENUE.azzera('prima del presidio sulle sparizioni');
    const via40 = require.resolve(path.join(ROOT, 'agents/agent40-manual-reprice'));
    delete require.cache[via40];
    const A40F = require(via40);
    const M8 = `0x${'b8'.repeat(32)}`;
    const m8 = VENUE.creaMercato({ conditionId: M8, mid: 0.40, tick: 0.01, minSize: 20, bandaCents: 4.5,
      oreAllaScadenza: 60, question: 'banco · sparizione' });
    VENUE.posizioni.set(m8.tokenId, { size: 60, costoTotale: 60 * 0.38, nascondiPerCicli: 0 });
    await A40F.sparizioneTask({ now: () => OROLOGIO.ora }).catch(() => {});   // fotografa
    await A40F.sorveglianzaTask({ now: () => OROLOGIO.ora }).catch(() => {});
    VENUE.avanza(3 * 60_000);
    const rs = await A40F.sorveglianzaTask({ now: () => OROLOGIO.ora }).catch((e) => ({ errore: e.message }));
    VENUE.sparizioneEsterna(m8.tokenId, 60);
    VENUE.avanza(60_000);
    await A40F.sparizioneTask({ now: () => OROLOGIO.ora }).catch(() => {});
    const dopo14 = codaGiornale().slice(daQui14).map((x) => x.outcome);
    passo('14 · posizione sparita senza un nostro ordine → ALLARME', {
      ok: dopo14.includes('posizione-uscita-senza-nostro-ordine'),
      resetPrima: buttato14,
      anomalieSorveglianza: rs && rs.anomalie ? rs.anomalie.length : null,
      esitiPresidi: dopo14.filter((o) => /posizione-/.test(String(o))),
    });
    if (!dopo14.includes('posizione-uscita-senza-nostro-ordine')) {
      blocca('passo 14', 'la sparizione non nostra non ha prodotto l\'allarme',
        'agents/agent40-manual-reprice.js:1091 (sparizioneTask) + lib/maker/sparizioni-non-spiegate.js');
    }
  }

  // ══ PASSO 15 · FEED CHE TACE · avgPrice NON PUBBLICATO · RIFIUTO POST-ONLY ══════════════════════
  // Tre fatti del venue in un passo solo, perche' sono tre modi in cui il bot deve NON fidarsi. Ognuno
  // arriva all'esecuzione: la cancellazione per mid stantio, il carico di ripiego, il rifiuto del venue.
  if (!bloccato) {
    const M9 = `0x${'c9'.repeat(32)}`;
    const m9 = VENUE.creaMercato({ conditionId: M9, mid: 0.40, tick: 0.01, minSize: 20, bandaCents: 4.5,
      oreAllaScadenza: 60, question: 'banco · feed e post-only' });
    MM.setManualMode({ marketId: M9, manual: true, by: 'banco', reason: 'passo 15' });
    ARC.setAutoReprice({ scope: 'market', marketId: M9, enabled: true, by: 'banco', reason: 'passo 15' });
    ACC.setAutoClose({ scope: 'market', marketId: M9, enabled: true, by: 'banco', reason: 'passo 15' });
    const daQui15 = codaGiornale().length;

    // ① RIFIUTO POST-ONLY: un BUY che incrocia l'ask viene RIFIUTATO dal venue, non eseguito.
    const primaRifiuti = VENUE.eventi.filter((e) => e.tipo === 'rifiuto-post-only').length;
    await MO.placeManualOrder({ marketId: M9, book: 'yes', side: 'BUY', price: 0.44, size: 40,
      userId: 'operator', inCoda: false, allowOutOfBand: true }, {}).catch(() => ({}));
    const rifiutiPostOnly = VENUE.eventi.filter((e) => e.tipo === 'rifiuto-post-only').length - primaRifiuti;

    // ② avgPrice NON PUBBLICATO: si riempie una gamba con il venue che nasconde il carico per un ciclo.
    VENUE.scenari.avgPriceNascostoPerCicli = 2;
    await MO.placeManualOrder({ marketId: M9, book: 'yes', side: 'BUY', price: 0.38, size: 40,
      userId: 'operator', inCoda: true }, {}).catch(() => ({}));
    const g15 = VENUE.ordiniVivi(M9).find((o) => o.side === 'BUY' && o.tokenId === m9.tokenId);
    if (g15) VENUE.riempi(g15.orderId, g15.size);
    VENUE.avanza(60_000);
    await A40.closeTask().catch(() => {});
    VENUE.scenari.avgPriceNascostoPerCicli = 0;

    // ③ FEED CHE TACE: il file del book non si aggiorna piu', il mid invecchia, gli ordini si cancellano.
    VENUE.scenari.feedTace = true;
    for (let k = 0; k < 4; k += 1) { VENUE.avanza(45 * 1000); await A40.cycle().catch(() => {}); }
    VENUE.scenari.feedTace = false;
    VENUE.pubblicaFeed();

    const dopo15 = codaGiornale().slice(daQui15).map((x) => String(x.outcome));
    const cancellatiPerCecita = VENUE.eventi.filter((e) => e.tipo === 'ordine-cancellato').length;
    passo('15 · feed muto · avgPrice assente · rifiuto post-only', {
      ok: rifiutiPostOnly > 0 && dopo15.some((o) => /carico-di-ripiego/.test(o)) && dopo15.some((o) => /stantio|cecita/.test(o)),
      rifiutiPostOnly,
      caricoDiRipiego: dopo15.filter((o) => /carico-di-ripiego/.test(o)).length,
      esitiCecita: [...new Set(dopo15.filter((o) => /stantio|cecita|mid-age/.test(o)))],
      cancellazioniTotaliAlVenue: cancellatiPerCecita,
    });
    if (!(rifiutiPostOnly > 0 && dopo15.some((o) => /carico-di-ripiego/.test(o)) && dopo15.some((o) => /stantio|cecita/.test(o)))) {
      blocca('passo 15', `manca uno dei tre: post-only ${rifiutiPostOnly}, carico-di-ripiego ${dopo15.filter((o) => /carico-di-ripiego/.test(o)).length}, cecita ${[...new Set(dopo15.filter((o) => /stantio|cecita/.test(o)))].join('/') || 0}`,
        'lib/maker/mid-stantio.js · lib/maker/carico-di-ripiego (auto-close) · il rifiuto post-only e\' del venue');
    }
  }

  // ══ PASSO 16 · SCADENZA DEL MERCATO: IL PERIMETRO SI RESTRINGE DA SOLO ══════════════════════════
  // La regola nuova di oggi: la scadenza toglie il mercato dal perimetro senza aspettare il ciclo da 6 h.
  // Il passo arriva all'esecuzione quando il mercato E' USCITO dalla allowlist.
  if (!bloccato) {
    const M10 = `0x${'d0'.repeat(32)}`;
    VENUE.creaMercato({ conditionId: M10, mid: 0.40, tick: 0.01, minSize: 20, bandaCents: 4.5,
      oreAllaScadenza: 2, question: 'banco · scade fra due ore' });
    ARC.setAutoReprice({ scope: 'market', marketId: M10, enabled: true, by: 'banco', reason: 'passo 16' });
    const primaPerimetro = (ARC.readAutoRepriceConfig({}).liveMinMarketIds || []).length;
    const eraDentro = (ARC.readAutoRepriceConfig({}).enabledMarketIds || []).map((x) => x.toLowerCase()).includes(M10.toLowerCase());
    let sc = null;
    try { sc = await A41.scadenzeFuoriPerimetro(); } catch (e) { sc = { errore: e.message }; }
    const restaDentro = (ARC.readAutoRepriceConfig({}).enabledMarketIds || []).map((x) => x.toLowerCase()).includes(M10.toLowerCase());
    // E il mercato CHIUSO al venue: `closeTask` deve ripulire i registri invece di riprovare per sempre.
    VENUE.chiudiMercato(M10);
    const daQui16 = codaGiornale().length;
    VENUE.avanza(60_000);
    await A40.closeTask().catch(() => {});
    const dopo16 = codaGiornale().slice(daQui16).map((x) => String(x.outcome));
    passo('16 · la scadenza toglie il mercato dal perimetro', {
      ok: eraDentro && !restaDentro,
      eraDentro, restaDentro,
      perimetroPrima: primaPerimetro,
      perimetroDopo: (ARC.readAutoRepriceConfig({}).liveMinMarketIds || []).length,
      rilasciati: sc && sc.rilasciati ? sc.rilasciati.map((x) => `${x.id.slice(0, 12)} (${x.oreResidue} h)`) : (sc && sc.errore) || null,
      motivoAstensione: sc && !((sc.rilasciati || []).length) ? sc.motivo : null,
      esitiMercatoChiuso: [...new Set(dopo16.filter((o) => /chius|closed|market/.test(o)))].slice(0, 6),
    });
    if (!(eraDentro && !restaDentro)) {
      blocca('passo 16', `il mercato a 2 h dalla scadenza non e' uscito dal perimetro (${(sc && sc.motivo) || 'senza motivo'})`,
        'lib/maker/scadenza-fuori-perimetro.js + agents/agent41-realloc-scheduler.js (scadenzeFuoriPerimetro)');
    }
  }

  // ══ PASSO 17 · IL KILL A −$100 CANCELLA ═════════════════════════════════════════════════════════
  // ⚠ LA MISURA E' INIETTATA, L'AZIONE NO, e la distinzione e' tutto il valore del passo: `readUsage`
  // legge la perdita realizzata dal registro dei fill, e i fill del banco non arrivano in quel registro
  // (ci arrivano dalla riconciliazione della corsia manuale, che qui non gira). Quindi si INIETTA il
  // NUMERO — la perdita — e si lascia di produzione tutto il resto: la soglia dal file dei limiti, la
  // decisione, la spazzata (`cancelAllOrders` vero, che passa dall'adapter di cancellazione sostituito) e
  // il FERMA. Il passo arriva all'esecuzione quando gli ordini a libro sono ZERO e il bot e' FERMO.
  if (!bloccato) {
    const M11 = `0x${'e1'.repeat(32)}`;
    VENUE.creaMercato({ conditionId: M11, mid: 0.40, tick: 0.01, minSize: 20, bandaCents: 4.5,
      oreAllaScadenza: 60, question: 'banco · kill a -100' });
    MM.setManualMode({ marketId: M11, manual: true, by: 'banco', reason: 'passo 17' });
    ARC.setAutoReprice({ scope: 'market', marketId: M11, enabled: true, by: 'banco', reason: 'passo 17' });
    await MO.placeManualOrder({ marketId: M11, book: 'yes', side: 'BUY', price: 0.38, size: 40,
      userId: 'operator', inCoda: true }, {}).catch(() => ({}));
    await MO.placeManualOrder({ marketId: M11, book: 'no', side: 'BUY', price: 0.58, size: 40,
      userId: 'operator', inCoda: true }, {}).catch(() => ({}));
    const ordiniPrimaDelKill = VENUE.ordiniVivi().length;
    const A43 = require(path.join(ROOT, 'agents/agent43-guardian'));
    const LIM = require(path.join(ROOT, 'lib/safety/risk-limits'));
    const tetto = LIM.resolveLimits({ userId: 'operator' });
    let esito17 = null;
    try {
      esito17 = await A43.poll({
        now: () => OROLOGIO.ora,
        stato: null,                                   // nessun latch
        // ⚠ L'UNICA INIEZIONE: il NUMERO. La soglia arriva dal file vero, l'azione e' quella vera.
        readUsage: () => ({ realisedDailyPnlUsd: -(Number(tetto.maxDailyLossUsd) + 20) }),
        buildCancelCredsProviders: async () => ({ polymarket: async () => ({ creds: { key: 'banco' }, address: '0xbanco' }) }),
      });
    } catch (e) { esito17 = { errore: e.message }; }
    const ordiniDopoIlKill = VENUE.ordiniVivi().length;
    const botDopo = BOT.statoBot();
    passo('17 · kill a −$100: CANCELLA gli ordini e mette FERMA', {
      ok: esito17 && esito17.azione === 'scattato-perdita-giornaliera' && ordiniDopoIlKill === 0 && botDopo.enabled === false,
      tettoDalFile: tetto.maxDailyLossUsd, perditaIniettata: -(Number(tetto.maxDailyLossUsd) + 20),
      azione: esito17 && (esito17.azione || esito17.errore),
      ordiniPrima: ordiniPrimaDelKill, ordiniDopo: ordiniDopoIlKill,
      ordiniCancellatiDalReferto: esito17 && esito17.ordiniCancellati,
      botFermo: botDopo.enabled === false, motivoFerma: botDopo.reason || null,
    });
    if (!(esito17 && esito17.azione === 'scattato-perdita-giornaliera' && ordiniDopoIlKill === 0 && botDopo.enabled === false)) {
      blocca('passo 17', `il kill non ha cancellato e fermato: azione='${esito17 && (esito17.azione || esito17.errore)}', ordini ${ordiniPrimaDelKill}→${ordiniDopoIlKill}, bot ${botDopo.enabled ? 'AVVIATO' : 'fermo'}`,
        'agents/agent43-guardian.js (poll → spazzaEFerma) + lib/maker/kill-perdita-giornaliera.js');
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
