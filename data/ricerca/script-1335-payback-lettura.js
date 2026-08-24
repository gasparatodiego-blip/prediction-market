// LETTURA DEL PAYBACK sul board vivo — SOLA LETTURA, nessun processo figlio.
// ⚠ NON si ricalcola il piano: il figlio del piano va in OOM su questa macchina (§5.2 p.71,
//   426 MB disponibili e 1,2 GB di swap gia' usato), e farlo mentre il bot e' armato rischia di
//   far scegliere all'OOM killer un agent. Quindi si legge cio' che e' su disco e si applica
//   l'ALGEBRA gia' dimostrata in §5.2 p.58-bis, che non ha bisogno del costo per essere letta:
//     days <= cost/(gross-cost)   <=>   net/gross <= 1/(1+days)
//   cioe' la soglia di margine richiesta dipende SOLO dalla vita residua.
const fs = require('fs');
const path = '/home/bot/bot';
const board = require(path + '/data/liquidity-rewards.json');
const piano = require(path + '/data/realloc-ultimo-piano.json');
const { horizonVerdict, daysToResolution, MIN_HORIZON_DAYS, maxHorizonDays } = require(path + '/lib/rewards/horizon');

const ORA = Date.now();
const MAXD = maxHorizonDays(process.env);
const fin = (x) => Number.isFinite(x);
const sogliaRichiesta = (days) => 1 / (1 + days); // net/gross MINIMO per superare il cancello

// ── ① IL BOARD: quanti mercati, in che fasce di vita residua, e quanto margine chiede il cancello
const fasce = [
  { nome: '< 12 h (sotto il pavimento)', min: 0, max: 0.5 },
  { nome: '12-24 h', min: 0.5, max: 1 },
  { nome: '24-48 h', min: 1, max: 2 },
  { nome: '2-7 g', min: 2, max: 7 },
  { nome: '7-30 g', min: 7, max: 30 },
  { nome: '30-150 g', min: 30, max: 150 },
  { nome: '> 150 g (oltre il muro)', min: 150, max: Infinity },
];
const perFascia = fasce.map((f) => ({ ...f, n: 0, sogliaMin: null, sogliaMax: null }));
let senzaScadenza = 0, gia = 0;
const corti = [];
for (const m of board.markets || []) {
  const d = daysToResolution(m.endDate || null, ORA);
  if (d == null) { senzaScadenza++; continue; }
  if (d <= 0) { gia++; continue; }
  const f = perFascia.find((x) => d > x.min && d <= x.max) || perFascia[perFascia.length - 1];
  f.n++;
  const s = sogliaRichiesta(d);
  f.sogliaMin = f.sogliaMin == null ? s : Math.min(f.sogliaMin, s);
  f.sogliaMax = f.sogliaMax == null ? s : Math.max(f.sogliaMax, s);
  if (d >= MIN_HORIZON_DAYS && d <= 2) {
    corti.push({
      conditionId: m.conditionId, ore: +(d * 24).toFixed(1),
      rewardsMinSize: m.rewardsMinSize ?? null,
      margineNettoRichiestoPct: +(s * 100).toFixed(1),
    });
  }
}
corti.sort((a, b) => a.ore - b.ore);

// ── ② I FINANZIATI: il payback VERO, coi numeri che il piano ha gia' salvato
const endDate = new Map((board.markets || []).map((m) => [m.conditionId, m.endDate || null]));
const finanziati = (piano.righe || []).map((r) => {
  const gross = fin(r.grossPerDay) ? r.grossPerDay : null;
  const net = fin(r.netPerDay) ? r.netPerDay : null;
  const cost = (gross != null && net != null) ? gross - net : null;
  const d = daysToResolution(endDate.get(r.marketId) || null, ORA);
  const v = horizonVerdict({ endDate: endDate.get(r.marketId) || null, nowMs: ORA, grossPerDay: gross, costPerDay: cost });
  return {
    shortId: r.shortId, giorni: d == null ? null : +d.toFixed(2),
    grossPerDay: gross == null ? null : +gross.toFixed(4),
    netPerDay: net == null ? null : +net.toFixed(4),
    costPerDay: cost == null ? null : +cost.toFixed(4),
    margineNettoPct: (gross && net != null && gross > 0) ? +((net / gross) * 100).toFixed(1) : null,
    sogliaRichiestaPct: d == null ? null : +(sogliaRichiesta(d) * 100).toFixed(1),
    payback: v.payback == null ? null : (v.payback === Infinity ? 'Infinity' : +v.payback.toFixed(2)),
    stato: v.state, motivo: v.reason,
  };
});

// ── ③ IL CONTROFATTUALE: gli stessi finanziati, se scadessero fra 25 / 28 / 36 ore
const controfattuale = [24, 25, 28, 36, 48].map((ore) => {
  const d = ore / 24;
  const passano = finanziati.filter((r) => r.margineNettoPct != null && (r.margineNettoPct / 100) > sogliaRichiesta(d));
  return { ore, sogliaRichiestaPct: +(sogliaRichiesta(d) * 100).toFixed(1), passerebbero: passano.length, su: finanziati.filter((r) => r.margineNettoPct != null).length };
});

const out = {
  generatoIso: new Date(ORA).toISOString(),
  fonti: {
    board: 'data/liquidity-rewards.json', boardMercati: (board.markets || []).length,
    piano: 'data/realloc-ultimo-piano.json', pianoAt: piano.at || null, pianoRighe: (piano.righe || []).length,
  },
  cancello: { minHorizonDays: MIN_HORIZON_DAYS, maxHorizonDays: MAXD, formula: 'days <= cost/(gross-cost)  <=>  net/gross <= 1/(1+days)' },
  board: { senzaScadenza, giaRisolti: gia, perFascia: perFascia.map((f) => ({ fascia: f.nome, n: f.n, margineNettoRichiestoPct: f.sogliaMin == null ? null : [ +(f.sogliaMin * 100).toFixed(1), +(f.sogliaMax * 100).toFixed(1) ] })) },
  cortiAmmissibiliDallaSelezione: corti,
  finanziati,
  controfattualeSuiFinanziati: controfattuale,
};
fs.writeFileSync(path + '/data/ricerca/payback-lettura-1335.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
