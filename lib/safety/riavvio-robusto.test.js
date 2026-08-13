'use strict';
// lib/safety/riavvio-robusto.test.js — UN PROCESSO CRITICO NON DEVE POTER RESTARE GIÙ IN SILENZIO.
//
// ═══ IL DIFETTO CHE QUESTO TEST BLOCCA ═════════════════════════════════════════════════════════════
// pm2 conta come riavvio *instabile* ogni uscita avvenuta prima di `min_uptime`, e al raggiungimento di
// `max_restarts` instabili consecutivi marca l'app `errored` e **smette di riprovare**. Con i valori in
// vigore fino al 12 agosto 2026 — `max_restarts: 20`, `min_uptime` non impostato (difetto pm2: 1 s) —
// bastavano **cinque minuti** di crash loop perché `agent43-guardian` o `agent40-manual-reprice`
// restassero giù per sempre. E dal 9 agosto 2026 (§5 punto 63) non esiste più un dead-man che guardi
// il loro battito: nessun meccanismo automatico se ne sarebbe accorto.
//
// ═══ COSA VERIFICA, E COSA DELIBERATAMENTE NON TOCCA ═══════════════════════════════════════════════
// Verifica che la politica sia applicata a TUTTI i processi critici — non che sia scritta da qualche
// parte: legge il modulo di configurazione e guarda i valori finali, quindi un blocco che ridichiarasse
// `max_restarts: 20` verrebbe comunque visto.
// NON verifica `restart_delay`, se non per pretendere che sia rimasto DIVERSO fra i vari agenti: quei
// numeri sono decisi caso per caso (agent24 ha 60 s per non martellare Gamma) e appiattirli sarebbe una
// regressione mascherata da uniformità.
//
// La prova sul campo — che un `kill -9` venga davvero recuperato — non sta qui: si fa sui processi vivi
// e non si può simulare in un test (vedi il riepilogo del blocco C, voce 2).
//
// Run: node lib/safety/riavvio-robusto.test.js

const path = require('path');
// Serve a verificare che ogni app dichiarata punti a uno script che esiste davvero: è il fatto che
// il vecchio conteggio delle app faceva da proxy, asserito direttamente.
const fs = require('fs');

