'use strict';
// scripts/ricerca/screening-02-storico.js — I 14 GIORNI DI PAGAMENTI, WALLET PER WALLET.
//
//   node scripts/ricerca/screening-02-storico.js [--limite N] [--solo-batch]
//
// ═══ PERCHÉ L'UNIVERSO È LA GIORNATA E NON IL BATCH ══════════════════════════════════════════════
// L'operatore ha indicato una tx da 400 destinatari. Misurato in fase 1: quel giorno ha **6 batch e
// 2.320 destinatari distinti**, quindi la tx è il **17,2%** della giornata. Il filtro che conta è la
// RICORRENZA (≥10 giorni su 14): un wallet presente 10 giorni su 14 è presente il 2026-08-14 con
// probabilità altissima, quindi la lista della GIORNATA è un universo quasi completo di quella
// popolazione, mentre il batch ne scarterebbe l'83% **a caso**. Si screena la giornata e si segna
// quali wallet appartengono al batch indicato (`nelBatch`), così la lista dell'operatore resta
// leggibile dentro il risultato. `--solo-batch` fa l'altra scelta, per chi la volesse.
//
// ═══ PERCHÉ NON SI SCANSIONA LA CATENA PER 14 GIORNI ═════════════════════════════════════════════
// Provato e misurato: `polygon-bor-rpc.publicnode.com` risponde «History has been pruned for this
// block» già a −2 giorni (e a −5, −9, −14). Non è una finestra da spezzare, è storia che quel nodo
// non ha. Etherscan avrebbe i dati ma vuole `POLYGONSCAN_API_KEY`, assente da questo `.env`.
// Quindi i 14 giorni vengono dalla Data API PUBBLICA, un wallet per volta:
//     GET /activity?user=<wallet>&type=REWARD   → `usdcSize`, `timestamp`, `transactionHash`
// È la stessa fonte del consuntivo del bot (§4.12, `lib/maker/reward-reale.js:62`).

const { apiGet, inParallelo, giornoDiCompetenza, scrivi, leggi, mediana } = require('./screening-lib');

const GIORNI_FINESTRA = 14;
/** Le righe REWARD sono poche (≤ qualche unità al giorno): 500 copre mesi. Si pagina lo stesso. */
const PER_PAGINA = 500;
const PAGINE_MAX = 6;

const argomenti = process.argv.slice(2);
const limite = (() => {
  const i = argomenti.indexOf('--limite');
  return i >= 0 ? Number(argomenti[i + 1]) : null;
})();
const soloBatch = argomenti.includes('--solo-batch');

/** Tutti i pagamenti REWARD di un wallet, paginati fino a esaurimento. */
async function pagamenti(wallet) {
  const righe = [];
  for (let pagina = 0; pagina < PAGINE_MAX; pagina += 1) {
    const r = await apiGet(`/activity?user=${wallet}&type=REWARD&limit=${PER_PAGINA}&offset=${pagina * PER_PAGINA}`);
    // ⚠ UN ERRORE NON È UNA LISTA VUOTA. Propagare `ok:false` invece di `[]` è la differenza fra
    // «non ho letto» e «non ha mai incassato»: il secondo escluderebbe il wallet dallo screening
    // per un 429. §5.3, `Number(null) === 0`, la stessa famiglia.
    if (!r.ok) return { ok: false, errore: r.errore };
    if (!Array.isArray(r.dati)) return { ok: false, errore: 'risposta non è una lista' };
    righe.push(...r.dati);
    if (r.dati.length < PER_PAGINA) break;
  }
  return { ok: true, righe };
}

