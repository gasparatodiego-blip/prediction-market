#!/usr/bin/env node
'use strict';
// scripts/ricerca/anzianita-maker.js — DA QUANDO ESISTONO, E SE HANNO CAMBIATO MESTIERE.
//
//   node scripts/ricerca/anzianita-maker.js            i 4 efficienti + i 65
//   node scripts/ricerca/anzianita-maker.js --solo-4   solo i 4 (veloce)
//
// SOLA LETTURA. Nessun ordine, nessuna firma, nessuna transazione. Passa da `screening-lib.js`.
//
// ═══ ⚠ I DUE TETTI DELL'API, MISURATI PRIMA DI SCRIVERE ══════════════════════════════════════════
// `data-api` non permette di ordinare i trade dal più vecchio: si pagina solo dal più recente. Quindi
// «il primo trade in assoluto» si raggiunge solo esaurendo le pagine — e le pagine finiscono:
//   · **`/trades` si ferma a offset 10.000** (10.001 record). Provato: offset 10.000 risponde, 10.001
//     dà errore. Per un wallet con più di 10.001 trade il primo trade **non è raggiungibile**, e la
//     data che si ottiene è un **limite inferiore**: «almeno da», mai «da».
//   · **`/activity` si ferma ancora prima** (fra 5.000 e 8.000): non è un'alternativa.
// Il conteggio esatto dei trade si ottiene con una **ricerca binaria sull'offset** (~20 chiamate
// invece di centinaia), ed è così che si sa in anticipo se un wallet è troncato.
//
// ⚠ MA LA STORIA DEI REWARD È COMPLETA: `/activity?type=REWARD` di questi wallet sta in una pagina
// da 500 (misurato: offset 500 restituisce già zero righe). I premi si pagano una volta al giorno,
// quindi la loro serie è la spina dorsale di questa misura — «da quando incassa» e «quanto
// regolarmente» sono leggibili per intero anche sui wallet il cui trade-stream è troncato.
//
// ═══ COSA VUOL DIRE «HA CAMBIATO MESTIERE» ═══════════════════════════════════════════════════════
// Non è un giudizio: è la composizione dei suoi trade mese per mese. Si misura la quota di trade su
// due famiglie riconoscibili — «Up or Down» (cripto a 5/15 minuti) e meteo — e si guarda se passa da
// ~0 a ~1 o viceversa. Un wallet che per mesi non tocca una famiglia e poi ci fa il 90% dei trade ha
// cambiato mestiere; uno stabile no.

const { apiGet, inParallelo, scrivi, leggi, mediana, contatore } = require('./screening-lib');

const argomenti = process.argv.slice(2);
const SOLO_4 = argomenti.includes('--solo-4');

const PER_PAGINA = 500;
const TETTO_OFFSET = 10_000;           // misurato, non assunto
const PAGINE_MAX = Math.floor(TETTO_OFFSET / PER_PAGINA) + 1;
const FILE_USCITA = 'anzianita-maker.json';

const RE_UPDOWN = /(Bitcoin|Ethereum|Solana|XRP|Dogecoin)\s+Up or Down/i;
const RE_METEO = /\btemperature\b|\bweather\b|\bhighest\s+temp|\blowest\s+temp|\d\s*°\s*[cf]\b/i;

const normId = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');
function numero(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string' && x.trim() !== '') { const v = Number(x); return Number.isFinite(v) ? v : null; }
  return null;
}
const giorno = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
const mese = (ts) => new Date(ts * 1000).toISOString().slice(0, 7);

/** «12:00PM-12:15PM» ⇒ 15. `null` se il titolo non lo dice: non si indovina una durata. */
function durataMinDalTitolo(t) {
  const m = String(t || '').match(/(\d{1,2}):(\d{2})(AM|PM)\s*-\s*(\d{1,2}):(\d{2})(AM|PM)/i);
  if (!m) return null;
  const min = (h, mi, ap) => ((Number(h) % 12) + (/pm/i.test(ap) ? 12 : 0)) * 60 + Number(mi);
  let d = min(m[4], m[5], m[6]) - min(m[1], m[2], m[3]);
  if (d <= 0) d += 24 * 60;
  return d;
}

