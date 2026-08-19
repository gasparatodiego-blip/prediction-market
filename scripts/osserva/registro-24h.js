'use strict';
// scripts/osserva/registro-24h.js — LA SPINA DORSALE DELLA FINESTRA DI 24 ORE.
//
// ═══ PERCHE' ESISTE, E PERCHE' E' UN PROCESSO A PARTE ════════════════════════════════════════════════
// L'operatore ha aperto una finestra di osservazione di 24 ore chiedendo che sette grandezze fossero
// registrate. Sei lo erano gia' (v. la tabella qui sotto). La settima — **quali mercati hanno ordini a
// libro, istante per istante** — NON lo era, e la ragione e' precisa:
//
//   · `data/venue-orders.json` e' l'unica fonte AUTOREVOLE (agent40 la scrive da letture vere del
//     venue), ma si SOVRASCRIVE: e' uno stato, non una serie. Domani non dira' niente su ieri.
//   · `agent45` dichiara `ordiniPerMercato: null` con il motivo — il giornale REDIGE
//     `requested.marketId` sulle righe di elenco (`manual-list`), quindi il conteggio per mercato non
//     e' ricostruibile da li'. E' un null STRUTTURALE, non un errore di un giro.
//   · il suo `nozionaleABookUsd` e' una RICOSTRUZIONE, e la si e' vista corta: alle 15:15 dichiarava
//     `mercatiVisti: 2` mentre al venue i mercati con ordini erano **3**.
//
// ⚠ E QUESTA E' UNA MODIFICA CHE NON PUO' VIVERE DENTRO UN AGENT. La finestra vieta i riavvii, e il
//   codice di un processo pm2 sta nella sua memoria: una riga aggiunta a `lib/osservatore/` o ad
//   agent40 sarebbe **inerte per 24 ore**. Correggere il registro richiedeva quindi un osservatore
//   ESTERNO, che non tocca nessun processo vivo.
//
// ⚠ STRUTTURALMENTE INCAPACE DI TOCCARE CAPITALE, e non per promessa: **zero `require` oltre ai
//   builtin di node** (`fs`, `path`). Nessun adapter, nessuna credenziale, nessuna rete. Apre file in
//   lettura e ne appende UNO, suo, che nessun altro legge.
//
// ═══ COSA SCRIVE, E LA REGOLA CHE LO GOVERNA ═══════════════════════════════════════════════════════
// Una riga al minuto in `data/osservazione-24h.jsonl`. Ogni riga porta il libro DUE VOLTE:
//
//   · `libroAutorevole` — l'insieme dei mercati letto da `venue-orders.json`, cioe' dal venue vero.
//     Non ha conteggi ne' nozionale: chi lo scrive riceve insiemi di mercati, non ordini.
//   · `libro` — la RICOSTRUZIONE dal giornale, che ha conteggi, prezzi, size e nozionale per mercato.
//
// ⚠⚠ E LA `divergenza` FRA I DUE E' IL CAMPO PIU' IMPORTANTE DELLA RIGA. Il 18 agosto sera una
//    ricostruzione ha dichiarato «4 mercati, 8 ordini, $209,08» mentre al venue ce n'erano 2: sei
//    scadenze erano gia' avvenute e non erano ancora state scritte. **Una ricostruzione non e' una
//    lettura.** Qui non si sceglie fra le due e non si media: si scrivono entrambe e si misura di
//    quanto non vanno d'accordo, cosi' domani si sa quanto vale il numero che si sta usando.
//
// ⚠ LA SCADENZA GTD SI APPLICA ANCHE SENZA UN RECORD CHE LA DICHIARI. Un ordine piu' vecchio della
//   `ttlSeconds` con cui e' stato piazzato e' morto al venue, che il giornale l'abbia notato o no.
//   Sommare gli `sent` e togliere solo le scadenze REGISTRATE e' esattamente l'errore del 18 agosto.
//
// ⚠ NON DEDUCE MAI DA UN SILENZIO. File assente o vecchio ⇒ `leggibile:false` col motivo, mai uno zero.
//
// ═══ DOVE STA IL RESTO — le sei grandezze che erano gia' registrate ═══════════════════════════════
//   ① mercati nel piano          `data/realloc-scheduler.jsonl`, `tipo:'mini-ciclo'` → `mercati[]`
//   ③ ammissibili su valutati    idem, `tipo:'selezione-mercati'` → `ammissibili`/`valutati`,
//                                `slotVuotiPerScarsita.motivo`, `postiNonAssegnati`
//   ④ ingressi e uscite          idem → `entrati`/`usciti`/`liberati`/`spodestati`, ognuno con
//                                `motivo` e `dettaglio`
//   ⑤ ogni fill                  `data/safety-fills.jsonl`, `kind:'fill'` con `market` (tokenId),
//                                `side`, `filledPrice`, `filledSize`
//   ⑥ scadenza GTD               `data/polymarket-maker-audit.jsonl`,
//                                `auto-reprice/scaduto-senza-rinnovo` (con book, side, price, size,
//                                gate) e `order-vanished/expired`. Il tempo fino al ripiazzamento e'
//                                una SOTTRAZIONE fra quel record e il `manual-place/sent` successivo
//                                sullo stesso mercato e libro — verificato derivabile su dati veri.
//   ⑦ premio maturato            `data/stima-campioni.json` (integrale Σ tasso×durata), qui ricopiato
//                                a ogni riga perche' la risposta di domani non richieda un secondo passo
//
// Questa riga NON sostituisce nessuna di quelle fonti: le indicizza al minuto, e aggiunge la sola che
// mancava.

