'use strict';

/**
 * IL CAMPIONAMENTO DELL'OSSERVATORE — modulo PURO.
 *
 * ═══ PERCHÉ ESISTE ══════════════════════════════════════════════════════════════════════════════
 * Oggi rispondere a «quanti ordini avevo alle 3 di notte?» richiede di ricostruire a posteriori da
 * fonti eterogenee, e alcune serie **non sono ricostruibili affatto**: le 651 righe `manual-cancel/ok`
 * senza `orderId` (CLAUDE.md §5.2 p.10) rendono impossibile seguire il ciclo di vita di un ordine.
 * Questo modulo costruisce il campione; `agents/agent45-osservatore.js` lo chiama a cadenza fissa.
 *
 * ═══ LA REGOLA CHE GOVERNA OGNI CAMPO ═══════════════════════════════════════════════════════════
 * **Ogni grandezza dichiara la propria PROVENIENZA**, e le tre risposte possibili sono diverse fra loro:
 *   · `diretta`     — letta dalla fonte che la possiede (catena, snapshot del venue, file di stato);
 *   · `ricostruita` — dedotta da osservazioni fatte da ALTRI processi per altri scopi. Utile, ma non
 *                     è la stessa cosa, e chi legge deve poterlo sapere senza indovinare;
 *   · `null`        — non misurabile con la strumentazione di oggi. **Non si stima mai.**
 *
 * ⚠ `null` NON È ZERO, ed è la regola più violata di questo repo (sei occorrenze di `Number(null) === 0`
 * secondo §5-bis). Un saldo non letto scritto come 0 direbbe «portafoglio vuoto»; un conteggio di ordini
 * non letto scritto come 0 direbbe «libro deserto», che è l'allarme più forte possibile prodotto dal
 * nulla. Qui un valore che non si è potuto leggere resta `null` e porta il motivo accanto.
 *
 * ⚠ UN CAMPIONE SALTATO DEVE VEDERSI. Se fra due campioni passa più di `TOLLERANZA_SALTO_MS`, il
 * campione nuovo dichiara `saltati: n` e `ritardoMs`: un buco silenzioso nella serie è indistinguibile
 * da un periodo in cui non è successo niente, ed è esattamente l'ambiguità che questo giornale esiste
 * per togliere.
 *
 * Modulo PURO: nessun `require` di rete, di venue, di disco. Riceve letture, restituisce un campione.
 */

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * ⚠ `Number(null) === 0`, ED È IL DIFETTO PIÙ RICORRENTE DI QUESTO REPO (§5-bis lo conta sei volte).
 * `Number()` da solo trasforma «non ho letto» in «vale zero»: su un `curPrice` assente produrrebbe una
 * posizione che vale $0, cioè un portafoglio che si è svalutato — un dato mancante travestito da
 * misura. Questo helper restituisce NaN per tutto ciò che non è già un numero leggibile, così il ramo
 * «non leggibile» parte davvero. Trovato da un test, non dal ragionamento: come le altre sei volte.
 */
const leggiNum = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? NaN : Number(v));

/** La cadenza. FISSA: l'osservatore ha il proprio orologio e non segue i giri di nessun altro. */
const CADENZA_MS = 60_000;

/**
 * Oltre questo intervallo il campione precedente è considerato SALTATO. Una volta e mezza la cadenza:
 * sotto sta il normale jitter di un `setTimeout` sotto carico, sopra manca davvero un campione.
 */
const TOLLERANZA_SALTO_MS = 90_000;

/** Quanti giorni di giornale si tengono. Oltre, i file si cancellano: non deve riempire il disco. */
const GIORNI_DA_TENERE = 30;

/**
 * LE POSIZIONI, RAGGRUPPATE PER MERCATO.
 *
 * Un mercato con DUE token posseduti è una coppia completa: alla risoluzione vale $1/share comunque,
 * cioè esposizione direzionale zero. Un mercato con un token solo è una **gamba nuda**, ed è la
 * grandezza che conta davvero — è quella che il guardiano ha lasciato scoperta cancellando le gambe
 * opposte. La distinzione è **osservazione diretta**: viene dallo snapshot del venue, non da un conto.
 */
