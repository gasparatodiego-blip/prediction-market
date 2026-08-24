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
// ⚠ DUE MODI DI DICHIARARE UN PASSO CHE NON ARRIVA IN FONDO, e la differenza e' una decisione
// dell'operatore (17 agosto 2026): «se uno non arriva in fondo, annota file:riga e vai avanti col
// successivo». `blocca` ferma il giro — si usa dove il passo dopo dipende da quello prima e proseguire
// misurerebbe uno stato che in produzione non esiste. `annota` registra e lascia continuare: si usa dove i
// passi sono INDIPENDENTI (14-17 costruiscono ognuno il proprio mercato), e li' fermarsi al primo
// nasconderebbe gli altri tre.
const annotati = [];
function annota(dove, perche, riferimento) {
  annotati.push({ dove, perche, riferimento });
  console.log(`\n🟠 ${dove} NON ARRIVA IN FONDO (il giro prosegue)`);
  console.log(`   perche': ${perche}`);
  if (riferimento) console.log(`   dove:    ${riferimento}`);
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
    // ⚠ `maker-allocated-capital.json` E' L'UNDICESIMO, ED E' STATO AGGIUNTO IL 17 AGOSTO 2026. E' la
    // fotografia dei tetti per mercato, cioe' la MEMORIA DI UN PIANO PRECEDENTE esattamente come i dieci
    // qui sopra — ed era l'unica memoria di quel tipo a sopravvivere all'«accensione da zero».
    // Conseguenza misurata confrontando due snapshot di `data/`: con 2 mercati in fotografia il giro
    // esercitava `saltato-prezzo-non-piazzabile` e `saltato-tetto-saturo`, con 3 esercitava invece
    // `saltato-tetto-non-leggibile` — 16 forme dinamiche contro 15, sullo stesso codice. Il giro
    // arrivava in fondo in entrambi i casi (18/18), ma **il conteggio delle regole non era confrontabile
    // fra due giorni diversi**, e un conteggio che cambia da solo non e' una misura: e' rumore che
    // qualcuno prima o poi legge come regressione.
    for (const f of ['realloc-ultimo-piano.json', 'maker-auto-reprice-state.json', 'realloc-pools.json',
      'modalita-chiusura.json', 'attesa-merge.json', 'residui-scoperti.json', 'da-ripianificare.json',
      'quarantena-venue.json', 'presidio-posizioni.json', 'idempotenza-ordini.json',
      'maker-allocated-capital.json']) {
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
  // `riconciliaCopertura` → `ripristinaGamba` → `coppia-simmetrica`. Il passo arriva in fondo quando la
  // coppia e' TORNATA A LIBRO, simmetrica e sotto il tetto per mercato.
  //
  // ═══ IL SOGGETTO SE LO COSTRUISCE, E QUESTA E' LA CORREZIONE DEL 17 AGOSTO 2026 ══════════════════
  // Fino a ieri il passo prendeva `candidati13[0]`, cioe' **il primo mercato coperto sui due lati** che
  // trovava iterando gli ordini vivi. Quell'ordine dipende da tutto quello che e' successo prima —
  // `data/` compreso — e con lo snapshot del 17 agosto sera pescava **M6, il mercato del passo 12 «il
  // merge che FALLISCE»**: posizione aperta, macchina di chiusura in corso, un `SELL 40×0,52` a libro e
  // NESSUNA riga nel piano salvato. Il ripristino rispondeva correttamente «nessuna riga nel piano
  // salvato per questo mercato: si dichiara e NON si ricalcola» (§5-bis p.171, una delle tre cose che
  // quel presidio NON fa di proposito), e lo scenario chiamava fallimento un rifiuto giusto.
  //
  // ⚠ E IL «18 SU 18» DI IERI ERA VERO PER QUELLO SNAPSHOT DI `data/`, NON PER IL CODICE: misurato
  // rigiocando lo stesso passo sul commit precedente — cadeva IDENTICO, stesso conteggio. E' la classe
  // «test che fotografa lo stato invece della proprieta'» (§5.3), la quarta volta in questo repo.
  //
  // ⚠ E FILTRARE I CANDIDATI NON BASTAVA, provato: togliendo i mercati con posizione e con chiusura in
  // corso restava comunque **solo M6**, perche' a quel punto del giro e' l'unico coperto sui due lati.
  // Un filtro che lascia un candidato solo non e' una scelta: e' lo stesso pescaggio con piu' righe.
  //
  // LA CURA E' LA STESSA DEI PASSI 14-17: **il passo si costruisce il proprio mercato e lo apre dal
  // percorso di produzione**. Azzera il venue, riporta la selezione e il piano allo stato vuoto, crea UN
  // mercato pulito e lascia che sia `controlloCapitaleFermo()` ad aprirci sopra la coppia — cosi' la
  // riga nel piano c'e' perche' l'ha scritta il pianificatore vero, non perche' l'abbiamo messa noi.
  // Da qui in poi il passo non dipende ne' da `data/` ne' dai passi precedenti.
  if (!bloccato) {
    const M13 = `0x${'13'.repeat(32)}`;
    VENUE.azzera('passo 13 · il soggetto se lo costruisce');
    // Lo stato che deciderebbe al posto nostro: selezione e piano tornano vuoti, come al passo 1. Senza,
    // il mini-ciclo sceglierebbe fra i mercati dei passi precedenti — che non esistono piu' al venue.
    for (const id of (ARC.readAutoRepriceConfig({}).enabledMarketIds || [])) {
      ARC.setAutoReprice({ scope: 'market', marketId: id, enabled: false, by: 'banco', reason: 'passo 13' });
    }
    SEL.scriviStato({ ...SELM.statoVuoto(), attiva: true }, { by: 'banco', reason: 'passo 13' });
    for (const f of ['realloc-ultimo-piano.json', 'maker-auto-reprice-state.json', 'modalita-chiusura.json',
      'attesa-merge.json', 'residui-scoperti.json', 'da-ripianificare.json', 'quarantena-venue.json']) {
      try { fs.unlinkSync(path.join(ROOT, 'data', f)); } catch { /* gia' assente */ }
    }
    VENUE.creaMercato({ conditionId: M13, mid: 0.40, tick: 0.01, minSize: 20, bandaCents: 4.5,
      oreAllaScadenza: 60, question: 'banco · gamba morta' });
    BOT.impostaBot({ enabled: true, by: 'banco', reason: 'passo 13' });

    // ⚠ SERVONO TUTTI E DUE I CICLI, E L'ORDINE NON E' INDIFFERENTE — misurato il 17 agosto.
    // `ripristinaGamba` pretende una riga nel PIANO SALVATO (`realloc-ultimo-piano.json`), e quel file
    // lo scrive **solo il ciclo pesante**: `pianoLeggero` del mini-ciclo dichiara di non scriverlo
    // («un piano calcolato su sei ore di storico non deve poter sostituire la memoria di uno calcolato
    // su quarantotto», agent41:703). Aprendo la coppia col solo `controlloCapitaleFermo` il passo
    // otteneva due gambe a libro e ZERO righe nel piano, quindi il ripristino rispondeva — di nuovo
    // correttamente — «nessuna riga nel piano salvato». Era la stessa diagnosi di prima con un'altra
    // causa: non il soggetto sbagliato, ma la MEMORIA mancante.
    // Quindi: prima `giro()`, che calcola il piano da 6 h e lo SALVA; poi il trigger, che apre.
    let pesante = null;
    try { pesante = await A41.giro('banco · passo 13'); }
    catch (e) { pesante = { errore: e.message }; }
    let apertura = null;
    try { apertura = await A41.controlloCapitaleFermo({ forzatoDa: 'banco · passo 13' }); }
    catch (e) { apertura = { errore: e.message }; }
    const lati = (id) => {
      const o = VENUE.ordiniVivi(id); const m = VENUE.mercato(id);
      return { yes: o.filter((x) => x.tokenId === m.tokenId).length, no: o.filter((x) => x.tokenId === m.tokenIdNo).length };
    };
    const latiPrima = lati(M13);
    const gambePrima = VENUE.ordiniVivi(M13);
    const rigaPiano = (() => {
      try {
        const pl = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'realloc-ultimo-piano.json'), 'utf8'));
        return (pl.righe || []).find((r) => String(r.marketId || '').toLowerCase() === M13) || null;
      } catch { return null; }
    })();

    // ⚠ SE LA COPPIA NON NASCE, IL PASSO NON PROSEGUE: uccidere un lato che non c'e' e poi osservare che
    // non torna misurerebbe l'apertura, non il ripristino — e lo chiamerebbe passo 13.
    if (latiPrima.yes === 0 || latiPrima.no === 0) {
      passo('13 · gamba morta → la COPPIA ricostruita, simmetrica e sotto il tetto', {
        ok: false, mercato: M13.slice(0, 12), latiPrima,
        pesanteEsito: pesante && (pesante.azione || pesante.errore || 'nessun esito'),
        aperturaEsito: apertura && (apertura.esito || apertura.errore || 'nessun esito'),
        aperturaMotivo: String((apertura && (apertura.motivo || apertura.errore)) || '').slice(0, 240),
        rigaDelPiano: rigaPiano ? 'presente' : null,
        nota: 'la coppia non e\' nata: il passo NON uccide un lato inesistente',
      });
      annota('passo 13', `la coppia non e' nata sul mercato del passo (${JSON.stringify(latiPrima)}): non si uccide un lato che non c'e'`,
        'agents/agent41-realloc-scheduler.js (controlloCapitaleFermo → miniCiclo)');
    } else {
      // ⚠ SI UCCIDE TUTTO UN LATO, non un ordine solo. La prima stesura ne uccideva uno e misurava
      // «gambe dopo > gambe prima»: se il mercato aveva un DOPPIONE la riconciliazione lo rimuoveva —
      // cosa giusta — e il conteggio SCENDEVA mentre la copertura era perfetta. Il criterio non e'
      // quante gambe ci sono: e' se i DUE LATI sono coperti.
      const m = VENUE.mercato(M13);
      for (const o of VENUE.ordiniVivi(M13)) if (o.tokenId === m.tokenIdNo) VENUE.cancelOrder(o.orderId);
      const latiDopoMorte = lati(M13);
      const gambeDopoMorte = VENUE.ordiniVivi(M13).length;

      // ⚠ IL GIORNALE SI LEGGE DALL'OFFSET, non con `slice(-3)`: gli ultimi tre record possono venire da
      // un passo precedente, e allora «rimessa» racconterebbe un ripristino che non e' questo. Era il
      // secondo difetto di questo passo, ed e' la stessa lezione della lettura stantia del referto.
      const fileGiornale41 = path.join(ROOT, 'data', 'realloc-scheduler.jsonl');
      const offset41 = (() => {
        try { return fs.readFileSync(fileGiornale41, 'utf8').split('\n').length; } catch { return 0; }
      })();

      VENUE.avanza(120_000);
      let ric = null;
      try { ric = await A41.riconciliaCopertura(); } catch (e) { ric = { errore: e.message }; }
      const gambeDopoRipristino = VENUE.ordiniVivi(M13).length;
      const giornale13 = (() => {
        try {
          return fs.readFileSync(fileGiornale41, 'utf8').split('\n').slice(offset41 - 1)
            .map((l) => { try { return JSON.parse(l); } catch { return {}; } })
            .filter((x) => x.tipo === 'ripristino-gamba');
        } catch { return []; }
      })();
      const vivi13 = VENUE.ordiniVivi(M13);

      // ⚠ IL CRITERIO E' LA COPPIA, NON LA GAMBA — 17 agosto 2026, decisione dell'operatore. Fino a ieri
      // bastava «il lato NO e' tornato a libro»: e' un criterio che si accontenta di un ripristino
      // ASIMMETRICO, cioe' esattamente lo stato che sfondava il tetto. Adesso si pretendono tre cose
      // insieme — il lato e' tornato, le due size sono UGUALI, e il totale sta sotto il tetto per mercato.
      const TETTO13 = require(path.join(ROOT, 'lib/rewards/concentration')).MARKET_CAP_FIXED_USD;
      const coppia13 = (() => {
        const mm = VENUE.mercato(M13);
        const o = VENUE.ordiniVivi(M13);
        const y = o.filter((x) => x.tokenId === mm.tokenId);
        const n = o.filter((x) => x.tokenId === mm.tokenIdNo);
        if (y.length !== 1 || n.length !== 1) return { simmetrica: false, motivo: `${y.length} gamba/e YES e ${n.length} NO: non e' una coppia` };
        const tot = +(y[0].size * y[0].price + n[0].size * n[0].price).toFixed(4);
        return { simmetrica: Math.abs(y[0].size - n[0].size) <= 0.011, sizeYes: y[0].size, sizeNo: n[0].size,
          prezzoYes: y[0].price, prezzoNo: n[0].price, totaleUsd: tot, tettoUsd: TETTO13, sottoIlTetto: tot <= TETTO13 + 1e-6 };
      })();
      const verde = latiDopoMorte.no === 0 && lati(M13).no > 0
        && !!(coppia13 && coppia13.simmetrica && coppia13.sottoIlTetto);
      passo('13 · gamba morta → la COPPIA ricostruita, simmetrica e sotto il tetto', {
        ok: verde,
        coppiaDopoIlRipristino: coppia13,
        mercato: M13.slice(0, 12),
        // Il soggetto e' COSTRUITO, e va detto: chi rilegge deve sapere che non e' stato pescato.
        soggetto: 'costruito dal passo e aperto da controlloCapitaleFermo — indipendente da data/',
        latiPrima, latiDopoLaMorte: latiDopoMorte, latiDopoIlRipristino: lati(M13),
        gambePrima: gambePrima.length, dopoLaMorte: gambeDopoMorte, dopoIlRipristino: gambeDopoRipristino,
        esitiRipristino: giornale13.map((x) => `${x.esito}${x.mancanti ? ` (${x.mancanti.length} mancanti)` : ''}`),
        motiviRipristino: giornale13.map((x) => String(x.motivo || '').slice(0, 200)),
        ordiniARiposoOra: vivi13.map((o) => `${o.side} ${o.tokenId.slice(0, 8)} ${o.size}×${o.price} = $${(o.size * o.price).toFixed(2)}`),
        rigaDelPiano: rigaPiano ? { capitaleUsd: rigaPiano.capitalUsd ?? rigaPiano.capitale ?? null,
          size: rigaPiano.size ?? null, pYes: rigaPiano.priceYes ?? rigaPiano.pYes ?? null, pNo: rigaPiano.priceNo ?? rigaPiano.pNo ?? null } : null,
        erroreCopertura: ric && ric.errore ? ric.errore : null,
      });
      if (!verde) {
        annota('passo 13', lati(M13).no === 0
          ? `il lato NO ucciso non e' tornato a libro (lati dopo il ripristino: ${JSON.stringify(lati(M13))})`
          : `il lato e' tornato ma la coppia non e' simmetrica o sfonda il tetto: ${JSON.stringify(coppia13)}`,
        'agents/agent41-realloc-scheduler.js (riconciliaCopertura → ripristinaGamba → coppia-simmetrica) + lib/maker/coppia-simmetrica.js');
      }
    }
  }
  // ══ PASSO 14 · POSIZIONE SPARITA SENZA UN NOSTRO ORDINE: ALLARME ════════════════════════════════
  // ⚠ Da qui in giu' la guardia NON e' `!bloccato` ma `!bloccato`: i passi 14-17 costruiscono ognuno il
  // proprio mercato e non dipendono dal 13. Se il 13 e' stato ANNOTATO il giro prosegue.
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
      annota('passo 14', 'la sparizione non nostra non ha prodotto l\'allarme',
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
    // ⚠ SI ACCENDE LA CORSA, e non e' un trucco: un `post-only` ben calcolato puo' incrociare SOLO se il
    // book si muove fra la lettura e la POST. Tutti i gate del bot esistono per non farlo capitare, quindi
    // senza la corsa questo esito e' irraggiungibile per costruzione — e dichiararlo «rosso» sarebbe
    // dichiarare rossa una difesa che funziona.
    VENUE.scenari.muoviIlBookDurantePostOrder = true;
    await MO.placeManualOrder({ marketId: M9, book: 'yes', side: 'BUY', price: 0.39, size: 40,
      userId: 'operator', inCoda: true }, {}).catch(() => ({}));
    VENUE.scenari.muoviIlBookDurantePostOrder = false;
    VENUE.pubblicaFeed();
    const rifiutiPostOnly = VENUE.eventi.filter((e) => e.tipo === 'rifiuto-post-only').length - primaRifiuti;

    // ② avgPrice NON PUBBLICATO. ⚠ IL FILL DEVE ESSERE PARZIALE, e il perche' e' una scoperta di questo
    // banco: `carico-di-ripiego` ha DUE livelli di ripiego, e solo il primo e' raggiungibile in
    // produzione. Il primo e' `residuo-a-libro` — il prezzo di un nostro ordine ANCORA a riposo sullo
    // stesso token; il secondo e' `ultimo-ordine-nostro`, che legge `deps.ultimoNostroPrezzo` — e
    // NESSUNO PASSA QUELLA DEP (`closeTask` non la cabla). Con un fill TOTALE non resta niente a libro,
    // nessuno dei due livelli ha un dato, e l'uscita esce a `skip-no-entry-price`: e' cio' che questo
    // passo misurava alla prima stesura, accusando il carico di ripiego di non scattare.
    VENUE.scenari.avgPriceNascostoPerCicli = 3;
    await MO.placeManualOrder({ marketId: M9, book: 'yes', side: 'BUY', price: 0.38, size: 40,
      userId: 'operator', inCoda: true }, {}).catch(() => ({}));
    const g15 = VENUE.ordiniVivi(M9).find((o) => o.side === 'BUY' && o.tokenId === m9.tokenId);
    const fillato15 = !!g15;
    if (g15) VENUE.riempi(g15.orderId, g15.size * 0.5);   // METÀ: il residuo resta a libro
    VENUE.avanza(60_000);
    await A40.closeTask().catch(() => {});
    VENUE.scenari.avgPriceNascostoPerCicli = 0;

    // ③ FEED CHE TACE: il file del book non si aggiorna piu', il mid invecchia, gli ordini si cancellano.
    // ⚠ SERVE UN ORDINE VIVO DURANTE IL SILENZIO: alla prima stesura il fill totale aveva svuotato il
    // libro, e `mid-stantio` non aveva niente da cancellare. Adesso il residuo del fill parziale e' la',
    // e se non bastasse se ne aggiunge uno sull'altro lato.
    if (!VENUE.ordiniVivi(M9).length) {
      await MO.placeManualOrder({ marketId: M9, book: 'no', side: 'BUY', price: 0.58, size: 40,
        userId: 'operator', inCoda: true }, {}).catch(() => ({}));
    }
    const viviPrimaDelSilenzio = VENUE.ordiniVivi(M9).length;
    VENUE.scenari.feedTace = true;
    for (let k = 0; k < 4; k += 1) { VENUE.avanza(45 * 1000); await A40.cycle().catch(() => {}); }
    VENUE.scenari.feedTace = false;
    VENUE.pubblicaFeed();

    const dopo15 = codaGiornale().slice(daQui15).map((x) => String(x.outcome));
    const cancellatiPerCecita = VENUE.eventi.filter((e) => e.tipo === 'ordine-cancellato').length;
    passo('15 · feed muto · avgPrice assente · rifiuto post-only', {
      ok: rifiutiPostOnly > 0 && dopo15.some((o) => /carico-di-ripiego/.test(o)) && dopo15.some((o) => /stantio|cecita/.test(o)),
      rifiutiPostOnly,
      tuttiGliEsiti: [...new Set(dopo15)].slice(0, 22),
      caricoDiRipiego: dopo15.filter((o) => /carico-di-ripiego/.test(o)).length,
      esitiCecita: [...new Set(dopo15.filter((o) => /stantio|cecita|mid-age/.test(o)))],
      cancellazioniTotaliAlVenue: cancellatiPerCecita,
      gambaRiempita: fillato15, viviPrimaDelSilenzio, ordiniViviSuM9: VENUE.ordiniVivi(M9).length,
      posizioneSuM9: Number((VENUE.posizioni.get(m9.tokenId) || {}).size || 0),
    });
    if (!(rifiutiPostOnly > 0 && dopo15.some((o) => /carico-di-ripiego/.test(o)) && dopo15.some((o) => /stantio|cecita/.test(o)))) {
      annota('passo 15', `manca uno dei tre: post-only ${rifiutiPostOnly}, carico-di-ripiego ${dopo15.filter((o) => /carico-di-ripiego/.test(o)).length}, cecita ${[...new Set(dopo15.filter((o) => /stantio|cecita/.test(o)))].join('/') || 0}`,
        'lib/maker/mid-stantio.js · lib/maker/carico-di-ripiego (auto-close) · il rifiuto post-only e\' del venue');
    }
  }

  // ══ PASSO 15-bis · IL SECONDO LIVELLO DEL CARICO DI RIPIEGO, CON UN FILL TOTALE ═════════════════
  // §5.2 p.41, chiusa la sera del 17 agosto. Il passo 15 prova il livello ① (`residuo-a-libro`) e per
  // farlo deve usare un fill PARZIALE. Il livello ② (`ultimo-ordine-nostro`) e' il caso opposto — fill
  // TOTALE, niente a libro, `avgPrice` non pubblicato — e non era raggiungibile perche' nessuno passava
  // `deps.ultimoNostroPrezzo`. Adesso `closeTask` la cabla su `ultimo-nostro-prezzo`, che legge il
  // GIORNALE, e questo passo lo dimostra sull'unica cosa che conta: la FONTE dichiarata a verbale.
  //
  // ⚠ NON BASTA CHE ESCA `carico-di-ripiego`: il passo 15 lo produce gia' col livello ①. Si pretende
  // `fonte: 'ultimo-ordine-nostro'`, cioe' il livello che prima non poteva scattare.
  if (!bloccato) {
    const M9b = `0x${'cb'.repeat(32)}`;
    const m9b = VENUE.creaMercato({ conditionId: M9b, mid: 0.40, tick: 0.01, minSize: 20, bandaCents: 4.5,
      oreAllaScadenza: 60, question: 'banco · carico di ripiego, secondo livello' });
    MM.setManualMode({ marketId: M9b, manual: true, by: 'banco', reason: 'passo 15-bis' });
    ARC.setAutoReprice({ scope: 'market', marketId: M9b, enabled: true, by: 'banco', reason: 'passo 15-bis' });
    ACC.setAutoClose({ scope: 'market', marketId: M9b, enabled: true, by: 'banco', reason: 'passo 15-bis' });
    const daQui15b = codaGiornale().length;
    // ⚠ LO SCENARIO SI ACCENDE PRIMA DEL FILL, NON PRIMA DEL CICLO, e la prima stesura sbagliava proprio
    // qui: `VENUE.riempi` fotografa `avgPriceNascostoPerCicli` NEL MOMENTO in cui crea la posizione
    // (`banco-ciclo-completo.js:414`), quindi accenderlo dopo il fill non nasconde niente — il venue
    // pubblicava il carico e il ripiego non serviva. Il passo dichiarava rossa una difesa cablata.
    VENUE.scenari.avgPriceNascostoPerCicli = 3;
    const r15b = await MO.placeManualOrder({ marketId: M9b, book: 'yes', side: 'BUY', price: 0.38, size: 40,
      userId: 'operator', inCoda: true }, {}).catch((e) => ({ ok: false, reason: e.message }));
    const g15b = VENUE.ordiniVivi(M9b).find((o) => o.side === 'BUY' && o.tokenId === m9b.tokenId);
    // ⚠ IL PREZZO CHE SI ASPETTA E' QUELLO DELL'ORDINE VERO, non lo 0,38 chiesto: `inCoda` lo sposta un
    // tick dietro al miglior prezzo altrui, e il giornale registra il prezzo MANDATO. Leggerlo dal venue
    // invece di scriverlo a mano e' la differenza fra provare il cablaggio e provare la propria aritmetica.
    const prezzoMandato = g15b ? g15b.price : null;
    if (g15b) VENUE.riempi(g15b.orderId, g15b.size);        // TOTALE: a libro non resta niente
    const restaALibro = VENUE.ordiniVivi(M9b).length;
    VENUE.avanza(60_000);
    await A40.closeTask().catch(() => {});
    VENUE.scenari.avgPriceNascostoPerCicli = 0;
    const righe15b = codaGiornale().slice(daQui15b).filter((x) => String(x.outcome) === 'carico-di-ripiego');
    const secondoLivello = righe15b.filter((x) => x.observed && x.observed.fonte === 'ultimo-ordine-nostro');
    passo('15-bis · il carico di ripiego arriva al SECONDO livello (fill totale)', {
      ok: secondoLivello.length > 0,
      piazzato: r15b.ok, gate: r15b.gate || null,
      prezzoMandatoAlVenue: prezzoMandato,
      ordiniRestatiALibro: restaALibro,
      posizioneAperta: Number((VENUE.posizioni.get(m9b.tokenId) || {}).size || 0),
      fontiViste: [...new Set(righe15b.map((x) => x.observed && x.observed.fonte))],
      caricoDichiarato: secondoLivello.map((x) => x.observed && x.observed.carico),
      // La prova indipendente: il modulo, interrogato da fuori, deve dare lo stesso prezzo.
      dalGiornale: (() => {
        try { return require(path.join(ROOT, 'lib/maker/ultimo-nostro-prezzo')).prezzoUltimoNostroBuy({ marketId: M9b, book: 'yes' }); }
        catch (e) { return `errore: ${e.message}`; }
      })(),
    });
    if (!secondoLivello.length) {
      annota('passo 15-bis', `nessun \`carico-di-ripiego\` con fonte \`ultimo-ordine-nostro\` (fonti viste: ${[...new Set(righe15b.map((x) => x.observed && x.observed.fonte))].join(', ') || 'nessuna'})`,
        'agents/agent40-manual-reprice.js (closeTask → ultimoNostroPrezzo) + lib/maker/ultimo-nostro-prezzo.js');
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
      annota('passo 16', `il mercato a 2 h dalla scadenza non e' uscito dal perimetro (${(sc && sc.motivo) || 'senza motivo'})`,
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
    // ⚠ LA FORMA E' `{ok, limits:{...}}` — e questo banco l'ha sbagliata come l'aveva sbagliata il
    // guardiano: `tetto.maxDailyLossUsd` era `undefined`, la perdita iniettata diventava `NaN`, e il passo
    // 17 falliva per colpa dello SCENARIO mentre accusava il codice. Due volte la stessa forma sbagliata
    // nello stesso pomeriggio: e' il caso da citare la prossima volta che un test inietta una fixture.
    const limRis = LIM.resolveLimits({ userId: 'operator' });
    const tetto = (limRis && limRis.limits) ? limRis.limits : limRis;
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
      annota('passo 17', `il kill non ha cancellato e fermato: azione='${esito17 && (esito17.azione || esito17.errore)}', ordini ${ordiniPrimaDelKill}→${ordiniDopoIlKill}, bot ${botDopo.enabled ? 'AVVIATO' : 'fermo'}`,
        'agents/agent43-guardian.js (poll → spazzaEFerma) + lib/maker/kill-perdita-giornaliera.js');
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // I QUATTRO PASSI DELLE REGOLE CONCORDATE CHE IL BANCO NON SAPEVA ANCORA VERIFICARE
  // (18 agosto 2026, punto E: «uno scenario per ogni regola che oggi non ha una prova»)
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  // ── PASSO 18 · R1 · QUANTI MERCATI VIENE DALL'AMBIENTE, E LA COMPOSIZIONE LO SEGUE ──────────────
  // La regola: «il numero lo decido io prima di ogni sessione. Un solo posto dove scrivere quel
  // numero, letto dai processi vivi.» Il banco non poteva dirlo: nessun passo toccava il tetto.
  // ⚠ SI PROVA LA CATENA, non il valore: ambiente → `quantiMercati` → `decidiSelezione(max)` →
  // `quotaScaglioni`. Asserire «3» sarebbe fotografare una manopola che l'operatore gira apposta.
  {
    const QUANTI = require(path.join(ROOT, 'lib/maker/quanti-mercati'));
    const board18 = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'liquidity-rewards.json'), 'utf8')).markets || []; } catch { return []; } })();
    const prove = [];
    for (const n of [1, 2, 3]) {
      const letto = QUANTI.quantiMercati({ MAKER_MERCATI_CONTEMPORANEI: String(n) });
      const quota = SELM.quotaScaglioni(letto.quanti);
      const posti = quota.reduce((a, b) => a + b.posti, 0);
      const d = SELM.decidiSelezione({ board: board18, stato: SELM.statoVuoto(),
        posizioni: { leggibile: true, conditionIds: [] }, ora: OROLOGIO.ora, max: letto.quanti,
        orizzonteMassimoOre: 24 * 150 });
      prove.push({ chiesto: n, letto: letto.quanti, fonte: letto.fonte, posti,
        entranti: d.ok ? d.entranti.length : null, ok: letto.quanti === n && posti === n && d.ok === true && d.entranti.length <= n });
    }
    // ⚠⚠ LA PROPRIETA' E' CAMBIATA IL 24 AGOSTO 2026, E IL PASSO CON LEI (R1 lo impone: chi cambia
    // una regola cambia anche il suo passo del banco, o la prova resta a difendere la regola vecchia).
    // Prima: «un valore illeggibile vale il DIFETTO, mai zero». Adesso: **non esiste piu' un difetto**
    // — un valore illeggibile SOLLEVA e il processo non parte. Il difetto era il modo in cui un errore
    // di battitura diventava una posa su capitale vero, in silenzio.
    let rotto = null;
    try { QUANTI.quantiMercati({ MAKER_MERCATI_CONTEMPORANEI: 'due' }); }
    catch (e) { rotto = e; }
    let assente = null;
    try { QUANTI.quantiMercati({}); } catch (e) { assente = e; }
    const okRotto = rotto !== null && assente !== null
      && /MAKER_MERCATI_CONTEMPORANEI/.test(String(rotto.message))
      && /MAKER_MERCATI_CONTEMPORANEI/.test(String(assente.message));
    const ok18 = prove.every((x) => x.ok) && okRotto;
    passo('18 · R1 · il tetto dei mercati viene dall\'AMBIENTE, e la composizione lo deriva', {
      ok: ok18, prove,
      valoreRotto: { grezzo: 'due', esito: rotto ? 'SOLLEVA' : 'NON HA SOLLEVATO',
        messaggio: rotto ? String(rotto.message).slice(0, 120) : null },
      variabileAssente: { esito: assente ? 'SOLLEVA' : 'NON HA SOLLEVATO' },
      ambienteDelProcesso: process.env.MAKER_MERCATI_CONTEMPORANEI ?? '(non dichiarata in questo processo)',
    });
    if (!ok18) annota('passo 18', `la catena ambiente→selezione non regge: ${JSON.stringify(prove)}`,
      'lib/maker/quanti-mercati.js + lib/maker/selezione-mercati.quotaScaglioni');
  }

  // ── PASSO 19 · R4 · L'EROSIONE TOGLIE LA GAMBA, E NESSUNO LA RIMETTE PRIMA DEL TEMPO ────────────
  // La regola: «cancella e resta fuori, tetto 5 minuti». Il pezzo che nessun test unitario puo'
  // provare e' il SECONDO: che `ripristinaGamba` — che parte SUBITO — non la rimetta a libro.
  {
    const SOSPB = require(path.join(ROOT, 'lib/maker/sospensione-erosione'));
    const M19 = '0x1919191919191919191919191919191919191919191919191919191919191919';
    // Si sospende il lato YES come farebbe agent40 dopo un'erosione confermata.
    const s0 = SOSPB.leggiStato();
    const sos = SOSPB.sospendi(s0.stato, { marketId: M19, book: 'yes', now: OROLOGIO.ora, baseline: 900, ratioPct: 8 });
    SOSPB.scriviStato(sos.stato);
    const attivaSubito = SOSPB.attiva(SOSPB.leggiStato().stato, { marketId: M19, book: 'yes', now: OROLOGIO.ora });
    const a1min = SOSPB.attiva(SOSPB.leggiStato().stato, { marketId: M19, book: 'yes', now: OROLOGIO.ora + 60_000 });
    const a5min = SOSPB.attiva(SOSPB.leggiStato().stato, { marketId: M19, book: 'yes', now: OROLOGIO.ora + SOSPB.TETTO_FUORI_MS });
    // ⚠ IL LATO OPPOSTO NON DEVE ESSERE SOSPESO: i due book sono CLOB indipendenti.
    const altroLato = SOSPB.attiva(SOSPB.leggiStato().stato, { marketId: M19, book: 'no', now: OROLOGIO.ora });
    // ⚠ E IL TETTO NON SI RINNOVA: e' la proprieta' che distingue «5 minuti per volta» da «finche' dura».
    const secondo = SOSPB.sospendi(SOSPB.leggiStato().stato, { marketId: M19, book: 'yes', now: OROLOGIO.ora + 120_000 });
    const ok19 = attivaSubito.sospeso === true && a1min.sospeso === true && a5min.sospeso === false
      && altroLato.sospeso === false && secondo.applicata === false
      && /tetto di 5 minuti scaduto/.test(a5min.motivo || '');
    passo('19 · R4 · la gamba tolta per erosione resta fuori 5 minuti, e il rientro per tetto si dichiara', {
      ok: ok19, sospesaSubito: attivaSubito.sospeso, restaSec: attivaSubito.restaSec,
      dopo1min: a1min.sospeso, dopo5min: a5min.sospeso, motivoRientro: a5min.motivo,
      latoOppostoSospeso: altroLato.sospeso, tettoRinnovato: secondo.applicata,
      frenoSec: SOSPB.FRENO_MS / 1000, tettoMin: SOSPB.TETTO_FUORI_MS / 60000,
    });
    if (!ok19) annota('passo 19', 'la sospensione per erosione non si comporta come la regola dice',
      'lib/maker/sospensione-erosione.js + agents/agent41 (riconciliaCopertura)');
    // Si ripulisce, o il passo 20 troverebbe una sospensione che non gli appartiene.
    SOSPB.scriviStato(SOSPB.rilascia(SOSPB.leggiStato().stato, { marketId: M19, book: 'yes', causa: 'pulizia' }).stato);
  }

  // ── PASSO 20 · R6 · IL RESIDUO SOTTO IL MINIMO SI CHIUDE, E NON RESTA IN CONSEGNA ───────────────
  // La regola: «si chiude sempre, anche da taker». Fino al 18 agosto il presidio dei 60 minuti lo
  // TENEVA, con un motivo che era vero fino al 17 e poi non piu'.
  {
    const PRES = require(path.join(ROOT, 'lib/maker/presidio-posizioni-vecchie'));
    const M20 = '0x2020202020202020202020202020202020202020202020202020202020202020';
    const T20 = OROLOGIO.ora - 300 * 60_000;
    const sotto = PRES.valuta({ posizioni: [{ asset: 'h20', conditionId: M20, size: 6, avgPrice: 0.5, curPrice: 0.5 }],
      ancore: { h20: T20 }, ora: OROLOGIO.ora, minSizePerMercato: { [M20]: 20 } });
    // ⚠ E LE DUE ESENZIONI CHE RESTANO vanno provate INSIEME, o si scopre di averne tolta una di troppo.
    const coppia = PRES.valuta({ posizioni: [
      { asset: 'y20', conditionId: M20, size: 6, avgPrice: 0.5, curPrice: 0.5 },
      { asset: 'n20', conditionId: M20, size: 6, avgPrice: 0.5, curPrice: 0.5 }],
      ancore: { y20: T20, n20: T20 }, ora: OROLOGIO.ora, minSizePerMercato: { [M20]: 20 } });
    const giovane = PRES.valuta({ posizioni: [{ asset: 'g20', conditionId: M20, size: 6, avgPrice: 0.5, curPrice: 0.5 }],
      ancore: { g20: OROLOGIO.ora - 10 * 60_000 }, ora: OROLOGIO.ora, minSizePerMercato: { [M20]: 20 } });
    const ok20 = sotto.daChiudere.length === 1 && sotto.daChiudere[0].sottoMinimo === true
      && coppia.daChiudere.length === 0 && giovane.daChiudere.length === 0;
    passo('20 · R6 · il residuo sotto il minimo del venue viene CHIUSO, marcato, e le due esenzioni tengono', {
      ok: ok20,
      sottoMinimoChiuso: sotto.daChiudere.length === 1, marcato: sotto.daChiudere[0] ? sotto.daChiudere[0].sottoMinimo : null,
      motivo: sotto.daChiudere[0] ? String(sotto.daChiudere[0].motivo).slice(0, 120) : null,
      coppiaCompletaNonToccata: coppia.daChiudere.length === 0,
      sottoSogliaNonToccata: giovane.daChiudere.length === 0,
    });
    if (!ok20) annota('passo 20', 'il residuo sotto il minimo non viene chiuso, o un\'esenzione si e\' persa',
      'lib/maker/presidio-posizioni-vecchie.js + agents/agent41 (prezzoUscitaAttraversata)');
  }

  // ── PASSO 21 · R10 · IL KILL NON SOLO CANCELLA: CLASSIFICA E DEPOSITA LA CHIUSURA ───────────────
  // Il passo 17 prova che il kill cancella e ferma. La META' NUOVA — «E chiude le posizioni: coppie a
  // merge, gambe scoperte vendute, gambe sotto il minimo lasciate e dichiarate» — non aveva prova.
  {
    const CHIU = require(path.join(ROOT, 'lib/maker/chiusura-di-emergenza'));
    const M21a = '0x21aa'; const M21b = '0x21bb'; const M21c = '0x21cc';
    const cl = CHIU.classifica({
      posizioni: [
        { asset: 'y21', conditionId: M21a, size: 60, curPrice: 0.5 },
        { asset: 'n21', conditionId: M21a, size: 60, curPrice: 0.5 },   // coppia completa
        { asset: 'y22', conditionId: M21b, size: 40, curPrice: 0.4 },   // gamba scoperta
        { asset: 'y23', conditionId: M21c, size: 6, curPrice: 0.5 },    // sotto il minimo
      ],
      minSizePerMercato: { [M21a]: 20, [M21b]: 20, [M21c]: 20 },
    });
    // ⚠ E IL FAIL-CLOSED: posizioni non leggibili ⇒ NESSUNA azione. In emergenza la tentazione e'
    // agire comunque, ma «non ho letto» non e' «non c'e' niente».
    const cieco = CHIU.classifica({ posizioni: null });
    const ok21 = cl.ok === true && cl.daFondere.length === 1 && cl.daVendere.length === 1
      && cl.lasciate.length === 1 && cl.lasciate[0].sottoMinimo === true
      && cieco.ok === false && cieco.daVendere.length === 0;
    passo('21 · R10 · il kill classifica le posizioni: coppia a MERGE, scoperta VENDUTA, sotto-minimo LASCIATA', {
      ok: ok21, daFondere: cl.daFondere.length, daVendere: cl.daVendere.length, lasciate: cl.lasciate.length,
      esposizioneDirezionaleUsd: cl.esposizioneDirezionaleUsd, bloccataUsd: cl.bloccataUsd,
      sottoMinimoDichiarato: cl.lasciate[0] ? cl.lasciate[0].sottoMinimo : null,
      cieco: { ok: cieco.ok, azioni: cieco.daVendere.length + cieco.daFondere.length },
    });
    if (!ok21) annota('passo 21', 'la classificazione del kill non produce i tre destini di R10',
      'lib/maker/chiusura-di-emergenza.js + agents/agent43 (spazzaEFerma) + agent41 (eseguiChiusuraDiEmergenza)');
  }

  // ── PASSO 22 · R2 · I TRE FILTRI DI SCELTA ESCLUDONO DAVVERO, SUL BOARD VERO ────────────────────
  // Il passo 8 esercita la selezione, ma non dice se i filtri MORDONO: un filtro che non toglie
  // niente e un filtro assente producono lo stesso piano. §4.13 lo ha gia' insegnato una volta — col
  // vincolo a 168 h il filtro meteo toglieva ZERO righe, e sembrava che stesse lavorando.
  {
    const board22 = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'liquidity-rewards.json'), 'utf8')).markets || []; } catch { return []; } })();
    const conta = { pavimento: 0, scadenza: 0, meteo: 0, ammissibili: 0, altro: 0 };
    for (const r of board22) {
      const v = SELM.valutaAmmissibilita(r, { ora: OROLOGIO.ora, orizzonteMassimoOre: 24 * 150 });
      if (v.ammissibile) { conta.ammissibili += 1; continue; }
      if (v.motivo === 'minsize-oltre-soglia') conta.pavimento += 1;
      else if (v.motivo === 'scadenza-troppo-vicina') conta.scadenza += 1;
      else if (v.motivo === 'famiglia-meteo') conta.meteo += 1;
      else conta.altro += 1;
    }
    // ⚠ E LE TRE PROVE COSTRUITE, che non dipendono da cosa c'e' sul board oggi: un board che per caso
    // non contiene meteo non deve poter far passare questo passo.
    const riga22 = (extra) => ({ conditionId: '0x2222', question: 'prova', category: 'economy',
      rewardsMinSize: 20, endDate: new Date(OROLOGIO.ora + 72 * 3_600_000).toISOString(), ...extra });
    const vOk = SELM.valutaAmmissibilita(riga22({}), { ora: OROLOGIO.ora, orizzonteMassimoOre: 24 * 150 });
    const vPav = SELM.valutaAmmissibilita(riga22({ rewardsMinSize: 100 }), { ora: OROLOGIO.ora, orizzonteMassimoOre: 24 * 150 });
    const vSca = SELM.valutaAmmissibilita(riga22({ endDate: new Date(OROLOGIO.ora + 6 * 3_600_000).toISOString() }), { ora: OROLOGIO.ora, orizzonteMassimoOre: 24 * 150 });
    const vMet = SELM.valutaAmmissibilita(riga22({ question: 'Highest temperature in NYC tomorrow?' }), { ora: OROLOGIO.ora, orizzonteMassimoOre: 24 * 150 });
    const vIll = SELM.valutaAmmissibilita(riga22({ rewardsMinSize: undefined }), { ora: OROLOGIO.ora, orizzonteMassimoOre: 24 * 150 });
    const ok22 = vOk.ammissibile === true
      && vPav.motivo === 'minsize-oltre-soglia' && vSca.motivo === 'scadenza-troppo-vicina'
      && vMet.motivo === 'famiglia-meteo' && vIll.motivo === 'minsize-illeggibile';
    passo('22 · R2 · i tre filtri di scelta escludono davvero (pavimento, 24 h, meteo)', {
      ok: ok22, sulBoardVero: conta,
      costruiti: { ammissibile: vOk.ammissibile, pavimento: vPav.motivo, scadenza: vSca.motivo,
        meteo: vMet.motivo, minSizeIlleggibile: vIll.motivo },
      // ⚠ `Number(null) === 0` sarebbe qui: un minSize assente NON deve valere 0 (cioe' <= 20, cioe'
      // «il piu' finanziabile di tutti»). E' l'ottava occorrenza di §5.3, gia' incontrata scrivendo
      // questo modulo, e resta esercitata dentro il giro.
      minSizeAssenteNonVale0: vIll.motivo === 'minsize-illeggibile',
    });
    if (!ok22) annota('passo 22', `un filtro di R2 non morde: ${JSON.stringify({ vPav: vPav.motivo, vSca: vSca.motivo, vMet: vMet.motivo })}`,
      'lib/maker/selezione-mercati.valutaAmmissibilita');
  }

  // ── PASSO 23 · R9 · LA SOGLIA DI SPODESTAMENTO, E LE QUATTRO CONDIZIONI ─────────────────────────
  // Il passo 8 prova che uno slot liberato si riempie. Non prova la ROTAZIONE: «sostituisce il
  // peggiore solo se il nuovo rende +$0,50/g oppure +25%», e «mai un mercato con posizione aperta,
  // coppia incompleta o ordini a riposo».
  {
    const M23 = '0x2323'; const M23n = '0x2324';
    const board23 = [
      { conditionId: M23, question: 'occupante', category: 'economy', rewardsMinSize: 50,
        endDate: new Date(OROLOGIO.ora + 72 * 3_600_000).toISOString(), levels: { 500: { grossRewardDay: 1 } } },
      { conditionId: M23n, question: 'sfidante', category: 'sports', rewardsMinSize: 50,
        endDate: new Date(OROLOGIO.ora + 72 * 3_600_000).toISOString(), levels: { 500: { grossRewardDay: 9 } } },
    ];
    const statoCon = { versione: 1, selezionati: { [M23]: { entratoAt: OROLOGIO.ora - 3_600_000,
      question: 'occupante', uscenteDal: null, motivoUscita: null, scaglione: 'alto', categoria: 'economy',
      inGestione: false, inGestioneDal: null } } };
    const base23 = { board: board23, posizioni: { leggibile: true, conditionIds: [] }, ora: OROLOGIO.ora,
      max: 1, orizzonteMassimoOre: 24 * 150 };
    // ① il margine NON basta: +$0,30 su un occupante da $1,00/g (soglia: max($0,50, 25% di 1) = $0,50)
    const stretto = SELM.decidiSelezione({ ...base23, stato: statoCon,
      nettoPerMercato: { [M23]: 1.00, [M23n]: 1.30 }, conOrdiniVivi: { leggibile: true, ids: [] } });
    // ② il margine basta: +$2,00
    const largo = SELM.decidiSelezione({ ...base23, stato: statoCon,
      nettoPerMercato: { [M23]: 1.00, [M23n]: 3.00 }, conOrdiniVivi: { leggibile: true, ids: [] } });
    // ③ l'occupante ha ORDINI VIVI: intoccabile anche col margine
    const conOrdini = SELM.decidiSelezione({ ...base23, stato: statoCon,
      nettoPerMercato: { [M23]: 1.00, [M23n]: 3.00 }, conOrdiniVivi: { leggibile: true, ids: [M23] } });
    // ④ la lista degli ordini NON e' leggibile: fail-closed, non si spodesta nessuno
    const cieco23 = SELM.decidiSelezione({ ...base23, stato: statoCon,
      nettoPerMercato: { [M23]: 1.00, [M23n]: 3.00 }, conOrdiniVivi: { leggibile: false, ids: [] } });
    // ⑤ l'occupante e' IN GESTIONE: una gamba riempita non si abbandona a meta'
    const statoGest = { versione: 1, selezionati: { [M23]: { ...statoCon.selezionati[M23], inGestione: true, inGestioneDal: OROLOGIO.ora - 600_000 } } };
    const inGest = SELM.decidiSelezione({ ...base23, stato: statoGest,
      nettoPerMercato: { [M23]: 1.00, [M23n]: 3.00 }, conOrdiniVivi: { leggibile: true, ids: [] } });
    // ⑥ il netto NON e' misurabile: non spodesta e non si fa spodestare
    const senzaNetto = SELM.decidiSelezione({ ...base23, stato: statoCon,
      nettoPerMercato: null, conOrdiniVivi: { leggibile: true, ids: [] } });
    // ⚠ UN OCCUPANTE SPODESTATO FINISCE IN `spodestati`/`liberati`, **NON** in `uscenti`: `uscenti` sono
    // quelli che escono da soli (scadenza, board), gli spodestati sono cacciati. La prima stesura di
    // questo passo guardava `uscenti` e rispondeva «no» anche nel caso col margine sufficiente — cioe'
    // il passo cadeva invece di passare per finta, che e' la direzione giusta in cui sbagliare, ma
    // restava una lista sbagliata. Le due liste vanno tenute distinte, ed e' il motivo per cui esistono.
    const normalizzaId = (x) => String(x || '').trim().toLowerCase();
    const uscito = (d) => d.ok === true && (d.spodestati || []).some((u) => normalizzaId(u.id) === normalizzaId(M23));
    const ok23 = uscito(stretto) === false && uscito(largo) === true && uscito(conOrdini) === false
      && uscito(cieco23) === false && uscito(inGest) === false && uscito(senzaNetto) === false;
    passo('23 · R9 · la soglia di spodestamento e le quattro condizioni che la fermano', {
      ok: ok23,
      margineInsufficiente: uscito(stretto), margineSufficiente: uscito(largo),
      conOrdiniVivi: uscito(conOrdini), listaOrdiniIlleggibile: uscito(cieco23),
      occupanteInGestione: uscito(inGest), nettoNonMisurabile: uscito(senzaNetto),
      soglia: { assolutaUsdGiorno: SELM.SPODESTA_MARGINE_USD_GIORNO ?? null, frazione: SELM.SPODESTA_MARGINE_FRAZIONE ?? null },
    });
    if (!ok23) annota('passo 23', 'la soglia di spodestamento o una delle quattro condizioni non regge',
      'lib/maker/selezione-mercati.spodestaAbbastanza + decidiSelezione');
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
    passi, bloccato, annotati,
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
  if (annotati.length) {
    console.log(`\n🟠 ${annotati.length} PASSO/I NON ARRIVANO IN FONDO (annotati, il giro e' proseguito):`);
    for (const a of annotati) console.log(`   · ${a.dove}: ${a.perche}\n     ${a.riferimento || ''}`);
  }
  if (bloccato) console.log(`\n🔴 GIRO INTERROTTO: fermo a «${bloccato.dove}».`);
  if (bloccato || annotati.length) process.exitCode = 1;
})();
