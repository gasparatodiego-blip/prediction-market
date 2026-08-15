'use strict';
// scripts/ricerca/screening-03-posizioni.js — POSIZIONI, DUE-LATERALITÀ, P&L E CAPITALE DEI CANDIDATI.
//
//   node scripts/ricerca/screening-03-posizioni.js [--giorni-min 10] [--limite N] [--rifai]
//
// Prende dallo stadio 2 i wallet che superano i filtri ECONOMICI (ricorrenza e importo), che non
// costano rete, e per quelli soli interroga quattro fonti pubbliche e una lettura on-chain.
//
// ═══ ⚠ LA SIMMETRIA DELLE POSIZIONI NON FUNZIONA COME CRITERIO, ED È UNA MISURA, NON UN'OPINIONE ══
// La prima stesura cercava il quoting a due lati come «YES e NO dello stesso `conditionId` in
// quantità simili». Misurato sui primi 8 candidati: quota di valore appaiato 0-58%, ma simmetria
// media **0,00-0,06**, cioè il segnale è piatto e non discrimina nessuno. La ragione è nota e sta
// già in §5-bis p.150: una coppia COMPLETA si fonde on-chain o si riscatta, quindi **sparisce dalle
// posizioni**. Chi appaia bene mostra meno simmetria di chi appaia male. Il criterio, preso da solo,
// è invertito rispetto a ciò che cerca.
//
// ⇒ LA DUE-LATERALITÀ SI MISURA SUI **TRADE**, non sulle posizioni: la frazione di mercati in cui il
// wallet ha eseguito su ENTRAMBI gli `outcomeIndex`. Un fill sopravvive al merge, una posizione no.
// **Calibrato su un maker a due lati NOTO** — il funder di questo bot, 0x4C81F19a… — che segna
// **52%** contro il 2-6% dei direzionali del campione. La simmetria delle posizioni resta calcolata
// e riportata, ma come indizio secondario dichiarato tale.
//
// ⚠ IL CAMPIONE DEI TRADE È A NUMERO FISSO (500), NON A FINESTRA FISSA: copre archi molto diversi
// (3-377 ore nel campione). La frazione resta confrontabile — è una proporzione, non un tasso — ma
// l'arco va riportato accanto, o si confrontano wallet che vivono in tempi diversi.
//
// ⚠ `/positions` SI CHIEDE ORDINATO PER VALORE E TRONCATO A 500: un wallet ne ha fino a 4.000, quasi
// tutte residui. Il troncamento è quindi sui più piccoli, ed è dichiarato nel record (`troncato`).
// Il valore TOTALE non si somma da lì — si legge da `/value`, che lo dà esatto in una chiamata.

const { apiGet, rpc, inParallelo, scrivi, leggi, PUSD } = require('./screening-lib');

const argomenti = process.argv.slice(2);
const arg = (nome, difetto) => {
  const i = argomenti.indexOf(nome);
  return i >= 0 ? Number(argomenti[i + 1]) : difetto;
};
const GIORNI_MIN = arg('--giorni-min', 10);
const LIMITE = arg('--limite', null);
/** Il filtro sull'importo: «scarta … importi sotto $1», letto come «la giornata TIPICA sotto $1». */
const MEDIANA_MIN_USD = 1;
/** Sotto questa soglia una posizione è un residuo, non un mercato quotato. Vedi §5-bis p.123. */
const VALORE_MIN_MERCATO = 5;
/** «coppie simmetriche o quasi»: la gamba corta almeno il 70% della lunga. */
const SOGLIA_SIMMETRIA = 0.70;
const PER_PAGINA = 500;

/** `balanceOf(address)` — selettore fisso, nessuna ABI da caricare. */
const SELETTORE_BALANCE_OF = '0x70a08231';

async function contante(wallet) {
  const dato = SELETTORE_BALANCE_OF + '0'.repeat(24) + wallet.replace(/^0x/, '').toLowerCase();
  try {
    const r = await rpc('eth_call', [{ to: PUSD, data: dato }, 'latest']);
    if (!r || r === '0x') return null;
    return Number(BigInt(r)) / 1e6;
  } catch { return null; }   // non letto ≠ zero
}

function analizzaPosizioni(righe) {
  const perMercato = new Map();
  for (const p of righe) {
    const cid = String(p.conditionId || '');
    if (!cid) continue;
    const size = Number(p.size);
    const valore = Number(p.currentValue);
    if (!Number.isFinite(size) || size <= 0) continue;
    if (!perMercato.has(cid)) {
      perMercato.set(cid, {
        conditionId: cid, title: p.title || '', slug: p.slug || '',
        endDate: p.endDate || null, si: 0, no: 0, valore: 0,
      });
    }
    const m = perMercato.get(cid);
    // `outcomeIndex` 0 = primo esito, 1 = secondo. Si usa l'INDICE e non l'etichetta: sui mercati
    // non binari per nome la stringa cambia, l'indice no.
    if (Number(p.outcomeIndex) === 1) m.no += size; else m.si += size;
    if (Number.isFinite(valore)) m.valore += valore;
  }

  const tutti = [...perMercato.values()];
  const rilevanti = tutti.filter((m) => m.valore >= VALORE_MIN_MERCATO);
  let appaiati = 0;
  let sommaSimmetria = 0;
  for (const m of rilevanti) {
    const alto = Math.max(m.si, m.no);
    m.simmetria = alto > 0 ? Math.min(m.si, m.no) / alto : 0;
    if (m.simmetria >= SOGLIA_SIMMETRIA) appaiati += 1;
    sommaSimmetria += m.simmetria;
  }

  return {
    mercatiConPosizione: rilevanti.length,
    mercatiTotaliInPagina: tutti.length,
    mercatiAppaiati: appaiati,
    simmetriaMedia: rilevanti.length ? sommaSimmetria / rilevanti.length : 0,
    valoreInPagina: tutti.reduce((a, m) => a + m.valore, 0),
    mercati: rilevanti.map((m) => ({
      conditionId: m.conditionId, title: m.title, slug: m.slug,
      endDate: m.endDate, valore: m.valore, simmetria: m.simmetria,
    })),
  };
}

