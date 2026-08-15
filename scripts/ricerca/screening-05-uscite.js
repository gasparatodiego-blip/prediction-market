'use strict';
// scripts/ricerca/screening-05-uscite.js — COME ESCONO I 65 DOPO UN FILL. Sola lettura.
//
//   node scripts/ricerca/screening-05-uscite.js [--giorni 7] [--orizzonte-h 24] [--rifai]
//
// ═══ LA SCOPERTA CHE RENDE POSSIBILE LA DOMANDA: `takerOnly` ═════════════════════════════════════
// `/activity?type=TRADE` NON dice se il wallet ha preso o posato, e senza quello due delle quattro
// misure chieste non esistono. `/trades` invece accetta **`takerOnly`**, ed è verificato:
//   · `takerOnly=true` (che è anche il DIFETTO, misurato: le due risposte sono identiche riga per
//     riga) → i soli fill in cui il wallet ha **preso**;
//   · `takerOnly=false` → **tutti** i fill.
// L'etichetta si ottiene per differenza: un fill che sta in «tutti» e non in «taker» è un fill
// **maker**, cioè un ordine che stava a libro ed è stato colpito. Le due liste si allineano sulla
// chiave economica `conditionId|asset|timestamp|price|size|side`.
//
// ⚠ LE DUE LISTE COPRONO ARCHI DIVERSI A PARITÀ DI `limit`, perché una è un sottoinsieme dell'altra:
// 500 righe taker risalgono più indietro di 500 righe totali. Si tronca quindi la finestra di
// classificazione all'intervallo **coperto da entrambe**, o un fill maker vecchio verrebbe etichettato
// «maker» solo perché la lista taker non arrivava fin lì.
//
// ═══ COSA CONTA COME EVENTO, E PERCHÉ NON OGNI RIGA ══════════════════════════════════════════════
// L'evento è un **BUY**: è il fill che lascia esposti, ed è la domanda dell'operatore. Ma un ordine a
// libro viene riempito **a pezzi**, e ogni pezzo è una riga: contarli tutti farebbe apparire come
// «aumenta la posizione» (classe D) quello che è un solo ordine che si riempie. Quindi le righe
// consecutive con stesso lato, stesso esito e **stesso prezzo** entro `FINESTRA_UNIONE_S` si fondono
// in un evento solo. La sensibilità a questa scelta viene misurata e riportata, non assunta.
//
// ═══ LA CENSURA, CHE È LA PARTE CHE SI SBAGLIA PIÙ FACILMENTE ════════════════════════════════════
// Un fill avvenuto dieci minuti prima della fine del campione NON è «non ha fatto nulla»: è un fill
// che non abbiamo ancora finito di guardare. Classificarlo C gonfierebbe C di tutta la coda recente.
// Quindi: se esiste un'azione successiva entro l'orizzonte ⇒ si classifica; se non esiste MA il
// campione prosegue per almeno un orizzonte oltre l'evento ⇒ C; altrimenti ⇒ **censurato**, escluso
// dalle percentuali e contato a parte.

const { apiGet, inParallelo, scrivi, leggi, mediana } = require('./screening-lib');

const argomenti = process.argv.slice(2);
const arg = (nome, difetto) => {
  const i = argomenti.indexOf(nome);
  return i >= 0 ? Number(argomenti[i + 1]) : difetto;
};
const GIORNI = arg('--giorni', 7);
const ORIZZONTE_H = arg('--orizzonte-h', 24);
const PER_PAGINA = 500;
const PAGINE_MAX = 12;
/** Due righe con stesso lato/esito/prezzo entro questo intervallo sono lo stesso ordine. */
const FINESTRA_UNIONE_S = 120;

/**
 * ⚠ I PREZZI DELLA API ARRIVANO CON RUMORE DI VIRGOLA MOBILE: `0.8599999965` e `0.86` sono lo stesso
 * prezzo e arrivano ENTRAMBI. Senza normalizzare, due pezzi dello stesso ordine finiscono in gruppi
 * diversi e non si fondono — misurato: 1.155 eventi a prezzo «diverso» di 3,5e-9 classificati come
 * «aumenta la posizione». Il tick del venue è 0,001: quattro decimali sono un margine abbondante.
 */
const prezzo = (p) => Math.round(Number(p) * 1e4) / 1e4;

const chiave = (t) => [t.conditionId, t.asset, t.timestamp, prezzo(t.price), t.size, t.side].join('|');