const fs = require('fs');
const path = require('path');

const RADICE = path.join(__dirname, '..', '..');
const DATA = path.join(RADICE, 'data');
const GIORNALE = path.join(DATA, 'polymarket-maker-audit.jsonl');
const REALLOC = path.join(DATA, 'realloc-scheduler.jsonl');
const VENUE_ORDINI = path.join(DATA, 'venue-orders.json');
const VENUE_POSIZIONI = path.join(DATA, 'venue-positions.json');
const SELEZIONE = path.join(DATA, 'selezione-mercati.json');
const KILL = path.join(DATA, 'safety-kill-switch.json');
const BOT = path.join(DATA, 'maker-bot-enabled.json');
const GUARDIANO = path.join(DATA, 'guardian-state.json');
const CAMPIONI = path.join(DATA, 'stima-campioni.json');
const USCITA = path.join(DATA, 'osservazione-24h.jsonl');
// ⚠ IL PIDFILE ESISTE PERCHE' `pgrep -f` NON E' AFFIDABILE QUI (§5.3): il comando che lo esegue
//   contiene la stringa cercata, quindi il guard troverebbe la propria shell e concluderebbe «gira
//   gia'» — cioe' un guard che non riavvia mai, e lo fa in silenzio. Il pidfile toglie l'ambiguita':
//   si legge un numero e si guarda `/proc/<pid>`, che o c'e' o non c'e'.
const PIDFILE = path.join(DATA, 'osservazione-24h.pid');

const CADENZA_MS = 60_000;
/** Oltre questa eta' `venue-orders.json` non e' una lettura di adesso: e' un ricordo. Stessa soglia
 *  dello snapshot vero (`MAX_AGE_MS`), perche' due opinioni sulla stessa freschezza sono una di troppo. */
const ETA_MAX_AUTOREVOLE_MS = 180_000;
/** Quanto giornale si rilegge all'avvio per sapere cosa c'e' a libro ADESSO. Un ordine vive al piu'
 *  23 minuti (GTD 1380 s): 64 MB coprono molte ore, quindi il primo campione e' gia' pieno. */
const AVVIO_CODA_BYTE = 64 * 1024 * 1024;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

function leggiJson(f) {
  try { return { ok: true, v: JSON.parse(fs.readFileSync(f, 'utf8')) }; }
  catch (e) { return { ok: false, v: null, errore: e.code === 'ENOENT' ? 'assente' : e.message }; }
}