async function main() {
  const base = leggi('screening-01-destinatari.json');
  const nelBatch = new Set(base.righe.map((r) => r.wallet));

  let universo;
  if (soloBatch || !base.giornata.misurato) {
    universo = base.righe.map((r) => r.wallet);
  } else {
    universo = base.giornata.righe.map((r) => r.wallet);
  }
  if (limite) universo = universo.slice(0, limite);

  // ── LA FINESTRA: 14 DATE DI PAGAMENTO, non 14 giorni di competenza ─────────────────────────────
  // L'ancora è la DATA della tx indicata (2026-08-15, il giro delle 00:00:04). Si prendono le 14 date
  // UTC che finiscono lì. Filtrare per competenza invece che per data grezza lascerebbe dentro mezza
  // giornata in più in fondo (i bonus delle 16:00 del primo giorno) e produrrebbe 15 date distinte
  // su una finestra dichiarata di 14.
  const ultimaData = base.istante.slice(0, 10);
  const giorni = [];
  for (let i = GIORNI_FINESTRA - 1; i >= 0; i -= 1) {
    giorni.push(new Date(Date.parse(ultimaData + 'T00:00:00Z') - i * 86400_000).toISOString().slice(0, 10));
  }
  const dentro = new Set(giorni);

  // ── RIPRESA: un giro interrotto non si ricomincia da capo ─────────────────────────────────────
  // ⚠ Il primo giro completo è stato ucciso a metà e ha perso 2.320 letture. Da allora i risultati
  // già letti si rileggono da disco e si saltano: la Data API non va interrogata due volte per lo
  // stesso wallet solo perché il processo è morto. `--rifai` forza il giro pieno.
  const precedenti = new Map();
  if (!argomenti.includes('--rifai')) {
    try {
      const vecchio = leggi('screening-02-storico.json');
      if (vecchio && vecchio.finestra && vecchio.finestra.da === giorni[0] && vecchio.finestra.a === giorni[13]) {
        for (const r of vecchio.righe || []) if (r && r.ok) precedenti.set(r.wallet, r);
      }
    } catch { /* nessun checkpoint */ }
  }
  const daFare = universo.filter((w) => !precedenti.has(w));
  console.log(`universo: ${universo.length} wallet · finestra ${giorni[0]} … ${giorni[13]} (${GIORNI_FINESTRA} giorni)`);
  console.log(`già letti da un giro precedente: ${universo.length - daFare.length} · da leggere: ${daFare.length}`);

  const parziali = new Map(precedenti);
  const salvaParziale = () => scrivi('screening-02-storico.json', {
    generatoIl: new Date().toISOString(),
    parziale: parziali.size < universo.length,
    fonte: 'data-api.polymarket.com/activity?type=REWARD',
    finestra: { da: giorni[0], a: giorni[13], giorni: GIORNI_FINESTRA },
    walletInterrogati: universo.length,
    walletLetti: parziali.size,
    righe: [...parziali.values()],
  });

  const esiti = await inParallelo(daFare, 6, async (wallet) => {
    const p = await pagamenti(wallet);
    if (!p.ok) return { wallet, ok: false, errore: p.errore };

    const perGiorno = new Map();
    const perData = new Map();
    const pagamentiInFinestra = [];
    let pagamentiTotali = 0;
    let primoTs = null;
    let ultimoTs = null;
    for (const r of p.righe) {
      const ts = Number(r.timestamp);
      if (!Number.isFinite(ts)) continue;
      pagamentiTotali += 1;
      if (primoTs === null || ts < primoTs) primoTs = ts;
      if (ultimoTs === null || ts > ultimoTs) ultimoTs = ts;
      const d = new Date(ts * 1000).toISOString().slice(0, 10);
      if (!dentro.has(d)) continue;
      const usd = Number(r.usdcSize);
      if (!Number.isFinite(usd)) continue;   // una riga illeggibile non vale zero: si salta
      const g = giornoDiCompetenza(ts);
      perGiorno.set(g, (perGiorno.get(g) || 0) + usd);
      // ⚠ SI TIENE ANCHE LA DATA GREZZA, e non è ridondanza. Misurato: il 2026-08-14 il venue NON ha
      // pagato a mezzanotte (il giro è uscito alle 16:23), quindi la competenza 08-13 resta quasi
      // vuota e la 08-14 ne raccoglie due. Contare i giorni per COMPETENZA punirebbe tutti di un
      // giorno per un ritardo del venue; contarli per data grezza no. Il referto usa la seconda.
      perData.set(d, (perData.get(d) || 0) + usd);
      // Le righe grezze restano su disco: così ogni ri-bucketizzazione è offline, senza rileggere l'API.
      pagamentiInFinestra.push({ ts, usd, tx: r.transactionHash });
    }

    const valori = [...perData.values()];
    const riga = {
      wallet,
      ok: true,
      nelBatch: nelBatch.has(wallet),
      giorniAttivi: perData.size,             // per DATA GREZZA — vedi la nota qui sopra
      giorniAttiviCompetenza: perGiorno.size,  // tenuto per confronto, non è il criterio
      rewards14g: valori.reduce((a, b) => a + b, 0),
      medianaGiornaliera: mediana(valori),
      maxGiornaliero: valori.length ? Math.max(...valori) : 0,
      minGiornaliero: valori.length ? Math.min(...valori) : 0,
      pagamentiTotaliStorici: pagamentiTotali,
      primoPagamento: primoTs ? new Date(primoTs * 1000).toISOString() : null,
      ultimoPagamento: ultimoTs ? new Date(ultimoTs * 1000).toISOString() : null,
      perGiorno: Object.fromEntries([...perGiorno.entries()].sort()),
      perData: Object.fromEntries([...perData.entries()].sort()),
      pagamenti: pagamentiInFinestra,
    };
    parziali.set(wallet, riga);   // il checkpoint legge da qui, non dal valore di ritorno
    return riga;
  }, (fatti, tot) => {
    console.log(`  … ${fatti}/${tot}`);
    if (fatti % 250 === 0) salvaParziale();
  });

  for (const e of esiti) if (e && e.ok) parziali.set(e.wallet, e);
  const buoni = [...parziali.values()];
  const falliti = esiti.filter((e) => e && !e.ok);

  const out = {
    generatoIl: new Date().toISOString(),
    fonte: 'data-api.polymarket.com/activity?type=REWARD',
    universo: soloBatch ? 'batch della tx indicata' : 'giornata intera del 2026-08-14 (6 batch)',
    finestra: { da: giorni[0], a: giorni[13], giorni: GIORNI_FINESTRA },
    walletInterrogati: universo.length,
    walletLetti: buoni.length,
    walletNonLetti: falliti.length,
    erroriCampione: falliti.slice(0, 10),
    righe: buoni,
  };
  const f = scrivi('screening-02-storico.json', out);

  const perRicorrenza = {};
  for (const b of buoni) perRicorrenza[b.giorniAttivi] = (perRicorrenza[b.giorniAttivi] || 0) + 1;
  console.log(`\nletti ${buoni.length}/${universo.length} · non letti ${falliti.length}`);
  console.log('distribuzione dei giorni attivi su 14:');
  for (let g = 14; g >= 0; g -= 1) if (perRicorrenza[g]) console.log(`  ${String(g).padStart(2)} giorni: ${perRicorrenza[g]}`);
  console.log(`scritto ${f}`);
}

main().catch((e) => { console.error('errore:', e.message); process.exit(1); });