function analizzaPosizioni(positions) {
  if (!Array.isArray(positions)) {
    return { leggibile: false, mercati: null, entrambeGambe: null, unaGamba: null,
      valoreUsd: null, nPosizioni: null, perMercato: null };
  }
  const per = new Map();
  for (const p of positions) {
    const cid = String((p && p.conditionId) || '');
    if (!cid) continue;
    const size = leggiNum(p && p.size);
    const cur = leggiNum(p && p.curPrice);
    const v = fin(size) && fin(cur) ? size * cur : null;
    if (!per.has(cid)) per.set(cid, { conditionId: cid, gambe: 0, valoreUsd: 0, valoreLeggibile: true, titolo: (p && p.title) || null });
    const m = per.get(cid);
    m.gambe += 1;
    if (v === null) m.valoreLeggibile = false; else m.valoreUsd += v;
  }
  const lista = [...per.values()].map((m) => ({
    conditionId: m.conditionId, gambe: m.gambe,
    valoreUsd: m.valoreLeggibile ? +m.valoreUsd.toFixed(4) : null,
    coppiaCompleta: m.gambe >= 2, titolo: m.titolo,
  }));
  const valoreTot = lista.every((m) => m.valoreUsd !== null)
    ? +lista.reduce((a, m) => a + m.valoreUsd, 0).toFixed(4) : null;
  return {
    leggibile: true,
    mercati: lista.length,
    entrambeGambe: lista.filter((m) => m.coppiaCompleta).length,
    unaGamba: lista.filter((m) => !m.coppiaCompleta).length,
    valoreUsd: valoreTot,
    nPosizioni: positions.length,
    perMercato: lista,
  };
}

/**
 * IL CAMPIONE. Ogni ingresso è una LETTURA GIÀ FATTA dal chiamante, con il suo esito.
 *
 * Nessun ingresso è obbligatorio: quello che manca diventa `null` con il motivo, e il campione si
 * scrive lo stesso. Un osservatore che si rifiuta di scrivere perché una fonte tace produce
 * esattamente il buco che dovrebbe registrare.
 */