const cfg = require(path.join(__dirname, '..', '..', 'agents', 'ecosystem.config.js'));
const { RIAVVIO_ROBUSTO, PROCESSI_CRITICI } = cfg;

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const app = (nome) => cfg.apps.find((a) => a.name === nome);

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1 · la politica esiste, è una sola, ed è dichiarata');
{
  ok('il config esporta la politica', RIAVVIO_ROBUSTO && typeof RIAVVIO_ROBUSTO === 'object');
  ok('  ed è congelata (non la si muta a runtime)', Object.isFrozen(RIAVVIO_ROBUSTO));
  ok('il config esporta l\'elenco dei critici', Array.isArray(PROCESSI_CRITICI) && PROCESSI_CRITICI.length > 0,
    `${PROCESSI_CRITICI.length} processi`);
  ok('autorestart è dichiarato true, non lasciato al difetto', RIAVVIO_ROBUSTO.autorestart === true);
  ok('min_uptime è impostato', Number.isFinite(RIAVVIO_ROBUSTO.min_uptime) && RIAVVIO_ROBUSTO.min_uptime > 0,
    `${RIAVVIO_ROBUSTO.min_uptime} ms`);
  ok('  e sta sopra il boot del processo più lento della flotta (~5 s, agent40)',
    RIAVVIO_ROBUSTO.min_uptime >= 10_000, `${RIAVVIO_ROBUSTO.min_uptime / 1000} s`);
  ok('max_restarts è molto sopra il vecchio 20', RIAVVIO_ROBUSTO.max_restarts >= 100,
    `${RIAVVIO_ROBUSTO.max_restarts}`);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2 · i processi che devono esserci, ci sono');
{
  // I tre senza i quali il capitale resta senza sorveglianza o senza gestione, più le due fonti di
  // dato che li alimentano. Se qualcuno toglie uno di questi dall'elenco, questo test diventa rosso.
  for (const n of ['agent40-manual-reprice', 'agent41-realloc-scheduler', 'agent43-guardian',
    'agent24-liquidity-rewards', 'agent34-clob-ws', 'dashboard']) {
    ok(`${n} è nell'elenco dei critici`, PROCESSI_CRITICI.includes(n));
  }
  ok('agent44-audit-scoperta NON è fra i critici', !PROCESSI_CRITICI.includes('agent44-audit-scoperta'),
    'gira a cron ed esce: renderlo «sempre vivo» sarebbe l\'opposto di ciò che è');
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n3 · la politica è applicata davvero, processo per processo');
{
  for (const n of PROCESSI_CRITICI) {
    const a = app(n);
    if (!a) { ok(`${n} esiste in ecosystem.config.js`, false); continue; }
    const applicata = a.autorestart === RIAVVIO_ROBUSTO.autorestart
      && a.min_uptime === RIAVVIO_ROBUSTO.min_uptime
      && a.max_restarts === RIAVVIO_ROBUSTO.max_restarts;
    ok(`${n}`, applicata,
      `autorestart=${a.autorestart} min_uptime=${a.min_uptime} max_restarts=${a.max_restarts}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n4 · la finestra di tentativi, in minuti, contro i 5 di prima');
{
  const VECCHI_MAX = 20;
  for (const n of PROCESSI_CRITICI) {
    const a = app(n);
    if (!a || !Number.isFinite(a.restart_delay)) continue;
    const primaMin = (VECCHI_MAX * a.restart_delay) / 60000;
    const dopoMin = (a.max_restarts * a.restart_delay) / 60000;
    ok(`${n}: ${primaMin.toFixed(0)} min → ${dopoMin.toFixed(0)} min`, dopoMin >= 30,
      `restart_delay ${a.restart_delay / 1000}s`);
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n5 · ciò che NON doveva cambiare');
{
  const q = app('agent44-audit-scoperta');
  ok('agent44 conserva autorestart:false', q && q.autorestart === false);
  ok('  e max_restarts:3', q && q.max_restarts === 3);
  ok('  e il suo cron', q && q.cron_restart === '7 3 * * *');
  ok('  e NON ha ricevuto min_uptime', q && q.min_uptime === undefined);

  // I restart_delay restano DIVERSI: appiattirli sarebbe una regressione travestita da uniformità.
  const ritardi = new Set(PROCESSI_CRITICI.map((n) => app(n)).filter(Boolean).map((a) => a.restart_delay));
  ok('i restart_delay dei critici NON sono stati appiattiti', ritardi.size >= 4,
    `${ritardi.size} valori distinti: ${[...ritardi].sort((x, y) => x - y).join(', ')} ms`);
  ok('agent24 conserva i suoi 60 s (per non martellare Gamma)', app('agent24-liquidity-rewards').restart_delay === 60000);

  // ── SI DIFENDE LA PROPRIETÀ, NON IL CONTEGGIO ─────────────────────────────────────────────────
  // Questa riga asseriva `cfg.apps.length === 40` ed è diventata rossa aggiungendo agent45, senza che
  // niente di ciò che protegge fosse cambiato. È la classe di difetto che §5.3 elenca — «non contare
  // occorrenze: un test che fotografa lo stato è verde durante la lavorazione e rosso un minuto dopo
  // il commit». Quel 40 era un proxy di due fatti veri, e i due fatti si asseriscono direttamente:
  //   ① i due processi RIMOSSI il 9 agosto 2026 non devono poter rientrare da una porta di servizio;
  //   ② ogni app dichiarata deve puntare a uno script che esiste davvero sul disco.
  const nomi = cfg.apps.map((a) => a.name);
  ok('agent35-maker resta rimosso', !nomi.includes('agent35-maker'));
  ok('agent37-maker-watchdog resta rimosso', !nomi.includes('agent37-maker-watchdog'));
  ok('nessun nome duplicato fra le app', new Set(nomi).size === nomi.length);
  const fantasmi = cfg.apps
    .filter((a) => a.script && a.script.startsWith('./'))
    .filter((a) => !fs.existsSync(path.join(__dirname, '..', '..', a.script)));
  ok('ogni app dichiarata punta a uno script che esiste', fantasmi.length === 0,
    fantasmi.map((a) => a.name).join(', '));
}

console.log(`\n===== riavvio-robusto: ${pass} passati, ${fail} falliti =====\n`);
process.exit(fail === 0 ? 0 : 1);