// ── QUANTI TRADE HA, SENZA SCARICARLI ───────────────────────────────────────────────────────────
/** Ricerca binaria sull'offset. Restituisce anche `troncato`: il conteggio è esatto solo sotto il tetto. */
async function quantiTrade(wallet) {
  const ci = async (off) => {
    const r = await apiGet(`/trades?user=${wallet}&takerOnly=false&limit=1&offset=${off}`);
    return r.ok && Array.isArray(r.dati) && r.dati.length > 0;
  };
  if (!(await ci(0))) return { n: 0, troncato: false };
  let lo = 0, hi = 1;
  while (hi <= TETTO_OFFSET && (await ci(hi))) { lo = hi; hi *= 2; }
  if (hi > TETTO_OFFSET) hi = TETTO_OFFSET + 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (await ci(m)) lo = m; else hi = m;
  }
  const n = lo + 1;
  return { n, troncato: n >= TETTO_OFFSET + 1 };
}

// ── LA STORIA DEI TRADE, AGGREGATA AL VOLO ──────────────────────────────────────────────────────
/**
 * Non si tengono i trade in memoria — sarebbero centinaia di migliaia. Si tiene solo ciò che serve:
 * l'insieme dei GIORNI con almeno un trade, il primo e l'ultimo istante, e per ogni MESE la
 * composizione per famiglia. Il costo di memoria è il numero di giorni, non il numero di trade.
 */
async function storiaTrade(wallet) {
  const giorniAttivi = new Set();
  const perMese = new Map();          // mese → { trade, upDown, upDown15, meteo, altro }
  let primo = null, ultimo = null;
  let primoUpDown = null, primoUpDown15 = null, primoMeteo = null;
  let pagine = 0, troncato = false, letti = 0;

  for (let p = 0; p < PAGINE_MAX; p += 1) {
    const off = p * PER_PAGINA;
    if (off > TETTO_OFFSET) { troncato = true; break; }
    const r = await apiGet(`/trades?user=${wallet}&takerOnly=false&limit=${PER_PAGINA}&offset=${off}`);
    if (!r.ok || !Array.isArray(r.dati)) return { ok: false, errore: r.errore || 'non lista' };
    pagine += 1;
    letti += r.dati.length;
    for (const t of r.dati) {
      const ts = numero(t.timestamp);
      if (ts === null) continue;
      if (primo === null || ts < primo) primo = ts;
      if (ultimo === null || ts > ultimo) ultimo = ts;
      giorniAttivi.add(giorno(ts));
      const titolo = String(t.title || t.slug || '');
      const m = mese(ts);
      if (!perMese.has(m)) perMese.set(m, { trade: 0, upDown: 0, upDown15: 0, meteo: 0, altro: 0, giorni: new Set() });
      const q = perMese.get(m);
      q.trade += 1; q.giorni.add(giorno(ts));
      if (RE_UPDOWN.test(titolo)) {
        q.upDown += 1;
        const d = durataMinDalTitolo(titolo);
        if (d !== null && d <= 15) q.upDown15 += 1;
        if (primoUpDown === null || ts < primoUpDown) primoUpDown = ts;
        if (d !== null && d <= 15 && (primoUpDown15 === null || ts < primoUpDown15)) primoUpDown15 = ts;
      } else if (RE_METEO.test(titolo)) {
        q.meteo += 1;
        if (primoMeteo === null || ts < primoMeteo) primoMeteo = ts;
      } else q.altro += 1;
    }
    if (r.dati.length < PER_PAGINA) break;      // esaurito davvero
    if (off + PER_PAGINA > TETTO_OFFSET) { troncato = true; break; }
  }

  return {
    ok: true, pagine, letti, troncato,
    primo, ultimo, giorniAttivi: giorniAttivi.size,
    primoUpDown, primoUpDown15, primoMeteo,
    perMese: [...perMese.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([m, q]) => ({ mese: m, trade: q.trade, giorniConTrade: q.giorni.size,
        upDown: q.upDown, upDown15: q.upDown15, meteo: q.meteo, altro: q.altro,
        quotaUpDown: q.trade ? q.upDown / q.trade : null,
        quotaMeteo: q.trade ? q.meteo / q.trade : null })),
  };
}

