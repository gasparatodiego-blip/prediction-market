'use strict';

/**
 * ESISTE QUALCUNO CHE FA IL NOSTRO MESTIERE? — sola lettura, API pubbliche.
 *
 * ═══ PERCHÉ IL CAMPIONE È COSTRUITO COSÌ ═══════════════════════════════════════════════════════
 * Cercare i neutrali solo fra i top **per definizione non li trova**, se stanno più in basso. Quindi
 * il campione ha due parti, e la seconda è quella che risponde davvero alla domanda:
 *   · **i primi 500 per incasso** — censimento completo, non campione: se un neutrale ricco esiste,
 *     è lì dentro;
 *   · **un campione CASUALE stratificato delle fasce medio-basse** ($10–100/g e $1–10/g), perché è
 *     lì che si nasconderebbe un neutrale povero ma costante. Casuale e non «i primi della fascia»:
 *     prendere i primi di ogni fascia rifarebbe lo stesso errore del censimento dall'alto.
 * Il seme del campionamento è FISSO e dichiarato, così il campione è rifacibile identico.
 *
 * ═══ COSA SI MISURA, E COSA NO ═════════════════════════════════════════════════════════════════
 * Misurato per ogni wallet: quota di mercati con **entrambe** le gambe, valore in posizione, numero
 * di mercati, presenza (giorni su 30), reward totali. Il metodo dell'appaiamento è quello già
 * validato: `positions` NON compatta i lati opposti — restituisce entrambi gli `outcomeIndex` — e un
 * `conditionId` può comparire due volte.
 *
 * ⚠ **Il taglio dell'ordine costa una seconda chiamata** (`activity`) e si prende SOLO per i wallet
 * che superano la soglia di neutralità e per quelli di scala confrontabile alla nostra: farlo su 900
 * wallet raddoppierebbe il tempo per un dato che serve su poche decine.
 * ⚠ **Gli ordini a riposo restano non misurabili**: `positions` mostra le posizioni, non il libro.
 * Quindi «capitale impegnato» qui significa **capitale in posizione**, e non include gli ordini fermi.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'data', 'ricerca', 'distribuzioni-reward');
const OUT = path.join(ROOT, 'data', 'ricerca', 'campione-neutrali.json');
const NOSTRO = '0x4c81f19a436e8174f1f3b07d7c0169150fbdbdee';

const TOP_N = Number(process.argv[2] || 500);
const CAMPIONE_MEDIA = Number(process.argv[3] || 200);   // fascia $10–100/g
const CAMPIONE_BASSA = Number(process.argv[4] || 200);   // fascia $1–10/g
const SEME = 20260813;
const PAUSA_MS = 320;

const attesa = (ms) => new Promise((r) => setTimeout(r, ms));

/** PRNG deterministico: il campione casuale deve essere RIFACIBILE, o non è verificabile. */
function rng(seme) {
  let s = seme >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// ── AGGREGATO COMPLETO DEI 30 GIORNI ─────────────────────────────────────────────────────────────
const per = new Map();
const fileGiorni = fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
for (const f of fileGiorni) {
  const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const g = new Map();
  for (const r of d.righe) g.set(r.a, (g.get(r.a) || 0) + r.usd);
  for (const [a, usd] of g) {
    if (!per.has(a)) per.set(a, { a, giorni: 0, totale: 0 });
    const w = per.get(a); w.giorni++; w.totale += usd;
  }
}
const tutti = [...per.values()].map((w) => ({ ...w, mediaG: w.totale / w.giorni }))
  .sort((x, y) => y.totale - x.totale);
tutti.forEach((w, i) => { w.rango = i + 1; });

// ── LA COSTRUZIONE DEL CAMPIONE ─────────────────────────────────────────────────────────────────
const seri = tutti.filter((w) => !(w.totale < 1 || w.giorni <= 1));   // stessa soglia rumore di prima
const top = seri.slice(0, TOP_N);
const media = seri.filter((w) => w.mediaG >= 10 && w.mediaG < 100 && w.rango > TOP_N);
const bassa = seri.filter((w) => w.mediaG >= 1 && w.mediaG < 10 && w.rango > TOP_N);

function pesca(pool, n, r) {
  const c = [...pool];
  const out = [];
  while (out.length < Math.min(n, c.length)) out.push(...c.splice(Math.floor(r() * c.length), 1));
  return out;
}
const r = rng(SEME);
const campMedia = pesca(media, CAMPIONE_MEDIA, r);
const campBassa = pesca(bassa, CAMPIONE_BASSA, r);

const bersagli = [
  ...top.map((w) => ({ ...w, strato: 'top500' })),
  ...campMedia.map((w) => ({ ...w, strato: 'casuale-10-100' })),
  ...campBassa.map((w) => ({ ...w, strato: 'casuale-1-10' })),
];
const nostro = tutti.find((w) => w.a === NOSTRO);
if (nostro && !bersagli.some((b) => b.a === NOSTRO)) bersagli.push({ ...nostro, strato: 'noi' });

console.error(`universo: ${tutti.length} wallet · seri: ${seri.length}`);
console.error(`campione: ${top.length} top + ${campMedia.length} casuali $10-100/g (su ${media.length}) `
  + `+ ${campBassa.length} casuali $1-10/g (su ${bassa.length}) = ${bersagli.length} wallet · seme ${SEME}`);

// ── LA MISURA ────────────────────────────────────────────────────────────────────────────────────
let limitato = 0;
async function posizioni(addr, tentativo = 0) {
  try {
    const rr = await fetch(`https://data-api.polymarket.com/positions?user=${addr}&limit=500`);
    if (rr.status === 429) {
      limitato++;
      if (tentativo >= 5) return null;
      await attesa(2500 * (tentativo + 1));
      return posizioni(addr, tentativo + 1);
    }
    if (!rr.ok) return null;
    return await rr.json();
  } catch (e) {
    if (tentativo >= 3) return null;
    await attesa(1200 * (tentativo + 1));
    return posizioni(addr, tentativo + 1);
  }
}

(async () => {
  const t0 = Date.now();
  const risultati = [];
  let fatti = 0;
  for (const b of bersagli) {
    const j = await posizioni(b.a);
    fatti++;
    if (fatti % 50 === 0) console.error(`  ${fatti}/${bersagli.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s · rate-limit ${limitato}`);
    if (!Array.isArray(j)) { risultati.push({ ...b, letto: false }); await attesa(PAUSA_MS); continue; }

    const mercati = new Map();
    for (const p of j) {
      const c = String(p.conditionId || '');
      if (!c) continue;
      if (!mercati.has(c)) mercati.set(c, { lati: new Set(), val: 0, endDate: p.endDate });
      const m = mercati.get(c);
      m.lati.add(String(p.outcomeIndex));
      m.val += Number(p.currentValue) || 0;
    }
    const n = mercati.size;
    const app = [...mercati.values()].filter((m) => m.lati.size > 1).length;
    const val = [...mercati.values()].reduce((s, m) => s + m.val, 0);
    const orizzonti = [...mercati.values()].map((m) => (m.endDate ? (Date.parse(m.endDate) - Date.now()) / 86400_000 : null))
      .filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y);

    risultati.push({
      ...b, letto: true, posizioni: j.length, mercati: n,
      appaiati: app, quotaAppaiati: n ? +(app / n).toFixed(4) : null,
      valoreUsd: +val.toFixed(2),
      orizzonteMedianoGg: orizzonti.length ? +orizzonti[Math.floor(orizzonti.length / 2)].toFixed(2) : null,
      // ⚠ IL NUMERO CHE NORMALIZZA LA SCALA: reward incassati per dollaro in posizione.
      // Con valore 0 non è definito, e `null` non è zero.
      rendimentoSuCapitale: val > 0 ? +(b.totale / val).toFixed(4) : null,
    });
    await attesa(PAUSA_MS);
  }

  const meta = {
    generatoIso: new Date().toISOString(),
    universo: tutti.length, seri: seri.length,
    campione: { top: top.length, casualeMedia: campMedia.length, casualeBassa: campBassa.length,
      totale: bersagli.length, seme: SEME,
      popolazioneMedia: media.length, popolazioneBassa: bassa.length },
    lettiConSuccesso: risultati.filter((x) => x.letto).length,
    nonLetti: risultati.filter((x) => !x.letto).length,
    volteRateLimit: limitato,
    durataSec: +((Date.now() - t0) / 1000).toFixed(1),
  };
  fs.writeFileSync(OUT, JSON.stringify({ meta, risultati }, null, 1));
  console.error(`\nfatto: ${meta.lettiConSuccesso} letti, ${meta.nonLetti} non letti, `
    + `${meta.volteRateLimit} rate-limit, ${meta.durataSec}s`);
})();
