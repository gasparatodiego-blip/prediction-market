'use strict';
// SOLA LETTURA — premio maturato oggi (stima Σ tasso×durata) e ritmo delle ultime tre ore.
const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '../..');
const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/stima-campioni.json'), 'utf8'));
const OGGI = '2026-08-23';
const camp = (j.giorni[OGGI] || []).slice().sort((a, b) => a.t - b.t);
const PASSO_MS = 300_000;         // il campionatore gira ogni 5 minuti
const MAX_PASSI = 2;              // §4.12: un campione vale AL PIÙ due passi

function integra(cs) {
  let usd = 0, coperti = 0, span = 0, senzaTasso = 0;
  const copertureC = [];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (!Number.isFinite(c.r)) { senzaTasso++; continue; }
    const dt = (i + 1 < cs.length) ? Math.min(cs[i + 1].t - c.t, PASSO_MS * MAX_PASSI) : 0;
    usd += c.r * (dt / 86_400_000);   // r è $/giorno
    coperti += dt; span += (i + 1 < cs.length) ? (cs[i + 1].t - c.t) : 0;
    if (Number.isFinite(c.c)) copertureC.push(c.c);
  }
  return { usd: +usd.toFixed(4), coperti, span, senzaTasso, copertureC };
}

const now = Date.now();
const tutti = integra(camp);
const tre = integra(camp.filter((c) => c.t >= now - 3 * 3600_000));
const tassi = camp.filter((c) => Number.isFinite(c.r)).map((c) => c.r);
const tassi3 = camp.filter((c) => c.t >= now - 3 * 3600_000 && Number.isFinite(c.r)).map((c) => c.r);
const med = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

const out = {
  atIso: new Date(now).toISOString(),
  giorno: OGGI,
  campioniOggi: camp.length,
  primoCampioneIso: camp.length ? new Date(camp[0].t).toISOString() : null,
  ultimoCampioneIso: camp.length ? new Date(camp[camp.length - 1].t).toISOString() : null,
  buchiOltre10min: camp.reduce((a, c, i) => a + (i + 1 < camp.length && camp[i + 1].t - c.t > 600_000 ? 1 : 0), 0),
  minutiScopertiOggi: +(((camp.length ? camp[camp.length - 1].t - camp[0].t : 0) - tutti.coperti) / 60000).toFixed(1),
  premioMaturatoOggiUsd: tutti.usd,
  premioUltime3hUsd: tre.usd,
  ritmoUltime3hUsdGiorno: tre.coperti > 0 ? +((tre.usd / (tre.coperti / 86_400_000))).toFixed(4) : null,
  tassoMedianoOggiUsdGiorno: med(tassi),
  tassoMediano3hUsdGiorno: med(tassi3),
  tassoUltimoUsdGiorno: camp.length ? camp[camp.length - 1].r : null,
  coperturaUltimaFrazione: camp.length ? camp[camp.length - 1].c : null,
  campioni3h: tassi3.length,
  nota: 'stima Σ(tasso×durata) del campionatore di agent40 (§4.12) — NON il consuntivo del venue, che paga a giorno chiuso',
};
fs.writeFileSync(path.join(ROOT, 'data/ricerca/premio-oggi-1530.json'), JSON.stringify({ ...out, campioni: camp }, null, 1));
console.log(JSON.stringify(out, null, 1));