// ── I REWARD, PER INTERO ────────────────────────────────────────────────────────────────────────
async function storiaReward(wallet) {
  const righe = [];
  for (let p = 0; p < 20; p += 1) {
    const r = await apiGet(`/activity?user=${wallet}&type=REWARD&limit=${PER_PAGINA}&offset=${p * PER_PAGINA}`);
    if (!r.ok || !Array.isArray(r.dati)) return { ok: false, errore: r.errore || 'non lista' };
    righe.push(...r.dati);
    if (r.dati.length < PER_PAGINA) break;
  }
  const perMese = new Map();
  let primo = null, ultimo = null;
  const giorni = new Set();
  for (const x of righe) {
    const ts = numero(x.timestamp);
    const usd = numero(x.usdcSize);
    if (ts === null) continue;
    if (primo === null || ts < primo) primo = ts;
    if (ultimo === null || ts > ultimo) ultimo = ts;
    giorni.add(giorno(ts));
    const m = mese(ts);
    if (!perMese.has(m)) perMese.set(m, { usd: 0, pagamenti: 0, giorni: new Set() });
    const q = perMese.get(m);
    // ⚠ un pagamento con `usdcSize` illeggibile NON vale zero: si conta il pagamento e non il dollaro.
    if (usd !== null) q.usd += usd;
    q.pagamenti += 1; q.giorni.add(giorno(ts));
  }
  return {
    ok: true, pagamenti: righe.length, primo, ultimo, giorniConReward: giorni.size,
    perMese: [...perMese.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([m, q]) => ({ mese: m, usd: Math.round(q.usd * 100) / 100, pagamenti: q.pagamenti, giorniConReward: q.giorni.size })),
  };
}

// ── IL VERDETTO SUL «MESTIERE» ──────────────────────────────────────────────────────────────────
/**
 * Non è un'opinione: è la quota di trade su una famiglia, mese per mese. Si dichiara un cambio quando
 * la quota passa da sotto il 20% a sopra l'80% (o viceversa) fra due mesi con almeno 30 trade
 * ciascuno — sotto quella soglia un mese è rumore e la quota oscilla da sola.
 */
function verdettoMestiere(perMese) {
  const utili = perMese.filter((m) => m.trade >= 30);
  if (utili.length < 2) return { cambiato: null, motivo: `meno di due mesi con ≥30 trade (${utili.length}): non si giudica` };
  const passaggi = [];
  for (const famiglia of ['quotaUpDown', 'quotaMeteo']) {
    for (let i = 1; i < utili.length; i += 1) {
      const a = utili[i - 1][famiglia], b = utili[i][famiglia];
      if (a === null || b === null) continue;
      if (a < 0.20 && b > 0.80) passaggi.push({ famiglia, da: utili[i - 1].mese, a: utili[i].mese, verso: 'dentro', quotaPrima: a, quotaDopo: b });
      if (a > 0.80 && b < 0.20) passaggi.push({ famiglia, da: utili[i - 1].mese, a: utili[i].mese, verso: 'fuori', quotaPrima: a, quotaDopo: b });
    }
  }
  return { cambiato: passaggi.length > 0, passaggi, mesiUtili: utili.length };
}

