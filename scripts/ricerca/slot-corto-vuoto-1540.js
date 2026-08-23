'use strict';
// SOLA LETTURA — perché lo slot corto/basso resta vuoto. Usa lo STESSO modulo di selezione.
const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '../..');
const S = require(path.join(ROOT, 'lib/maker/selezione-mercati'));
const board = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/liquidity-rewards.json'), 'utf8'));
const righe = board.markets || board.rows || board.data || [];
const now = Date.now();
const ORA = 3600_000;

// il classificatore meteo è nel modulo: si usa il suo, non se ne riscrive uno
const nomiEsportati = Object.keys(S);
const eMeteo = S.eMeteo || S.isMeteo || S.famigliaMeteo || null;

let corti = 0, cortiMeteo = 0, cortiNonMeteo = 0, minSize20 = 0;
const esempiNonMeteo = [];
for (const r of righe) {
  const end = Date.parse(r.endDate || r.end_date_iso || r.endDateIso || r.gameStartTime || 0);
  if (!Number.isFinite(end)) continue;
  const ore = (end - now) / ORA;
  if (!(ore >= 24 && ore <= 48)) continue;
  corti++;
  const ms = Number(r.rewardsMinSize);
  if (Number.isFinite(ms) && ms <= 20) minSize20++;
  const titolo = String(r.question || r.title || '');
  const m = eMeteo(r);
  if (m) cortiMeteo++; else { cortiNonMeteo++; if (esempiNonMeteo.length < 12) esempiNonMeteo.push({ id: String(r.conditionId || r.id || '').slice(0, 12), minSize: ms, ore: +ore.toFixed(1), titolo: titolo.slice(0, 70) }); }
}
const out = {
  atIso: new Date(now).toISOString(),
  esportatiDalModulo: nomiEsportati,
  classificatoreMeteoUsato: eMeteo ? 'modulo' : 'RIPIEGO locale (il modulo non esporta il classificatore) — numero da leggere come indicativo',
  righeBoard: righe.length,
  cortiFra24e48h: corti, diCuiMinSize20: minSize20,
  cortiMeteo, cortiNonMeteo,
  esempiCortiNonMeteo: esempiNonMeteo,
};
fs.writeFileSync(path.join(ROOT, 'data/ricerca/slot-corto-vuoto-1540.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
