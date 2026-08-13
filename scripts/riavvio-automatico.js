#!/usr/bin/env node
'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *  IL CABLAGGIO DEL RIAVVIO AUTOMATICO CONDIZIONATO
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * La REGOLA sta in `lib/safety/riavvio-condizionato.js` ed è pura. Qui c'è solo il cablaggio: raccogliere
 * le quattro condizioni dal mondo vero, e — solo se valgono tutte — eseguire la cascata.
 *
 *   node scripts/riavvio-automatico.js            → valuta ed esegue
 *   node scripts/riavvio-automatico.js --prova    → valuta e DICE cosa farebbe, senza toccare pm2
 *
 * ⚠ IN ANTEPRIMA DI DIFETTO NO, MA CON UNA GUARDIA: questo script riavvia processi che governano
 * capitale reale. `--prova` esiste per guardarlo lavorare senza che tocchi niente, ed è la forma che
 * questo repo usa per ogni strumento che può muovere lo stato (`registra-mercati-orfani`,
 * `ripulisci-fill-duplicati`, `simula-trigger-capitale`).
 *
 * ⚠ LA SUITE NON LA ESEGUE QUESTO SCRIPT. Girarla qui vorrebbe dire trenta minuti fra il commit e il
 * riavvio, e soprattutto: `appendMakerAudit` scrive sul giornale VERO, quindi eseguire la suite dentro
 * un percorso automatico è un'azione sullo stato di produzione che nessuno ha chiesto (§5.3). Si legge
 * l'esito che il chiamante ha già prodotto, da `data/ultima-suite.json`; se manca o è più vecchio di
 * `SUITE_MAX_ETA_MIN`, la condizione **non è verificata** e non si riavvia.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const RC = require('../lib/safety/riavvio-condizionato');

const RADICE = path.join(__dirname, '..');
const SUITE_FILE = path.join(RADICE, 'data', 'ultima-suite.json');
const SUITE_MAX_ETA_MIN = 30;
const PROVA = process.argv.includes('--prova');

const sh = (cmd, args) => new Promise((res) => {
  execFile(cmd, args, { cwd: RADICE, maxBuffer: 64 * 1024 * 1024, timeout: 180_000 },
    (err, out, errOut) => res({ ok: !err, out: String(out || ''), err: String(errOut || err && err.message || '') }));
});

async function pm2Stato(nome) {
  const r = await sh('pm2', ['jlist']);
  if (!r.ok) return null;
  try {
    const p = JSON.parse(r.out).find((x) => x.name === nome);
    if (!p) return null;
    return { online: p.pm2_env.status === 'online', pid: p.pid,
      uptimeMs: Date.now() - p.pm2_env.pm_uptime, restarts: p.pm2_env.restart_time };
  } catch { return null; }
}

function leggiSuite() {
  try {
    const j = JSON.parse(fs.readFileSync(SUITE_FILE, 'utf8'));
    const eta = (Date.now() - Number(j.at)) / 60_000;
    if (!Number.isFinite(eta) || eta > SUITE_MAX_ETA_MIN) {
      return { eseguita: false, motivo: `esito della suite vecchio di ${Math.round(eta)} min (limite ${SUITE_MAX_ETA_MIN})` };
    }
    return { eseguita: true, rossi: Array.isArray(j.rossi) ? j.rossi : null };
  } catch (e) { return { eseguita: false, motivo: `esito della suite non leggibile: ${e.message}` }; }
}

function leggiKill() {
  try { return require('../lib/safety/kill-switch').killStatus(); }
  catch { return { effectivelyKilled: true, readable: false }; }
}

/**
 * Le posizioni scoperte SOPRA il minimo del venue. Sotto il minimo non conta: è uno stato che nessun
 * ciclo può risolvere, e aspettarlo vorrebbe dire non riavviare mai (§5 p.123).
 */
function leggiPosizioniScoperte() {
  try {
    const { readVenuePositions } = require('../lib/safety/venue-positions-snapshot');
    const snap = readVenuePositions();
    if (!snap || snap.readable !== true) return { readable: false };
    const reg = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(RADICE, 'data', 'residui-scoperti.json'), 'utf8')).residui || {}; }
      catch { return null; }
    })();
    if (!reg) return { readable: false };
    let sopra = 0;
    for (const v of Object.values(reg)) {
      // `pronto` significa: la quantità scoperta ha raggiunto il minimo del venue, quindi È copribile.
      if (v && v.pronto === true) sopra += 1;
    }
    return { readable: true, scoperteSopraMinimo: sopra };
  } catch { return { readable: false }; }
}

(async () => {
  const commit = (await sh('git', ['rev-parse', '--short', 'HEAD'])).out.trim() || null;
  const build = fs.existsSync(path.join(RADICE, '.next', 'BUILD_ID'))
    && fs.existsSync(path.join(RADICE, '.next', 'prerender-manifest.json'))
    ? { verde: true }
    : { verde: false, motivo: '.next incompleto: manca BUILD_ID o prerender-manifest.json' };

  const v = RC.valutaCondizioni({
    suite: leggiSuite(), build, kill: leggiKill(), posizioni: leggiPosizioniScoperte(),
  });

  console.log(`[riavvio-automatico] commit ${commit || '?'} — ${v.riga}`);
  for (const c of v.condizioni) console.log(`  ${c.ok ? '✅' : '⛔'} ${c.nome}: ${c.motivo}`);

  try {
    require('../lib/venues/polymarket-clob-maker/audit').appendMakerAudit({
      ts: Date.now(), venue: 'polymarket', source: 'riavvio-condizionato', op: 'valutazione',
      reason: 'commit su main', decision: v.riga,
      outcome: v.ok ? 'condizioni-soddisfatte' : 'riavvio-non-eseguito',
      requested: { commit }, observed: { condizioni: v.condizioni, mancanti: v.mancanti },
    });
  } catch { /* l'audit non decide */ }

  if (!v.ok) {
    console.log('[riavvio-automatico] LA MODIFICA RESTA INATTIVA. Serve un riavvio a mano, o le condizioni devono rientrare.');
    process.exit(2);
  }
  if (PROVA) {
    console.log(`[riavvio-automatico] --prova: riavvierei in sequenza ${RC.ORDINE.join(' → ')}. Niente eseguito.`);
    process.exit(0);
  }

  const r = await RC.riavviaInSequenza({
    riavvia: async (n) => { const x = await sh('pm2', ['restart', n]); if (!x.ok) throw new Error(x.err.slice(0, 120)); },
    stato: pm2Stato,
    attende: (ms) => new Promise((res) => setTimeout(res, ms)),
    audit: (rec) => { try { require('../lib/venues/polymarket-clob-maker/audit').appendMakerAudit(rec); } catch { /* */ } },
    commit, condizioni: v.condizioni,
  });
  console.log(`[riavvio-automatico] ${r.ok ? '✅' : '⛔'} ${r.motivo}`);
  for (const x of r.fatti) console.log(`  ${x.ok ? '✅' : '⛔'} ${x.agent}: ${x.motivo}`);
  if (r.ok) { await sh('pm2', ['save']); console.log('[riavvio-automatico] pm2 save eseguito'); }
  process.exit(r.ok ? 0 : 3);
})();