// ── PRINCIPALE ──────────────────────────────────────────────────────────────────────────────────
async function principale() {
  const eff = leggi('efficienti-01-gruppo.json').gruppo.map((r) => normId(r.wallet));
  const w65 = leggi('screening-04-referto.json').passatiWallet.map((r) => normId(r.wallet));
  const effSet = new Set(eff);
  const elenco = SOLO_4 ? eff : [...new Set([...eff, ...w65])];

  console.log(`anzianità dei maker — ${elenco.length} wallet (${eff.length} efficienti)`);
  console.log(`  ⚠ /trades si ferma a offset ${TETTO_OFFSET.toLocaleString('it-IT')}: sopra, «primo trade» è un LIMITE INFERIORE\n`);

  const esiti = await inParallelo(elenco, 5, async (w) => {
    const conteggio = await quantiTrade(w);
    const trade = await storiaTrade(w);
    const reward = await storiaReward(w);
    return { wallet: w, efficiente: effSet.has(w), conteggio, trade, reward };
  }, (f, t) => console.log(`  … ${f}/${t}`));

  const righe = esiti.filter(Boolean).map((e) => {
    const t = e.trade, r = e.reward;
    const spanGiorni = (t.ok && t.primo && t.ultimo) ? Math.max(1, Math.round((t.ultimo - t.primo) / 86400)) + 1 : null;
    return {
      wallet: e.wallet, efficiente: e.efficiente,
      tradeTotali: e.conteggio.n, tradeTroncati: e.conteggio.troncato,
      primoTrade: t.ok && t.primo ? new Date(t.primo * 1000).toISOString() : null,
      primoTradeEsatto: t.ok && !t.troncato && !e.conteggio.troncato,
      ultimoTrade: t.ok && t.ultimo ? new Date(t.ultimo * 1000).toISOString() : null,
      giorniDiVita: spanGiorni,
      giorniConTrade: t.ok ? t.giorniAttivi : null,
      continuita: (t.ok && spanGiorni) ? t.giorniAttivi / spanGiorni : null,
      primoUpDown: t.ok && t.primoUpDown ? new Date(t.primoUpDown * 1000).toISOString().slice(0, 10) : null,
      primoUpDown15: t.ok && t.primoUpDown15 ? new Date(t.primoUpDown15 * 1000).toISOString().slice(0, 10) : null,
      primoMeteo: t.ok && t.primoMeteo ? new Date(t.primoMeteo * 1000).toISOString().slice(0, 10) : null,
      rewardPrimo: r.ok && r.primo ? new Date(r.primo * 1000).toISOString().slice(0, 10) : null,
      rewardUltimo: r.ok && r.ultimo ? new Date(r.ultimo * 1000).toISOString().slice(0, 10) : null,
      rewardGiorni: r.ok ? r.giorniConReward : null,
      rewardPerMese: r.ok ? r.perMese : null,
      rewardTotale: r.ok ? r.perMese.reduce((a, m) => a + m.usd, 0) : null,
      tradePerMese: t.ok ? t.perMese : null,
      mestiere: t.ok ? verdettoMestiere(t.perMese) : null,
    };
  });

  const out = { generatoIl: new Date().toISOString(), wallet: righe.length, efficienti: eff,
    tettoOffsetTrades: TETTO_OFFSET,
    chiamate: { api: contatore.api, ritentate: contatore.ritentate, errori: contatore.errori },
    righe };
  const f = scrivi(FILE_USCITA, out);
  stampa(out);
  console.log(`\n→ ${f}`);
}