function costruisciCampione({
  ora = Date.now(), precedenteAt = null,
  saldo = null, posizioni = null, baseline = null,
  ordini = null, nozionaleABook = null, reward = null,
  statoBot = null, kill = null, latch = null,
  pnlGuardiano = null,
} = {}) {
  // ── IL SALTO ────────────────────────────────────────────────────────────────────────────────────
  // Si dichiara SEMPRE, anche quando vale zero: «nessun salto» è un'informazione, e un campo che
  // compare solo quando le cose vanno male costringe chi legge a distinguere «assente» da «zero».
  const dt = fin(precedenteAt) ? ora - precedenteAt : null;
  const saltati = dt !== null && dt > TOLLERANZA_SALTO_MS
    ? Math.max(1, Math.round(dt / CADENZA_MS) - 1) : 0;

  const pos = analizzaPosizioni(posizioni && posizioni.leggibile !== false ? posizioni.positions : null);

  const saldoUsd = saldo && saldo.affidabile === true && fin(saldo.usd) ? saldo.usd : null;
  const totaleUsd = saldoUsd !== null && pos.valoreUsd !== null ? +(saldoUsd + pos.valoreUsd).toFixed(4) : null;

  return {
    at: ora,
    atIso: new Date(ora).toISOString(),
    // ── LA CONTINUITÀ DELLA SERIE ────────────────────────────────────────────────────────────────
    intervalloMs: dt,
    saltati,
    ritardoMs: dt !== null && dt > TOLLERANZA_SALTO_MS ? dt - CADENZA_MS : 0,

    // ── (a) ORDINI APERTI ────────────────────────────────────────────────────────────────────────
    // ⚠ RICOSTRUITO, e va detto. Leggere gli ordini vivi dal venue richiede una chiamata autenticata,
    // che passa dall'adapter — cioè dalla stessa superficie che sa PIAZZARE. Un osservatore che la
    // importasse smetterebbe di essere strutturalmente incapace di toccare capitale, e quella
    // proprietà vale più della freschezza di questo campo. Si legge quindi il conteggio che agent40
    // ha già osservato, dichiarandone l'età.
    ordiniAperti: ordini && fin(ordini.totale) ? ordini.totale : null,
    ordiniFonte: ordini && fin(ordini.totale) ? 'ricostruita' : null,
    ordiniEtaMs: ordini && fin(ordini.etaMs) ? ordini.etaMs : null,
    // ⚠ NULL STRUTTURALE, non un errore di questo giro: il giornale REDIGE `requested.marketId` sulle
    // righe di elenco, quindi il conteggio per mercato non è ricostruibile da nessuna fonte esistente.
    // È la stessa famiglia di §5.2 p.10 (`orderId` assente su `manual-cancel`). Vedi il riepilogo.
    ordiniPerMercato: null,
    ordiniPerMercatoMotivo: 'marketId redatto nelle righe di elenco del giornale: non ricostruibile',

    // ── (b) MERCATI COPERTI — osservazione DIRETTA, dalle posizioni ──────────────────────────────
    mercatiConPosizione: pos.mercati,
    mercatiEntrambeGambe: pos.entrambeGambe,
    mercatiUnaGamba: pos.unaGamba,
    mercatiFonte: pos.leggibile ? 'diretta' : null,

    // ── (c) NOZIONALE A BOOK ─────────────────────────────────────────────────────────────────────
    nozionaleABookUsd: nozionaleABook && fin(nozionaleABook.usd) ? nozionaleABook.usd : null,
    nozionaleABookFonte: nozionaleABook && fin(nozionaleABook.usd) ? 'ricostruita' : null,
    nozionaleABookMercatiVisti: nozionaleABook && fin(nozionaleABook.mercati) ? nozionaleABook.mercati : null,

    // ── (d) POSIZIONI — osservazione DIRETTA ────────────────────────────────────────────────────
    posizioniAperte: pos.nPosizioni,
    posizioniValoreUsd: pos.valoreUsd,
    posizioniFonte: pos.leggibile ? 'diretta' : null,
    posizioniEtaMs: posizioni && fin(posizioni.ageMs) ? posizioni.ageMs : null,
    posizioniPerMercato: pos.perMercato,

    // ── (e) SALDO E TOTALE — osservazione DIRETTA (eth_call senza signer) ────────────────────────
    saldoUsd,
    saldoFonte: saldoUsd !== null ? 'diretta' : null,
    saldoMotivo: saldoUsd === null ? ((saldo && saldo.motivo) || 'saldo non affidabile') : null,
    totalePortafoglioUsd: totaleUsd,
    totaleFonte: totaleUsd !== null ? 'diretta' : null,

    // ── (f) PnL ─────────────────────────────────────────────────────────────────────────────────
    // Due numeri diversi e tenuti separati apposta: quello del GUARDIANO è misurato contro una
    // baseline fissa del 7 agosto (§5.2 p.14: fotografia vecchia che ha assorbito $17,95 di reward),
    // il totale on-chain è il valore vero di adesso. Confonderli è il difetto che si vuole misurare.
    pnlGuardianoUsd: pnlGuardiano && fin(pnlGuardiano.pnlUsd) ? pnlGuardiano.pnlUsd : null,
    pnlGuardianoPct: pnlGuardiano && fin(pnlGuardiano.pnlPct) ? pnlGuardiano.pnlPct : null,
    baselineUsd: baseline && fin(baseline.baselineUsd) ? baseline.baselineUsd : null,
    baselineAtIso: baseline && baseline.atIso ? baseline.atIso : null,

    // ── (g) STATO — osservazione DIRETTA dai file di stato ──────────────────────────────────────
    botAttivo: statoBot && typeof statoBot.enabled === 'boolean' ? statoBot.enabled : null,
    killAttivo: kill && typeof kill.killed === 'boolean' ? kill.killed : null,
    latchGuardiano: latch && typeof latch.scattato === 'boolean' ? latch.scattato : false,
    latchAtIso: latch && latch.atIso ? latch.atIso : null,
    statoFonte: 'diretta',

    // ── (h) REWARD DI GIORNATA ──────────────────────────────────────────────────────────────────
    rewardOggiUsd: reward && fin(reward.usd) ? reward.usd : null,
    rewardFonte: reward && fin(reward.usd) ? (reward.fonte || 'ricostruita') : null,
    rewardMotivo: reward && !fin(reward.usd) ? (reward.motivo || null) : null,
  };
}