// ── IL LIBRO RICOSTRUITO ──────────────────────────────────────────────────────────────────────────
// Chiave: `orderId`, che il giornale porta su TUTTI e quattro gli eventi che contano — nascita
// (`manual-place/sent`), morte voluta (`manual-cancel/ok`), morte per scadenza (`order-vanished`) e
// sostituzione (`manual-replace`, che porta il vecchio e il nuovo). E' l'unica chiave che li lega.
const vivi = new Map();

function cidDa(ref) {
  if (typeof ref !== 'string') return null;
  if (ref.startsWith('cid_')) return '0x' + ref.slice(4).replace(/^0x/, '');
  return null;
}

function applica(r) {
  const op = r.op; const oc = r.outcome;
  if (op === 'manual-place' && oc === 'sent' && r.orderId) {
    const q = r.requested || {};
    const cid = cidDa(r.marketRef);
    vivi.set(r.orderId, {
      cid, marketRef: r.marketRef, book: q.book || null, side: q.side || null,
      price: fin(q.price) ? q.price : null, size: fin(q.size) ? q.size : null,
      nozionaleUsd: fin(q.notionalUsd) ? q.notionalUsd : null,
      at: r.ts, ttlMs: fin(q.ttlSeconds) ? q.ttlSeconds * 1000 : null,
      fonte: r.source || null,
    });
    return;
  }
  if (op === 'manual-cancel' && oc === 'ok') {
    const id = (r.requested || {}).orderId;
    if (id) vivi.delete(id);
    return;
  }
  if (op === 'order-vanished' && r.orderId) { vivi.delete(r.orderId); return; }
  if (op === 'auto-reprice' && oc === 'scaduto-senza-rinnovo' && r.orderId) { vivi.delete(r.orderId); return; }
  if (op === 'manual-replace' && oc === 'sent') {
    // Il vecchio e' gia' cancellato dal replace atomico; il nuovo nasce con un `manual-place/sent`
    // proprio, quindi qui basta togliere quello superato.
    const id = (r.requested || {}).orderId;
    if (id) vivi.delete(id);
  }
}

/** ⚠ LA SCADENZA SI APPLICA ANCHE SE NESSUNO L'HA SCRITTA. Vedi la nota in testa: e' la differenza
 *  fra una ricostruzione onesta e quella che il 18 agosto ha dichiarato il doppio del vero. */
function potaScaduti(ora) {
  let potati = 0;
  for (const [id, o] of vivi) {
    const ttl = fin(o.ttlMs) ? o.ttlMs : null;
    if (ttl === null) continue;              // ttl ignoto ⇒ non si indovina, si tiene
    if (ora - o.at > ttl) { vivi.delete(id); potati += 1; }
  }
  return potati;
}

function riepilogoLibro(ora) {
  const mercati = {};
  let ordini = 0; let nozionale = 0; let nozionaleIgnoto = 0;
  for (const o of vivi.values()) {
    const k = o.cid || o.marketRef || 'ignoto';
    if (!mercati[k]) mercati[k] = { ordini: 0, nozionaleUsd: 0, gambe: {}, etaMinMs: null, etaMaxMs: null };
    const m = mercati[k];
    m.ordini += 1; ordini += 1;
    if (fin(o.nozionaleUsd)) { m.nozionaleUsd = +(m.nozionaleUsd + o.nozionaleUsd).toFixed(4); nozionale += o.nozionaleUsd; }
    else nozionaleIgnoto += 1;
    if (o.book) m.gambe[o.book] = (m.gambe[o.book] || 0) + 1;
    const eta = ora - o.at;
    m.etaMinMs = m.etaMinMs === null ? eta : Math.min(m.etaMinMs, eta);
    m.etaMaxMs = m.etaMaxMs === null ? eta : Math.max(m.etaMaxMs, eta);
  }
  return {
    fonte: 'ricostruita-dal-giornale',
    mercati, nMercati: Object.keys(mercati).length, ordini,
    nozionaleUsd: +nozionale.toFixed(4),
    // Un ordine senza nozionale non vale zero: si dichiara quanti sono, o il totale mentirebbe in
    // difetto senza dirlo.
    ordiniSenzaNozionale: nozionaleIgnoto,
  };
}

