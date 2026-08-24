// Quante righe del board portano `minOrderSize` popolato, quante no, e per quelle senza il conditionId.
// SOLA LETTURA.
const fs = require('fs');
const F = '/home/bot/bot/data/liquidity-rewards.json';
const st = fs.statSync(F);
const j = JSON.parse(fs.readFileSync(F, 'utf8'));
const m = j.markets || [];
// ⚠ `null` NON e' `0`: si conta «popolato» solo un numero finito. Uno zero direbbe «nessun minimo».
const con = m.filter((x) => Number.isFinite(x.minOrderSize));
const senza = m.filter((x) => !Number.isFinite(x.minOrderSize));
const valori = new Map();
con.forEach((x) => valori.set(x.minOrderSize, (valori.get(x.minOrderSize) || 0) + 1));
const out = {
  boardScrittoAl: new Date(st.mtimeMs).toISOString(),
  righeTotali: m.length,
  conMinOrderSize: con.length,
  senzaMinOrderSize: senza.length,
  valoriDistinti: [...valori.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ minOrderSize: v, righe: n })),
  senzaConditionId: senza.map((x) => ({ conditionId: x.conditionId, question: String(x.question || '').slice(0, 60), minOrderSize: x.minOrderSize === undefined ? '(campo assente)' : x.minOrderSize })),
};
fs.writeFileSync('/home/bot/bot/data/ricerca/board-minordersize.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ ...out, senzaConditionId: out.senzaConditionId.slice(0, 30) }, null, 2));