/**
 * LE TRANSIZIONI DI COPERTURA fra due campioni consecutivi.
 *
 * «Coperta» = il mercato ha entrambe le gambe (coppia completa). «Scoperta» = una gamba sola.
 * Si confrontano le due fotografie e si emettono gli eventi, con la DURATA quando la scopertura si
 * chiude — che è il numero che oggi manca del tutto e che si ricostruisce a fatica.
 *
 * @param scoperteDa  mappa conditionId → istante in cui è diventata scoperta (la tiene il chiamante)
 */
function transizioniCopertura({ precedente = null, corrente = null, scoperteDa = null, ora = Date.now() } = {}) {
  const mappa = scoperteDa instanceof Map ? new Map(scoperteDa) : new Map();
  const eventi = [];
  if (!corrente || !Array.isArray(corrente.perMercato)) return { eventi, scoperteDa: mappa };

  const statoDi = (lista) => {
    const m = new Map();
    for (const x of lista || []) m.set(x.conditionId, x.coppiaCompleta === true);
    return m;
  };
  const ora_ = statoDi(corrente.perMercato);
  const prima = precedente && Array.isArray(precedente.perMercato) ? statoDi(precedente.perMercato) : null;

  for (const [cid, completa] of ora_) {
    const era = prima ? prima.get(cid) : undefined;
    if (!completa) {
      // È scoperta adesso. Se non lo era prima (o è nuova), l'orologio parte ORA.
      if (!mappa.has(cid)) {
        mappa.set(cid, ora);
        // Si annuncia solo una transizione VERA: un mercato appena comparso non "è passato" a scoperto.
        if (era === true) eventi.push({ tipo: 'scoperta', conditionId: cid, at: ora });
        else if (era === undefined) eventi.push({ tipo: 'scoperta-nuova', conditionId: cid, at: ora });
      }
    } else if (mappa.has(cid)) {
      const da = mappa.get(cid);
      mappa.delete(cid);
      eventi.push({ tipo: 'coperta', conditionId: cid, at: ora,
        durataMin: +((ora - da) / 60000).toFixed(1) });
    }
  }
  // Un mercato sparito del tutto (posizione chiusa) chiude la sua scopertura.
  for (const [cid, da] of [...mappa]) {
    if (!ora_.has(cid)) {
      mappa.delete(cid);
      eventi.push({ tipo: 'chiusa', conditionId: cid, at: ora, durataMin: +((ora - da) / 60000).toFixed(1) });
    }
  }
  return { eventi, scoperteDa: mappa };
}

// ══ IL GIORNALE LEGGIBILE ═══════════════════════════════════════════════════════════════════════
// Deve stare su uno schermo di telefono senza scorrere in orizzontale: si sta sotto i ~78 caratteri e
// non si usano tabelle larghe. Un giornale che si legge solo dal desktop non viene letto.
const LARGHEZZA_MAX = 78;

const hhmm = (ts) => new Date(ts).toISOString().slice(11, 16);
const usd = (v) => (fin(v) ? `$${v.toFixed(2)}` : '—');
const num = (v) => (fin(v) ? String(v) : '—');

/** Una riga di evento, in italiano, corta. */
function rigaEvento(ev) {
  const t = hhmm(ev.at);
  const c = (ev.conditionId || '').slice(0, 10);
  switch (ev.tipo) {
    case 'pre-allarme':
      return `${t}  ⚠ PRE-ALLARME guardiano ${ev.conferme || 1}/2 — PnL ${usd(ev.pnlUsd)}, non scatta`;
    case 'scatto':
      return `${t}  🛑 SCATTO guardiano — PnL ${usd(ev.pnlUsd)} (${num(ev.pnlPct)}%)`;
    case 'collasso':
      return `${t}  📉 collasso copertura — da ${num(ev.massimo)} a ${num(ev.ordini)} ordini`
        + ` (−${num(ev.caloPct)}%), solo osservazione`;
    case 'scoperta':
      return `${t}  ○ ${c} è passata a SCOPERTA (una gamba sola)`;
    case 'scoperta-nuova':
      return `${t}  ○ ${c} compare già scoperta`;
    case 'coperta':
      return `${t}  ● ${c} è tornata COPERTA dopo ${ev.durataMin} min`;
    case 'chiusa':
      return `${t}  ✔ ${c} chiusa dopo ${ev.durataMin} min di scopertura`;
    case 'merge':
      return `${t}  🔗 merge on-chain ${ev.esito === 'ok' ? 'ESEGUITO' : 'FALLITO'} su ${c}`;
    case 'cancellazione':
      return `${t}  ✂ ${num(ev.quanti)} ordini cancellati — ${ev.source || 'origine ignota'}`
        + `${ev.byHand === true ? ' (a mano)' : ''}`;
    case 'errore':
      return `${t}  ✖ errore osservatore: ${String(ev.messaggio || '').slice(0, 46)}`;
    case 'salto':
      return `${t}  ⏭ ${ev.saltati} campione/i saltato/i (ritardo ${Math.round(ev.ritardoMs / 1000)}s)`;
    default:
      return `${t}  · ${ev.tipo}`;
  }
}