function analizzaTrade(righe) {
  const perCid = new Map();
  let primo = null;
  let ultimo = null;
  for (const t of righe) {
    const cid = String(t.conditionId || '');
    if (!cid) continue;
    const ts = Number(t.timestamp);
    if (Number.isFinite(ts)) {
      if (primo === null || ts < primo) primo = ts;
      if (ultimo === null || ts > ultimo) ultimo = ts;
    }
    if (!perCid.has(cid)) perCid.set(cid, { lati: new Set(), n: 0, title: t.title || '', slug: t.slug || '' });
    const m = perCid.get(cid);
    m.lati.add(Number(t.outcomeIndex));
    m.n += 1;
  }
  const mercati = [...perCid.entries()];
  const dueLati = mercati.filter(([, m]) => m.lati.size >= 2);
  return {
    tradeLetti: righe.length,
    mercatiScambiati: mercati.length,
    mercatiDueLati: dueLati.length,
    quotaDueLati: mercati.length ? dueLati.length / mercati.length : 0,
    arcoOre: primo !== null && ultimo !== null ? (ultimo - primo) / 3600 : null,
    mercatiRecenti: mercati.map(([cid, m]) => ({
      conditionId: cid, title: m.title, slug: m.slug, trade: m.n, dueLati: m.lati.size >= 2,
    })),
  };
}

async function main() {
  const storico = leggi('screening-02-storico.json');

  // ── I FILTRI CHE NON COSTANO RETE, applicati per primi ─────────────────────────────────────────
  const candidati = storico.righe.filter((r) => r.ok
    && r.giorniAttivi >= GIORNI_MIN
    && r.medianaGiornaliera >= MEDIANA_MIN_USD
    && r.pagamentiTotaliStorici > 1);
  console.log(`stadio 2: ${storico.righe.length} wallet · candidati dopo ricorrenza ≥${GIORNI_MIN}/14 e mediana ≥$${MEDIANA_MIN_USD}: ${candidati.length}`);

  let lista = candidati.map((c) => c.wallet);
  if (LIMITE) lista = lista.slice(0, LIMITE);

  const precedenti = new Map();
  if (!argomenti.includes('--rifai')) {
    try {
      for (const r of (leggi('screening-03-posizioni.json').righe || [])) if (r && r.ok) precedenti.set(r.wallet, r);
    } catch { /* nessun checkpoint */ }
  }
  const daFare = lista.filter((w) => !precedenti.has(w));
  console.log(`già letti: ${lista.length - daFare.length} · da leggere: ${daFare.length}`);

  const parziali = new Map(precedenti);
  const salva = () => scrivi('screening-03-posizioni.json', {
    generatoIl: new Date().toISOString(),
    parziale: parziali.size < lista.length,
    filtri: {
      giorniMin: GIORNI_MIN, medianaMinUsd: MEDIANA_MIN_USD,
      valoreMinMercato: VALORE_MIN_MERCATO, sogliaSimmetria: SOGLIA_SIMMETRIA,
    },
    candidati: lista.length,
    letti: parziali.size,
    righe: [...parziali.values()],
  });

  await inParallelo(daFare, 6, async (wallet) => {
    const [pos, val, prof, tra] = await Promise.all([
      apiGet(`/positions?user=${wallet}&limit=${PER_PAGINA}&sortBy=CURRENT&sortDirection=DESC`),
      apiGet(`/value?user=${wallet}`),
      apiGet(`/profit?window=7d&address=${wallet}`, 0, 'lb-api.polymarket.com'),
      apiGet(`/activity?user=${wallet}&type=TRADE&limit=${PER_PAGINA}`),
    ]);
    if (!pos.ok || !Array.isArray(pos.dati)) return { wallet, ok: false, errore: `positions: ${pos.errore || 'non lista'}` };
    if (!tra.ok || !Array.isArray(tra.dati)) return { wallet, ok: false, errore: `trade: ${tra.errore || 'non lista'}` };

    const a = analizzaPosizioni(pos.dati);
    const t = analizzaTrade(tra.dati);
    const valorePosizioni = (val.ok && Array.isArray(val.dati) && val.dati[0] && Number.isFinite(Number(val.dati[0].value)))
      ? Number(val.dati[0].value) : null;
    const pnl7g = (prof.ok && Array.isArray(prof.dati) && prof.dati[0] && Number.isFinite(Number(prof.dati[0].amount)))
      ? Number(prof.dati[0].amount) : null;
    const cash = await contante(wallet);

    const riga = {
      wallet, ok: true,
      ...a, ...t,
      troncato: pos.dati.length >= PER_PAGINA,
      valorePosizioni,
      pnl7g,
      contanteUsd: cash,
      // Non misurabile ⇒ `null`, mai zero: un capitale illeggibile trattato come 0 direbbe
      // «wallet vuoto» proprio dove la lettura è fallita (§5.3).
      capitaleStimato: (cash === null || valorePosizioni === null) ? null : cash + valorePosizioni,
    };
    parziali.set(wallet, riga);
    return riga;
  }, (fatti, tot) => {
    console.log(`  … ${fatti}/${tot}`);
    if (fatti % 200 === 0) salva();
  });

  const f = salva();
  console.log(`\nletti ${parziali.size}/${lista.length}`);
  console.log(`scritto ${f}`);
}

main().catch((e) => { console.error('errore:', e.message); process.exit(1); });