// ── LA LETTURA INCREMENTALE DEL GIORNALE ─────────────────────────────────────────────────────────
// Rotazione riconosciuta da inode + dimensione, come `lib/giornale-incrementale`: un file che
// rimpicciolisce o cambia inode e' un file nuovo, e ripartire dall'offset vecchio leggerebbe spazzatura.
let posizione = 0; let inode = null; let avanzo = '';

function consuma(daZeroCoda) {
  let st;
  try { st = fs.statSync(GIORNALE); } catch { return { letti: 0, errore: 'giornale assente' }; }
  if (inode !== null && (st.ino !== inode || st.size < posizione)) { posizione = 0; avanzo = ''; }
  inode = st.ino;
  if (daZeroCoda) { posizione = Math.max(0, st.size - AVVIO_CODA_BYTE); avanzo = ''; }
  if (st.size <= posizione) return { letti: 0, errore: null };
  const fd = fs.openSync(GIORNALE, 'r');
  let letti = 0;
  try {
    const PEZZO = 8 * 1024 * 1024;
    while (posizione < st.size) {
      const n = Math.min(PEZZO, st.size - posizione);
      const buf = Buffer.allocUnsafe(n);
      const q = fs.readSync(fd, buf, 0, n, posizione);
      if (q <= 0) break;
      posizione += q;
      const testo = avanzo + buf.slice(0, q).toString('utf8');
      const righe = testo.split('\n');
      avanzo = righe.pop();
      for (const l of righe) {
        if (!l) continue;
        let r; try { r = JSON.parse(l); } catch { continue; }
        if (!fin(r.ts)) continue;
        applica(r); letti += 1;
      }
    }
  } finally { fs.closeSync(fd); }
  // ⚠ La prima riga della coda e' quasi certamente troncata a meta': si butta, non si tenta di
  //   ripararla. Un record mezzo letto e' peggio di un record mancante.
  return { letti, errore: null };
}

// ── LE ALTRE SEI, indicizzate al minuto ──────────────────────────────────────────────────────────
function codaRealloc() {
  let out = { selezione: null, miniCiclo: null, errore: null };
  try {
    const st = fs.statSync(REALLOC);
    const da = Math.max(0, st.size - 4 * 1024 * 1024);
    const fd = fs.openSync(REALLOC, 'r');
    const buf = Buffer.allocUnsafe(st.size - da);
    fs.readSync(fd, buf, 0, buf.length, da); fs.closeSync(fd);
    const righe = buf.toString('utf8').split('\n');
    for (let i = righe.length - 1; i >= 0; i--) {
      if (out.selezione && out.miniCiclo) break;
      const l = righe[i]; if (!l || !l.startsWith('{')) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (!out.selezione && r.tipo === 'selezione-mercati' && r.esito === 'applicata') {
        out.selezione = {
          at: r.at, occupati: r.occupati, ammissibili: r.ammissibili, valutati: r.valutati,
          tenuti: r.tenuti || null, inGestione: r.inGestione || null,
          entrati: r.entrati || [], usciti: r.usciti || [], liberati: r.liberati || [],
          spodestati: r.spodestati || [], entratiInGestione: r.entratiInGestione || [],
          postiNonAssegnati: r.postiNonAssegnati || [],
          scartatiPerComposizione: r.scartatiPerComposizione || [],
          slotVuotiPerScarsita: r.slotVuotiPerScarsita || null,
        };
      }
      if (!out.miniCiclo && (r.tipo === 'mini-ciclo' || r.tipo === 'ciclo-referto')) {
        out.miniCiclo = {
          at: r.at, tipo: r.tipo, esito: r.esito || null, motivoStop: r.motivoStop || null,
          mercati: r.mercati || null, allocatoUsd: r.allocatoUsd, residuoUsd: r.residuoUsd,
          righe: r.ricalcolo ? r.ricalcolo.righe : null,
        };
      }
    }
  } catch (e) { out.errore = e.code === 'ENOENT' ? 'assente' : e.message; }
  return out;
}