/** Pagina `/trades` all'indietro finché copre `daTs` o finisce le pagine. */
async function scarica(wallet, soloTaker, daTs) {
  const righe = new Map();
  let piuVecchio = Infinity;
  let pagine = 0;
  for (let p = 0; p < PAGINE_MAX; p += 1) {
    const r = await apiGet(`/trades?user=${wallet}&takerOnly=${soloTaker}&limit=${PER_PAGINA}&offset=${p * PER_PAGINA}`);
    if (!r.ok || !Array.isArray(r.dati)) return { ok: false, errore: r.errore || 'non lista' };
    pagine += 1;
    for (const t of r.dati) {
      righe.set(chiave(t), t);
      if (t.timestamp < piuVecchio) piuVecchio = t.timestamp;
    }
    if (r.dati.length < PER_PAGINA) break;      // esaurito: non c'è altro
    if (piuVecchio <= daTs) break;              // coperta la finestra chiesta
  }
  return { ok: true, righe: [...righe.values()], piuVecchio, pagine, esaurito: pagine < PAGINE_MAX };
}

/** Fonde i fill parziali dello stesso ordine. Restituisce eventi ordinati nel tempo. */
function unisciParziali(trades) {
  // ⚠ SI RAGGRUPPA PRIMA, POI SI FONDE. Confrontare ogni riga con la PRECEDENTE nello stream ordinato
  // per tempo non funziona: i fill sono interlacciati fra mercati diversi, e due pezzi dello stesso
  // ordine separati da un fill altrove non si toccano mai. Misurato sulla prima stesura: **2.049
  // eventi** a prezzo identico ed entro 120 s erano sopravvissuti alla fusione, e finivano tutti in
  // classe D — cioè «aumenta la posizione» era in parte un artefatto del modo di contare.
  const gruppi = new Map();
  for (const t of trades) {
    const g = [t.conditionId, t.asset, t.side, prezzo(t.price)].join('|');
    if (!gruppi.has(g)) gruppi.set(g, []);
    gruppi.get(g).push(t);
  }

  const fuori = [];
  for (const [, righe] of gruppi) {
    righe.sort((a, b) => a.timestamp - b.timestamp);
    let corrente = null;
    for (const t of righe) {
      if (corrente && (t.timestamp - corrente.ultimoTs) <= FINESTRA_UNIONE_S) {
        corrente.size += Number(t.size);
        corrente.ultimoTs = t.timestamp;
        corrente.pezzi += 1;
        // Un ordine fuso è «taker» se ANCHE UN SOLO pezzo lo era: un ordine che attraversa in parte
        // e riposa in parte è, per la domanda dell'operatore, un ordine che ha preso.
        corrente.taker = corrente.taker || t.taker === true;
        continue;
      }
      corrente = {
        conditionId: t.conditionId, asset: t.asset, side: t.side,
        outcomeIndex: Number(t.outcomeIndex), price: prezzo(t.price), size: Number(t.size),
        timestamp: t.timestamp, ultimoTs: t.timestamp, pezzi: 1, taker: t.taker === true,
        title: t.title || '', slug: t.slug || '',
      };
      fuori.push(corrente);
    }
  }
  return fuori.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * CLASSIFICA le uscite di un wallet.
 * @returns {{eventi:Array, censurati:number}}
 */
function classifica(eventi, tMax, orizzonteS) {
  // Un indice per mercato: la risposta a un fill sta sullo stesso `conditionId`, non altrove.
  const perMercato = new Map();
  for (const e of eventi) {
    if (!perMercato.has(e.conditionId)) perMercato.set(e.conditionId, []);
    perMercato.get(e.conditionId).push(e);
  }

  const fuori = [];
  let censurati = 0;
  for (const [, lista] of perMercato) {
    lista.sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 0; i < lista.length; i += 1) {
      const e = lista[i];
      if (e.side !== 'BUY') continue;   // l'evento è il fill che lascia esposti

      // La prima azione successiva SULLO STESSO MERCATO, entro l'orizzonte.
      let seguito = null;
      for (let j = i + 1; j < lista.length; j += 1) {
        if (lista[j].timestamp <= e.ultimoTs) continue;
        if (lista[j].timestamp - e.ultimoTs > orizzonteS) break;
        seguito = lista[j];
        break;
      }

      if (!seguito) {
        // Nessuna azione: è «non fa nulla» solo se abbiamo davvero guardato per un orizzonte intero.
        if (tMax - e.ultimoTs >= orizzonteS) {
          fuori.push({ classe: 'C', mercato: e.conditionId, title: e.title, ts: e.timestamp,
            prezzo: e.price, outcomeIndex: e.outcomeIndex, taker: e.taker, size: e.size });
        } else {
          censurati += 1;
        }
        continue;
      }

      const dt = seguito.timestamp - e.ultimoTs;
      const base = { mercato: e.conditionId, title: e.title, ts: e.timestamp, dtSec: dt,
        prezzo: e.price, outcomeIndex: e.outcomeIndex, taker: e.taker, size: e.size,
        seguitoTaker: seguito.taker, seguitoPrezzo: seguito.price };

      if (seguito.side === 'BUY' && seguito.outcomeIndex !== e.outcomeIndex) {
        fuori.push({ ...base, classe: 'A', costoCoppiaCents: (e.price + seguito.price) * 100 });
      } else if (seguito.side === 'SELL' && seguito.outcomeIndex === e.outcomeIndex) {
        fuori.push({ ...base, classe: 'B', deltaCents: (seguito.price - e.price) * 100 });
      } else if (seguito.side === 'BUY' && seguito.outcomeIndex === e.outcomeIndex) {
        fuori.push({ ...base, classe: 'D' });
      } else {
        // SELL sull'altro esito: sta smontando una coppia, non uscendo da questo fill. È una classe
        // sua, dichiarata: schiacciarla su B direbbe «rivende lo stesso outcome» di un fatto diverso.
        fuori.push({ ...base, classe: 'E' });
      }
    }
  }
  return { eventi: fuori, censurati };
}

