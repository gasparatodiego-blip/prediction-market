'use strict';
// scripts/ricerca/d-d-riferimento-guardiano.js — SOLA LETTURA.
//
// LA SIMULAZIONE A SECCO DI D-D. Non scrive niente fuori da data/ricerca/, non tocca ordini, non tocca
// processi, non tocca lo stato del guardiano. Risponde a cinque domande:
//   ① che riferimento produrrebbe il codice CORRETTO se avesse girato sulla serie vera?
//   ② quanto vale il drawdown e il margine, col vecchio e col nuovo
//   ③ replay degli scatti sulle letture VERE del guardiano: quanti col vecchio, quanti col nuovo
//   ④ lo scatto del 20/08 22:36 sarebbe avvenuto lo stesso?
//   ⑤ quanto e' rimasto fermo il bot dopo quello scatto
const fs = require('fs'); const path = require('path');
const RADICE = path.join(__dirname, '..', '..');
const R = require(path.join(RADICE, 'lib/maker/guardian-riferimento'));
const { calcolaPnl, decidiScatto } = require(path.join(RADICE, 'lib/maker/guardian-perdite'));

const D = (...p) => path.join(RADICE, ...p);
const out = { lettoAl: new Date().toISOString() };

// ── ① IL RIFERIMENTO CHE IL CODICE CORRETTO PRODUCE SULLA SERIE VERA ────────────────────────────
// Fonte: i campioni dell'osservatore (saldo e posizioni misurati, un campione al minuto). E' la serie
// piu' lunga che esista; il guardiano campiona a 30 s ma il suo log parte solo dal 17/08 18:19.
const campioni = [];
for (const f of fs.readdirSync(D('data/osservatore')).filter((x) => /^campioni-.*\.jsonl$/.test(x)).sort())
  for (const l of fs.readFileSync(D('data/osservatore', f), 'utf8').split('\n')) {
    if (!l.trim()) continue; let r; try { r = JSON.parse(l); } catch { continue; }
    if (!Number.isFinite(r.totalePortafoglioUsd) || r.totalePortafoglioUsd <= 0) continue;
    campioni.push({ at: Date.parse(r.atIso), iso: r.atIso, tot: r.totalePortafoglioUsd,
      saldo: r.saldoUsd, pos: r.posizioniValoreUsd });
  }

let stato = null; const salite = [];
for (const c of campioni) {
  const r = R.aggiornaRiferimento({
    stato,
    capitale: { leggibile: true, totaleUsd: c.tot, saldoUsd: c.saldo, valorePosizioniUsd: c.pos },
    now: c.at,
    // L'osservatore non registra l'istante di lettura del saldo: si passa un istante DISTINTO per ogni
    // campione, che e' il caso reale (campioni a 60 s contro una cache da 45 s).
    osservazione: { saldoLetturaAt: c.at - 1000 },
  });
  if (r.riferimentoUsd !== (stato ? stato.riferimentoUsd : null)) salite.push({ iso: c.iso, a: r.riferimentoUsd, motivo: r.motivo });
  stato = r.stato;
}
const RIF_NUOVO = Number(stato.riferimentoUsd);
const RIF_VECCHIO = JSON.parse(fs.readFileSync(D('data/guardian-baseline.json'), 'utf8')).riferimentoUsd;
out.serie = { campioni: campioni.length, da: campioni[0].iso, a: campioni[campioni.length - 1].iso };
out.riferimento = { vecchio: RIF_VECCHIO, nuovo: RIF_NUOVO, salite };

// ── ② DRAWDOWN E MARGINE, PRIMA E DOPO ───────────────────────────────────────────────────────────
const TOT_ORA = campioni[campioni.length - 1].tot;
const quadro = (rif) => {
  const s = R.sogliaAssoluta({ riferimentoUsd: rif, pavimentoUsd: 30, frazione: 0.05 });
  const pnl = calcolaPnl({ baselineUsd: rif, totaleUsd: TOT_ORA });
  return { riferimentoUsd: +rif.toFixed(2), sogliaUsd: +s.sogliaUsd.toFixed(2),
    puntoDiScattoUsd: +(rif - s.sogliaUsd).toFixed(2), drawdownUsd: +pnl.pnlUsd.toFixed(2),
    drawdownPct: +pnl.pnlPct.toFixed(3), margineUsd: +(s.sogliaUsd + pnl.pnlUsd).toFixed(2) };
};
out.totaleOra = +TOT_ORA.toFixed(2);
out.quadro = { vecchio: quadro(RIF_VECCHIO), nuovo: quadro(RIF_NUOVO) };