/** Il blocco di sintesi oraria. Numeri chiave, una grandezza per riga. */
function bloccoSintesi({ campioni = [], oraEtichetta = '' } = {}) {
  const validi = campioni.filter(Boolean);
  if (!validi.length) return `\n### ${oraEtichetta}\n\nnessun campione in questa ora.\n`;
  const ultimo = validi[validi.length - 1];
  const med = (sel) => {
    const a = validi.map(sel).filter(fin).sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length / 2)] : null;
  };
  const minOf = (sel) => { const a = validi.map(sel).filter(fin); return a.length ? Math.min(...a) : null; };
  const maxOf = (sel) => { const a = validi.map(sel).filter(fin); return a.length ? Math.max(...a) : null; };
  const saltatiTot = validi.reduce((a, c) => a + (c.saltati || 0), 0);

  const righe = [
    `\n### ${oraEtichetta}  ·  ${validi.length} campioni${saltatiTot ? `, ${saltatiTot} saltati` : ''}`,
    '',
    `- ordini a riposo: mediana ${num(med((c) => c.ordiniAperti))}`
      + ` (min ${num(minOf((c) => c.ordiniAperti))}, max ${num(maxOf((c) => c.ordiniAperti))}) · ricostruito`,
    `- mercati con posizione: ${num(ultimo.mercatiConPosizione)}`
      + ` — coppie ${num(ultimo.mercatiEntrambeGambe)}, gambe nude ${num(ultimo.mercatiUnaGamba)}`,
    `- posizioni: ${num(ultimo.posizioniAperte)} per ${usd(ultimo.posizioniValoreUsd)}`,
    `- saldo ${usd(ultimo.saldoUsd)} · totale ${usd(ultimo.totalePortafoglioUsd)}`,
    `- PnL guardiano ${usd(ultimo.pnlGuardianoUsd)} su baseline ${usd(ultimo.baselineUsd)}`,
    `- reward di oggi: ${usd(ultimo.rewardOggiUsd)}`,
    `- stato: bot ${ultimo.botAttivo === true ? 'ATTIVO' : (ultimo.botAttivo === false ? 'FERMA' : '—')}`
      + ` · kill ${ultimo.killAttivo === true ? 'ON' : (ultimo.killAttivo === false ? 'off' : '—')}`
      + ` · latch ${ultimo.latchGuardiano === true ? 'SCATTATO' : 'disarmato'}`,
    '',
  ];
  return righe.join('\n');
}

/**
 * QUALI FILE DI GIORNALE VANNO CANCELLATI. Puro: riceve i nomi, restituisce quelli scaduti.
 * Un nome che non corrisponde al formato atteso NON viene mai cancellato — l'osservatore non deve
 * poter rimuovere un file che non ha scritto lui.
 */
function fileDaCancellare({ nomi = [], oggiIso = null, giorniDaTenere = GIORNI_DA_TENERE } = {}) {
  const oggi = oggiIso ? Date.parse(`${oggiIso}T00:00:00Z`) : NaN;
  if (!fin(oggi)) return [];
  const limite = oggi - giorniDaTenere * 86400_000;
  return (nomi || []).filter((n) => {
    const m = /^(campioni|giornale)-(\d{4}-\d{2}-\d{2})\.(jsonl|md)$/.exec(String(n));
    if (!m) return false;
    const t = Date.parse(`${m[2]}T00:00:00Z`);
    return fin(t) && t < limite;
  });
}

module.exports = {
  costruisciCampione, analizzaPosizioni, transizioniCopertura,
  rigaEvento, bloccoSintesi, fileDaCancellare,
  CADENZA_MS, TOLLERANZA_SALTO_MS, GIORNI_DA_TENERE, LARGHEZZA_MAX,
};