function premio(ora) {
  const j = leggiJson(CAMPIONI);
  if (!j.ok) return { leggibile: false, motivo: j.errore };
  const giorno = new Date(ora).toISOString().slice(0, 10);
  const c = ((j.v || {}).giorni || {})[giorno];
  if (!Array.isArray(c) || !c.length) return { leggibile: true, giorno, campioni: 0, usd: null, motivo: 'nessun campione oggi' };
  // Stesso integrale di `lib/maker/stima-integrata.integra`, riscritto qui per non importare nulla:
  // Σ(tasso × durata), un campione vale al piu' due passi (10 min), mai oltre «adesso».
  const PASSO_MAX_MS = 600_000; const GIORNO_MS = 86_400_000;
  const t0 = Date.parse(giorno + 'T00:00:00.000Z');
  const fine = Math.min(t0 + GIORNO_MS, Math.max(t0, ora));
  const s = [...c].sort((a, b) => a.t - b.t);
  let usd = 0; let coperto = 0;
  for (let i = 0; i < s.length; i++) {
    const inizio = Math.max(t0, s[i].t); if (inizio >= fine) continue;
    const prossimo = i + 1 < s.length ? s[i + 1].t : Infinity;
    const durata = Math.max(0, Math.min(prossimo, inizio + PASSO_MAX_MS, fine) - inizio);
    if (durata <= 0) continue;
    usd += s[i].r * (durata / GIORNO_MS); coperto += durata;
  }
  const orizzonte = Math.max(0, fine - t0);
  return {
    leggibile: true, giorno, campioni: s.length,
    usd: Math.round(usd * 1e4) / 1e4,
    coperturaFrazione: orizzonte > 0 ? Math.round((coperto / orizzonte) * 1e4) / 1e4 : 0,
    tassoUltimoUsdGiorno: s[s.length - 1].r, capitaleInBandaUsd: s[s.length - 1].c ?? null,
  };
}

function campione(ora) {
  potaScaduti(ora);
  const ric = riepilogoLibro(ora);

  // ── IL LIBRO AUTOREVOLE ────────────────────────────────────────────────────────────────────────
  const vo = leggiJson(VENUE_ORDINI);
  let autorevole;
  if (!vo.ok) autorevole = { leggibile: false, motivo: vo.errore, mercati: null };
  else {
    const eta = fin(vo.v.at) ? ora - vo.v.at : null;
    const vecchio = eta === null || eta > ETA_MAX_AUTOREVOLE_MS;
    autorevole = {
      leggibile: !vecchio, etaMs: eta,
      motivo: vecchio ? `snapshot di ${eta === null ? 'eta ignota' : Math.round(eta / 1000) + 's'} fa: oltre i 180s non e una lettura di adesso` : null,
      mercati: vecchio ? null : Object.keys(vo.v.mercati || {}),
    };
  }

  // ── LA DIVERGENZA — il campo che dice quanto vale il numero ricostruito ────────────────────────
  let divergenza;
  if (!autorevole.leggibile) divergenza = { calcolabile: false, motivo: 'il libro autorevole non e leggibile' };
  else {
    const A = new Set(autorevole.mercati);
    const R = new Set(Object.keys(ric.mercati));
    const soloR = [...R].filter((x) => !A.has(x));
    const soloA = [...A].filter((x) => !R.has(x));
    divergenza = {
      calcolabile: true, concordi: soloR.length === 0 && soloA.length === 0,
      nAutorevole: A.size, nRicostruito: R.size,
      soloRicostruito: soloR,   // la ricostruzione crede a ordini che al venue non ci sono piu'
      soloAutorevole: soloA,    // al venue c'e' un mercato che la ricostruzione non ha visto nascere
    };
  }

  const pos = leggiJson(VENUE_POSIZIONI);
  const sel = leggiJson(SELEZIONE);
  const kill = leggiJson(KILL);
  const bot = leggiJson(BOT);
  const rl = codaRealloc();

  const selezionati = sel.ok ? ((sel.v || {}).selezionati || {}) : null;
  return {
    at: ora, atIso: new Date(ora).toISOString(), pid: process.pid,

    libro: ric,
    libroAutorevole: autorevole,
    divergenza,

    piano: rl.miniCiclo,
    selezione: rl.selezione,
    selezioneStato: selezionati ? {
      attiva: (sel.v || {}).attiva === true,
      attivi: Object.entries(selezionati).filter(([, v]) => v && v.inGestione !== true).map(([k]) => k),
      inGestione: Object.entries(selezionati).filter(([, v]) => v && v.inGestione === true).map(([k]) => k),
    } : { leggibile: false, motivo: sel.errore },

    posizioni: pos.ok ? {
      leggibile: true, etaMs: fin((pos.v || {}).at) ? ora - pos.v.at : null,
      n: ((pos.v || {}).positions || []).length,
      perMercato: ((pos.v || {}).positions || []).map((p) => ({
        asset: p.asset || p.tokenId || null, size: p.size, prezzo: p.curPrice,
      })),
    } : { leggibile: false, motivo: pos.errore },

    premio: premio(ora),

    interruttori: {
      killAttivo: kill.ok ? (((kill.v || {}).global || {}).killed === true) : null,
      botAttivo: bot.ok ? ((bot.v || {}).enabled === true) : null,
      // ⚠ L'ASSENZA E' LO STATO SANO: se questo file compare, il guardiano e' scattato.
      guardianoScattato: fs.existsSync(GUARDIANO),
      chiusuraEmergenzaRichiesta: fs.existsSync(path.join(DATA, 'chiusura-emergenza-richiesta.json')),
      sospensioneErosione: fs.existsSync(path.join(DATA, 'sospensioni-erosione.json')),
    },
  };
}