// ── ③ REPLAY DEGLI SCATTI SULLE LETTURE VERE DEL GUARDIANO ──────────────────────────────────────
const LOG = '/home/bot/.pm2/logs/agent43-guardian-out.log';
const letture = [];
if (fs.existsSync(LOG)) {
  const re = /^([0-9T:.Z-]+) \[agent43-guardian\] (?:ok|PRE-ALLARME|SCATTO).*?[Bb]aseline \$([0-9.]+) → (?:adesso )?\$([0-9.]+)/;
  const pulisci = (x) => Number(String(x).replace(/\.+$/, ''));
  for (const l of fs.readFileSync(LOG, 'utf8').split('\n')) {
    const m = l.match(re); if (!m) continue;
    letture.push({ at: Date.parse(m[1]), iso: m[1], tot: pulisci(m[3]) });
  }
}
// Il replay applica la stessa conferma a k=2 dello scatto vero: due letture DISTINTE e contigue.
function replay(rif) {
  let conf = 0, ultimaAt = null, ultimoVal = null; const scatti = []; let preallarmi = 0;
  const soglia = 0.05 * rif;
  for (const r of letture) {
    const pnl = r.tot - rif;
    const oltre = pnl <= -soglia || (pnl / rif) * 100 <= -5;
    if (!oltre) { conf = 0; ultimaAt = r.at; ultimoVal = r.tot; continue; }
    const contigua = ultimaAt !== null && r.at - ultimaAt <= 120_000 && conf > 0;
    const distinta = ultimoVal === null || r.tot !== ultimoVal;
    conf = !contigua ? 1 : (distinta ? conf + 1 : conf);
    ultimaAt = r.at; ultimoVal = r.tot;
    if (conf >= 2) { scatti.push({ iso: r.iso, totaleUsd: r.tot, pnlUsd: +pnl.toFixed(2) }); conf = 0; } else preallarmi += 1;
  }
  const minTot = letture.reduce((m, r) => Math.min(m, r.tot), Infinity);
  return { riferimentoUsd: +rif.toFixed(2), puntoDiScattoUsd: +(0.95 * rif).toFixed(2),
    preallarmi, scatti, minimoLettoUsd: +minTot.toFixed(2), distanzaDalloScattoUsd: +(minTot - 0.95 * rif).toFixed(2) };
}
out.replay = {
  finestra: letture.length ? { letture: letture.length, da: letture[0].iso, a: letture[letture.length - 1].iso,
    giorni: +((letture[letture.length - 1].at - letture[0].at) / 86_400_000).toFixed(2) } : null,
  vecchio: letture.length ? replay(RIF_VECCHIO) : null,
  nuovo: letture.length ? replay(RIF_NUOVO) : null,
};

// ── ④/⑤ LO SCATTO DEL 20/08 E QUANTO E' COSTATO ─────────────────────────────────────────────────
const bot = JSON.parse(fs.readFileSync(D('data/maker-bot-enabled.json'), 'utf8'));
const scattoVero = (out.replay.vecchio && out.replay.vecchio.scatti[0]) || null;
if (scattoVero) {
  const fermoMs = Date.parse(bot.atIso) - Date.parse(scattoVero.iso);
  out.scattoDel20 = {
    quando: scattoVero.iso, totaleLetto: scattoVero.totaleUsd, pnlUsd: scattoVero.pnlUsd,
    conIlNuovoRiferimento: {
      pnlUsd: +(scattoVero.totaleUsd - RIF_NUOVO).toFixed(2),
      sogliaUsd: +(0.05 * RIF_NUOVO).toFixed(2),
      scatterebbe: scattoVero.totaleUsd <= 0.95 * RIF_NUOVO,
      margineResiduoUsd: +(scattoVero.totaleUsd - 0.95 * RIF_NUOVO).toFixed(2),
    },
    botFermoFinoA: bot.atIso, botFermoOre: +(fermoMs / 3_600_000).toFixed(2), riaccesoDa: bot.by,
  };
}

fs.writeFileSync(D('data/ricerca/d-d-riferimento-21-agosto.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