function stampa(o) {
  const eff = o.righe.filter((r) => r.efficiente)
    .sort((a, b) => String(a.primoTrade || '9').localeCompare(String(b.primoTrade || '9')));
  const usd = (n) => (n === null || !Number.isFinite(n)) ? 'n/d' : '$' + n.toLocaleString('it-IT', { maximumFractionDigits: 0 });

  console.log('\n' + '═'.repeat(100));
  console.log('I 4 EFFICIENTI, PER ANZIANITÀ (dal più vecchio)');
  console.log('═'.repeat(100));
  for (const r of eff) {
    console.log(`\n  ${r.wallet}${r.tradeTroncati ? '   ⚠ storia TRONCATA al tetto' : ''}`);
    console.log(`    primo trade      ${r.primoTrade ? r.primoTrade.slice(0, 10) : 'n/d'}${r.primoTradeEsatto ? '' : '  (limite inferiore)'}   ·   ultimo  ${r.ultimoTrade ? r.ultimoTrade.slice(0, 10) : 'n/d'}`);
    console.log(`    vita             ${r.giorniDiVita} giorni · con almeno un trade ${r.giorniConTrade} (${r.continuita === null ? 'n/d' : (r.continuita * 100).toFixed(0) + '%'})   ·   ${r.tradeTotali.toLocaleString('it-IT')} trade`);
    console.log(`    primo «Up or Down»   ${r.primoUpDown || '—'}   ·   primo ≤15 min  ${r.primoUpDown15 || '—'}   ·   primo meteo  ${r.primoMeteo || '—'}`);
    console.log(`    reward           da ${r.rewardPrimo || '—'} a ${r.rewardUltimo || '—'} · ${r.rewardGiorni} giorni pagati · totale ${usd(r.rewardTotale)}`);
    if (r.rewardPerMese && r.rewardPerMese.length) {
      console.log('    reward per mese: ' + r.rewardPerMese.map((m) => `${m.mese} ${usd(m.usd)} (${m.giorniConReward}g)`).join(' · '));
    }
    if (r.tradePerMese && r.tradePerMese.length) {
      console.log('    composizione:    ' + r.tradePerMese.map((m) => `${m.mese} ${m.trade}tr up/down ${(m.quotaUpDown * 100).toFixed(0)}% meteo ${(m.quotaMeteo * 100).toFixed(0)}%`).join(' · '));
    }
    const v = r.mestiere;
    if (v && v.cambiato === null) console.log(`    mestiere:        ${v.motivo}`);
    else if (v && v.cambiato) {
      console.log('    mestiere:        ⚠ CAMBIATO — ' + v.passaggi.map((p) => `${p.famiglia.replace('quota', '')} ${p.verso} fra ${p.da} e ${p.a} (${(p.quotaPrima * 100).toFixed(0)}% → ${(p.quotaDopo * 100).toFixed(0)}%)`).join(' · '));
    } else if (v) console.log(`    mestiere:        stabile su ${v.mesiUtili} mesi utili`);
  }

  if (o.righe.length > 4) {
    console.log('\n' + '═'.repeat(100));
    console.log(`I ${o.righe.length} WALLET NEL COMPLESSO`);
    console.log('═'.repeat(100));
    const tronc = o.righe.filter((r) => r.tradeTroncati).length;
    const cont = o.righe.map((r) => r.continuita).filter((x) => x !== null);
    const vita = o.righe.map((r) => r.giorniDiVita).filter((x) => x !== null);
    const gt = o.righe.map((r) => r.giorniConTrade).filter((x) => x !== null);
    const rew = o.righe.map((r) => r.rewardTotale).filter((x) => x !== null && x > 0);
    console.log(`  storia troncata al tetto : ${tronc}/${o.righe.length}  ⇒ per questi «primo trade» è un limite inferiore`);
    console.log(`  vita osservata (giorni)  : mediana ${mediana(vita)} · range ${Math.min(...vita)}–${Math.max(...vita)}`);
    console.log(`  giorni con almeno 1 trade: mediana ${mediana(gt)} · range ${Math.min(...gt)}–${Math.max(...gt)}`);
    console.log(`  continuità (giorni con trade / giorni di vita): mediana ${(mediana(cont) * 100).toFixed(0)}%`);
    console.log(`  reward incassati in totale: mediana ${usd(mediana(rew))} · max ${usd(Math.max(...rew))}`);
    const conUpDown = o.righe.filter((r) => r.primoUpDown15).length;
    console.log(`  wallet mai visti su «Up or Down» ≤15 min : ${o.righe.length - conUpDown}/${o.righe.length}`);
    const cambiati = o.righe.filter((r) => r.mestiere && r.mestiere.cambiato === true);
    console.log(`  wallet che hanno CAMBIATO famiglia dominante: ${cambiati.length}`);
    for (const c of cambiati.slice(0, 8)) {
      console.log(`    ${c.wallet.slice(0, 12)}…  ` + c.mestiere.passaggi.map((p) => `${p.famiglia.replace('quota', '')} ${p.verso} ${p.da}→${p.a}`).join(' · '));
    }
    // I reward per mese, aggregati: dice se il GRUPPO è cresciuto o si è ritirato.
    const perMese = new Map();
    for (const r of o.righe) for (const m of (r.rewardPerMese || [])) {
      if (!perMese.has(m.mese)) perMese.set(m.mese, { usd: 0, wallet: 0 });
      const q = perMese.get(m.mese); q.usd += m.usd; q.wallet += 1;
    }
    console.log('\n  REWARD DEL GRUPPO PER MESE (tutti i wallet):');
    for (const [m, q] of [...perMese.entries()].sort()) {
      console.log(`    ${m}  ${usd(q.usd).padStart(10)}  su ${String(q.wallet).padStart(3)} wallet attivi`);
    }
  }
}

principale().catch((e) => { console.error('\nGUASTO: ' + (e && e.stack || e)); process.exitCode = 1; });