// ── IL GIRO ──────────────────────────────────────────────────────────────────────────────────────
function scrivi(riga) {
  try { fs.appendFileSync(USCITA, JSON.stringify(riga) + '\n'); }
  catch (e) { console.error('[osserva] registro non scrivibile:', e.message); }
}

function giro(primo) {
  const ora = Date.now();
  const c = consuma(primo === true);
  const riga = campione(ora);
  riga.giornale = { recordConsumati: c.letti, errore: c.errore, offset: posizione };
  scrivi(riga);
  const d = riga.divergenza;
  console.log(`[osserva] ${riga.atIso} · libro ricostruito ${riga.libro.nMercati} mercati / ${riga.libro.ordini} ordini / $${riga.libro.nozionaleUsd.toFixed(2)}`
    + ` · autorevole ${riga.libroAutorevole.leggibile ? riga.libroAutorevole.mercati.length + ' mercati' : 'NON LEGGIBILE'}`
    + ` · ${d.calcolabile ? (d.concordi ? 'concordi' : `DIVERGONO (+${d.soloRicostruito.length} ric / +${d.soloAutorevole.length} aut)`) : 'divergenza non calcolabile'}`
    + ` · premio ${riga.premio.usd === null ? 'n/d' : '$' + riga.premio.usd.toFixed(4)}`);
}

/** Gira gia' qualcuno? Si guarda `/proc/<pid>`, non `pgrep`. Pidfile assente, illeggibile o che punta
 *  a un processo morto ⇒ **no**: nel dubbio si riparte, perche' due osservatori scrivono due righe
 *  (rumore) mentre zero osservatori perdono la finestra (misura). */
function giaVivo() {
  try {
    const pid = parseInt(fs.readFileSync(PIDFILE, 'utf8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    if (!fs.existsSync(`/proc/${pid}`)) return false;
    // Il pid puo' essere stato riciclato: si pretende che sia davvero questo script.
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmd.includes('registro-24h.js');
  } catch { return false; }
}

if (require.main === module) {
  if (giaVivo()) {
    console.log('[osserva] gia in servizio: non ne servono due, esco');
    process.exit(0);
  }
  try { fs.writeFileSync(PIDFILE, String(process.pid)); } catch (e) { console.error('[osserva] pidfile non scrivibile:', e.message); }
  console.log(`[osserva] avvio · scrivo su ${USCITA} · cadenza ${CADENZA_MS / 1000}s`);
  giro(true);
  setInterval(() => { try { giro(false); } catch (e) { console.error('[osserva] giro fallito:', e.message); } }, CADENZA_MS);
}

module.exports = { campione, applica, potaScaduti, riepilogoLibro, vivi, cidDa, PIDFILE };