async function main() {
  const referto = leggi('screening-04-referto.json');
  const lista = referto.passatiWallet.map((r) => r.wallet);
  const rewardsDi = new Map(referto.passatiWallet.map((r) => [r.wallet, r.rewards14g]));
  const orizzonteS = ORIZZONTE_H * 3600;
  const daTs = Math.floor(Date.now() / 1000) - GIORNI * 86400;

  console.log(`${lista.length} wallet · finestra ${GIORNI} giorni · orizzonte di classificazione ${ORIZZONTE_H}h`);

  const precedenti = new Map();
  if (!argomenti.includes('--rifai')) {
    try {
      for (const r of (leggi('screening-05-uscite.json').perWallet || [])) if (r && r.ok) precedenti.set(r.wallet, r);
    } catch { /* nessun checkpoint */ }
  }
  const daFare = lista.filter((w) => !precedenti.has(w));
  console.log(`già letti: ${lista.length - daFare.length} · da leggere: ${daFare.length}`);

  const parziali = new Map(precedenti);
  const esiti = await inParallelo(daFare, 5, async (wallet) => {
    const [tutti, taker] = await Promise.all([
      scarica(wallet, false, daTs),
      scarica(wallet, true, daTs),
    ]);
    if (!tutti.ok) return { wallet, ok: false, errore: `tutti: ${tutti.errore}` };
    if (!taker.ok) return { wallet, ok: false, errore: `taker: ${taker.errore}` };

    const insiemeTaker = new Set(taker.righe.map(chiave));
    // ⚠ La finestra utile è quella coperta da ENTRAMBE le liste (vedi l'intestazione).
    const inizio = Math.max(tutti.piuVecchio, taker.piuVecchio);
    const usabili = tutti.righe
      .filter((t) => t.timestamp >= inizio)
      .map((t) => ({ ...t, taker: insiemeTaker.has(chiave(t)) }));
    if (!usabili.length) return { wallet, ok: false, errore: 'nessun trade nella finestra comune' };

    const tMax = Math.max(...usabili.map((t) => t.timestamp));
    const eventi = unisciParziali(usabili);
    const c = classifica(eventi, tMax, orizzonteS);

    // Sensibilità alla fusione dei parziali: si riclassifica SENZA fondere e si confronta la quota D.
    const senzaFusione = classifica(
      usabili.map((t) => ({ ...t, ultimoTs: t.timestamp, outcomeIndex: Number(t.outcomeIndex), price: prezzo(t.price) })),
      tMax, orizzonteS,
    );

    const riga = {
      wallet, ok: true,
      rewards14g: rewardsDi.get(wallet),
      tradeTotali: usabili.length,
      tradeTaker: usabili.filter((t) => t.taker).length,
      eventiFusi: eventi.length,
      pagineTutti: tutti.pagine, pagineTaker: taker.pagine,
      copertura: { da: new Date(inizio * 1000).toISOString(), a: new Date(tMax * 1000).toISOString(),
        ore: (tMax - inizio) / 3600 },
      censurati: c.censurati,
      eventi: c.eventi,
      quotaDSenzaFusione: senzaFusione.eventi.length
        ? senzaFusione.eventi.filter((e) => e.classe === 'D').length / senzaFusione.eventi.length : null,
    };
    parziali.set(wallet, riga);
    return riga;
  }, (fatti, tot) => console.log(`  … ${fatti}/${tot}`));

  for (const e of esiti) if (e && e.ok) parziali.set(e.wallet, e);
  const buoni = [...parziali.values()].filter((r) => r.ok);
  const falliti = esiti.filter((e) => e && !e.ok);

  const out = {
    generatoIl: new Date().toISOString(),
    parametri: { giorni: GIORNI, orizzonteH: ORIZZONTE_H, finestraUnioneS: FINESTRA_UNIONE_S },
    walletLetti: buoni.length,
    walletFalliti: falliti.length,
    erroriCampione: falliti.slice(0, 8),
    perWallet: buoni,
  };
  const f = scrivi('screening-05-uscite.json', out);
  console.log(`\nletti ${buoni.length}/${lista.length} · falliti ${falliti.length}`);
  console.log(`scritto ${f}`);
}

main().catch((e) => { console.error('errore:', e.message); process.exit(1); });
