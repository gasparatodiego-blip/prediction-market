// Minimal .env loader (dotenv is not installed) — same pattern as scripts/maker-live-test-order.js.
// Fills only MISSING keys, so a value already exported in the shell still wins. This exists so that
// secrets referenced below (ADMIN_ACCESS_SECRET) resolve from .env, which is gitignored, instead of
// being inlined into this file, which is tracked. Values are never printed.
(function loadEnv() {
  const fs = require('fs');
  const path = require('path');
  for (const f of ['.env', '.env.local']) {
    try {
      const txt = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      for (const line of txt.split('\n')) {
        const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        let v = m[2].replace(/\r$/, '');
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (process.env[m[1]] === undefined) process.env[m[1]] = v;
      }
    } catch { /* file absent → fine */ }
  }
})();

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// RIDUZIONE ALL'INSIEME MINIMO — 6 agosto 2026
//
// MOTIVO. Questo sistema serve a UNA cosa sola: i liquidity rewards su Polymarket. I rami scanner,
// arbitraggio multi-venue, copy trading, leaderboard e trader feed — il prodotto originale del vendor —
// sono stati abbandonati per decisione dell'operatore, che accetta consapevolmente di perderne le
// funzioni. Trenta processi sono stati fermati con `pm2 stop` (mai `pm2 delete`: le definizioni restano
// qui e tutto si riaccende con `pm2 start <nome>`).
//
// I NUMERI CHE L'HANNO DECISA. La box è un 4 GB con 3814 MB utilizzabili. Prima: 37 processi pm2,
// 2742 MB di RSS più 1303 MB in swap, Committed_AS al 105% del CommitLimit, dieci OOM kill in otto
// giorni. Il percorso critico dei rewards — feed, motore, watchdog, riprezzo, scheduler, dashboard,
// agent24 — pesa 444 MB. Il resto serviva rotte che in due giorni di log nginx hanno ricevuto ZERO
// richieste: /api/mm, /api/marketmaker, /api/poly-hft, /api/poly-whales, /api/leaderboard,
// /api/traders, /api/carry, /api/ticker, /api/copy, /api/prediction, /api/markets.
//
// ── PERCHÉ `autostart: false` E NON `autorestart: false` ──────────────────────────────────────────
// QUESTA È LA PARTE CHE NEL LUGLIO SCORSO È ANDATA STORTA, e vale la pena scriverla per esteso perché
// non è ovvia e ci è già costata una resurrezione silenziosa.
//
// Il 25 luglio agent-marketmaker fu fermato e marcato `autorestart: false`. Il 28 luglio, al reboot,
// era di nuovo online. Non per colpa di agent-monitor (non è nella sua lista) e non perché mancasse un
// `pm2 save`: il motivo sta nel codice di pm2.
//
// Al boot systemd esegue `pm2 resurrect` (unit pm2-root.service). Guardando lib/API/Startup.js, la
// resurrezione NON legge lo `status` salvato: costruisce `tostart` come «ogni nome nel dump che non è
// già in esecuzione» — e al reboot non è in esecuzione NIENTE — poi chiama `prepare` su ciascuno.
// L'unico campo che ferma davvero il lancio è in lib/God.js riga 223:
//
//     if (env_copy['autostart'] === false) { ...registra e basta... return cb(null, clu); }
//
// `autorestart` governa tutt'altro: cosa fare quando un processo GIÀ AVVIATO esce. Non ha voce sul
// lancio iniziale. E `autostart` assente non basta: la riga 180 mette lo status a STOPPED ma il
// confronto della 223 è `=== false`, quindi `undefined` prosegue e il processo parte lo stesso.
//
// Quindi: ogni app disabilitata qui sotto porta `autostart: false` ESPLICITO, e lo stesso valore è
// stato applicato allo stato vivo di pm2 prima di `pm2 save`, perché è il dump — non questo file — che
// il boot legge. Questo file protegge l'altro percorso, `pm2 start ecosystem.config.js`.
//
// RIACCENDERE UNO: `pm2 start ecosystem.config.js --only <nome>` dopo aver tolto il suo
// `autostart: false`, oppure `pm2 start <nome>` per una riaccensione temporanea. Poi `pm2 save`.
//
// ── IL DIFETTO DEL NEWS-GUARD: TROVATO IL 6 AGOSTO, CORRETTO LO STESSO GIORNO ─────────────────────
// agent27-news-guard era stato fermato con gli altri. È RIENTRATO poche ore dopo, perché la
// correzione al suo consumatore lo ha reso di nuovo utile: prima non lo era, e il motivo merita di
// restare scritto.
//
// COS'ERA. agent27 produce DUE file: /tmp/news-guard.json, che contiene i mercati con la loro
// severità, e /tmp/news-guard-state.json, che contiene solo la sua contabilità interna (alerted,
// bookHist, regimeState, actionCooldown, actionHourly, providerHealth) e NESSUN campo `markets`.
// agent35-maker leggeva il SECONDO e vi cercava `.markets`. Quel campo lì non è mai esistito, quindi
// `newsByMarket` era SEMPRE VUOTA: `newsForceClose` sempre falso e il rail `news-high` di
// lib/maker/risk-rails.js senza un solo input in tutta la vita del sistema. La severità di agent27
// raggiungeva solo /api/rewards-unified, che ha zero richieste.
//
// PERCHÉ È SOPRAVVISSUTO TANTO. Da fuori un rail SENZA input e un rail con input tranquillo producono
// lo stesso silenzio. Non c'era modo di distinguerli guardando lo stato del motore.
//
// COSA È STATO FATTO. agent35 ora legge /tmp/news-guard.json e ne adatta la forma (lì `markets` è un
// ARRAY di righe con `marketId` e `newsRisk` — la severità effettiva del regime, con isteresi —
// accanto a `severity`), filtrando per venue polymarket. Aggiunto un limite di età di 30 minuti: oltre
// quello la severità NON viene usata e la mappa resta vuota di proposito, perché un freno che si
// aziona su una notizia di ieri è peggio di un freno che non c'è, e uno bloccato su un 'high' stantio
// congelerebbe il mercato per sempre. E soprattutto: lo stato del motore pubblica ora `newsFeed`
// (file, età, se è fresco, quanti mercati portano severità, e PERCHÉ sono zero quando lo sono) più
// `newsSeverity` su ogni mercato — così la cecità che ha nascosto il difetto non può ripetersi.
//
// VERIFICATO il 6 agosto: 118 mercati con severità, file fresco, entrambi i mercati dell'universo di
// agent35 con `newsSeverity:'low'`, e il rail `news-high` che scatta su 'high' e su nient'altro.
//
// agent27 è quindi TENUTO ACCESO e sorvegliato da agent-monitor: se muore, il suo file invecchia,
// agent35 lo scarta dopo 30 minuti — correttamente — e il freno torna cieco.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

module.exports = {
  apps: [
    {
      name:          'agent14-rebalancer',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent14-rebalancer.js',
      cwd:           '/root/prediction-market',
      restart_delay: 30000,
      max_restarts:  20,
      max_memory_restart: '150M',   // small: 5-coin Binance funding poll, writes 2 tiny JSON files
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent29-verifier',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent29-verifier.js',
      cwd:           '/root/prediction-market',
      restart_delay: 30000,
      max_restarts:  20,
      max_memory_restart: '160M',   // small: reads served feeds, bounded per-cycle venue calls
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent28-perp-spot',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent28-perp-spot.js',
      cwd:           '/root/prediction-market',
      restart_delay: 30000,
      max_restarts:  20,
      max_memory_restart: '120M',   // tiny: reads 2 JSON files, writes 1, no network
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent27-news-guard',
      script:        './agents/agent27-news-guard.js',
      cwd:           '/root/prediction-market',
      restart_delay: 30000,
      max_restarts:  20,
      max_memory_restart: '150M',   // small: RSS text + a per-market news cache
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent26-landing-auditor',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent26-landing-auditor.js',
      cwd:           '/root/prediction-market',
      restart_delay: 30000,
      max_restarts:  20,
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent25-kalshi-rewards',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent25-kalshi-rewards.js',
      cwd:           '/root/prediction-market',
      restart_delay: 60000,
      max_restarts:  20,
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent24-liquidity-rewards',
      script:        './agents/agent24-liquidity-rewards.js',
      cwd:           '/root/prediction-market',
      restart_delay: 60000,
      max_restarts:  20,
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent23-prediction-repricer',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent23-prediction-repricer.js',
      cwd:           '/root/prediction-market',
      restart_delay: 30000,
      max_restarts:  20,
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'dashboard',
      script:        'npm',
      args:          'start -- --port 3000',
      cwd:           '/root/prediction-market',
      restart_delay: 5000,
      max_restarts:  20,
      watch:         false,
      // MAKER_FUNDING_APPROVED — added 2026-07-30 at the operator's explicit in-session confirmation.
      // The MANUAL ORDERS panel runs IN THIS PROCESS, and lib/maker/manual-order.js:buildPlacementAdapter
      // reads this flag from the dashboard's own env. Until it was set here the panel's adapter always
      // refused at the 'funding-approval' gate (adapter.js evaluatePlacementGate), BEFORE signing,
      // BEFORE validateOrder() and BEFORE the placement switch — so a hand order could never reach the
      // venue no matter what MANUAL_ORDER_PLACEMENT said, and the panel's banner did not surface it.
      // It is the SAME attestation agent35 already carries (funder 0x4C81F1…bdee, 100 pUSD, all six v2
      // approvals granted, read on-chain 2026-07-29); this only stops the two processes disagreeing.
      // It gates ONLY funding: the kill switch, caps, manual-mode ownership, venue-rules, the live-min
      // pin and validateOrder() are all independent and all still apply.
      // Set HERE rather than in .env deliberately: an ecosystem env survives pm2 restarts AND is
      // observable in /proc/<pid>/environ, so "is the live process actually reading it?" is answerable
      // without an admin session. Applying an edit here needs the ecosystem file on the restart:
      //   pm2 restart agents/ecosystem.config.js --only dashboard --update-env
      // To disarm hand-placed sends, prefer MANUAL_ORDER_PLACEMENT=dry-run in .env (one switch, one job).
      env:           { NODE_ENV: 'production', HOME: '/root', MAKER_FUNDING_APPROVED: 'true' },
    },
    {
      name:          'agent-data-collector',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent-data-collector.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent10-binance',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent10-binance.js',
      cwd:           '/root/prediction-market',
      restart_delay: 5000,
      max_restarts:  20,
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent-master',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent-master.js',
      cwd:           '/root/prediction-market',
      restart_delay: 30000,
      max_restarts:  10,
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent-monitor',
      script:        './agents/agent-monitor.js',
      cwd:           '/root/prediction-market',
      restart_delay: 10000,
      max_restarts:  20,
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent-marketmaker',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent-marketmaker.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      watch:         false,
      // STOPPED 2026-07-25 as dead weight (fleet-focus on the liquidity-rewards lane). Its output
      // /tmp/marketmaker-opps.json had been frozen since 2026-07-12 (~13 days, empty logs) and has NO
      // live UI consumer — /api/marketmaker is referenced only by dead .save/.backup files. Definition
      // kept (reversible: `pm2 start ecosystem.config.js --only agent-marketmaker`); autorestart:false
      // so a fleet-wide `pm2 start` does not silently relaunch a producer nobody reads.
      autorestart:   false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent-liquidity',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent-liquidity.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent2-fetcher',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent2-fetcher.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      max_memory_restart: '700M',   // self-recycle above ~564MB normal footprint, below OOM-cascade territory
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent3-matcher-politics',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent3-matcher-politics.js',
      cwd:           '/root/prediction-market',
      restart_delay: 30000,
      max_restarts:  10,
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent4-matcher-other',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent4-matcher-other.js',
      cwd:           '/root/prediction-market',
      restart_delay: 30000,
      max_restarts:  10,
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent5-calculator',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent5-calculator.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      max_memory_restart: '500M',   // self-recycle above ~360-390MB normal footprint, below OOM-cascade territory
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent15-funding-writer',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent15-funding-writer.js',
      cwd:           '/root/prediction-market',
      restart_delay: 10000,
      max_restarts:  20,
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent16-poly-hft',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent16-poly-hft.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent17-poly-whales',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent17-poly-whales.js',
      cwd:           '/root/prediction-market',
      restart_delay: 30000,
      max_restarts:  20,
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent18-mm-analyzer',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent18-mm-analyzer.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent19-basis',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent19-basis.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent20-leaderboard',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent20-leaderboard.js',
      cwd:           '/root/prediction-market',
      // Boot-crash-loop throttle: back off fast restarts instead of hammering.
      restart_delay:             5000,
      exp_backoff_restart_delay: 200,
      max_restarts:              15,
      min_uptime:                30000,
      autorestart:               true,
      // Memory ceiling — sized for a GLOBAL-OOM box (3.7GB total, ~0.5–1GB free).
      // loadCache() already STREAMS the 187MB cache (stream-json) and the boot
      // installs uncaughtException/unhandledRejection handlers — so a clean throw
      // is pm2-recoverable. The residual death was NOT recoverable: the enrichment
      // scan peaked at ~766MB heap against a 768MB --max-old-space-size cap (see the
      // Scavenge 765.9/777.6 MB GC-thrash, mutator util ~0.31), so a single extra
      // allocation tripped "FATAL ERROR: JavaScript heap out of memory" — a V8 abort
      // that NO handler can catch → hard SIGABRT → "Process not found". Fix:
      //   1) --max-old-space-size=1536: real headroom so the scan peak (~766MB) never
      //      touches the V8 cap and never FATAL-aborts. It is a BACKSTOP, not the
      //      operating point — steady-state RSS is ~430MB.
      //   2) max_memory_restart 1000M: pm2 SOFT cap. Sits above the true peak and below
      //      the V8 backstop (1536MB) so a real runaway is caught by pm2 as a clean
      //      recoverable restart BEFORE V8 aborts.
      //      Lowered 1200M→1000M 2026-07-18 to trip ~200MB earlier on a regression. The
      //      ~766MB above is HEAP during the Jul-6 FATAL under the OLD 768MB cap, where
      //      V8 was GC-thrashing at its limit — not the RSS pm2 measures under this cap.
      //      Measured RSS under the current config: VmHWM 652.8MiB — the kernel's
      //      high-water across ~146 scans of one 3.05-day process lifetime — and 559MB
      //      on a freshly 2s-sampled scan. 1000M leaves ~53% headroom over that worst
      //      case, so a healthy scan cannot trip it; the cap only bites a genuine leak.
      //      NOTE: a lower cap would be a FALSE win — the Jul-11 deaths were kernel
      //      global-OOM SIGKILLs at 405–615MB RSS, below any ceiling in this range; no
      //      pm2 soft cap can pre-empt a global OOM.
      node_args:          '--max-old-space-size=1536',
      max_memory_restart: '1000M',
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent21-copy-watcher',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent21-copy-watcher.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent22-funding-alerts',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent22-funding-alerts.js',
      cwd:           '/root/prediction-market',
      restart_delay: 10000,
      max_restarts:  20,
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent30-trader-feed',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent30-trader-feed.js',
      cwd:           '/root/prediction-market',
      restart_delay: 10000,
      max_restarts:  20,
      watch:         false,
      autorestart:   true,
      max_memory_restart: '450M',   // self-recycle above ~271MB normal footprint, below OOM-cascade territory
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent31-trader-auditor',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent31-trader-auditor.js',
      cwd:           '/root/prediction-market',
      restart_delay: 30000,
      max_restarts:  20,
      watch:         false,
      autorestart:   true,
      max_memory_restart: '200M',   // small: full-scan re-reads source per wallet, keeps only summaries
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent32-paper-trader',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent32-paper-trader.js',
      cwd:           '/root/prediction-market',
      restart_delay: 30000,
      max_restarts:  20,
      watch:         false,
      autorestart:   true,
      max_memory_restart: '160M',   // small: reads a few engine JSON files, marks a paper book, writes 1
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent33-sport-recorder',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent33-sport-recorder.js',
      cwd:           '/root/prediction-market',
      restart_delay: 30000,
      max_restarts:  20,
      watch:         false,
      autorestart:   true,
      // Streams rows straight to JSONL and keeps only the current cycle's rows plus a
      // small per-sport market pool in memory — nothing accumulates across cycles. 450M
      // matches agent30's ceiling: ample headroom on the 4GB box, well below OOM-cascade.
      max_memory_restart: '450M',
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent34-clob-ws',
      script:        './agents/agent34-clob-ws.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      // Small + bounded: one WS connection, ≤120 subscribed assets, in-memory books
      // only (measured ~a few KB/subscription — see /tmp/clob-live-books.json memory{}).
      // Own process for FAILURE ISOLATION: a dead socket must never stall agent27 or
      // the dashboard. autorestart so a hard socket death self-heals.
      max_memory_restart: '200M',
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent35-maker',
      script:        './agents/agent35-maker.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      // The automated liquidity-reward MAKER engine. FIRST component that can place orders — so it runs
      // behind the staged MAKER_MODE ladder and defaults to 'off' (venue writes unreachable). Its own
      // process for failure isolation. It reads agent34's live books + the operator's RewardsLeg config,
      // computes quotes off the ADJUSTED mid, runs every risk rail, and (in paper) logs what it WOULD
      // post. Live modes require a separate reviewed change to wire the custody signer — off/paper cannot
      // reach a venue write. Default env pins MAKER_MODE=off; advancing a stage is an explicit human edit.
      max_memory_restart: '250M',
      watch:         false,
      autorestart:   true,
      // MAKER_ORDER_TTL_SECONDS: venue-native GTD expiry on every order (survives host death). Must exceed
      // the maker refresh interval or agent35 refuses to start (startup assertion). Venue GTD floor is 3min.
      // ADMIN_ACCESS_SECRET is read from .env (gitignored), never inlined here — this file is tracked.
      // MAKER_FUNDING_APPROVED — the HUMAN attestation that the funder is actually funded and approved.
      // It was 'false' from 2026-07-29 because the previous attestation referred to a wallet whose
      // signing key had since been revoked; attesting for a wallet you no longer hold is exactly the
      // failure this flag exists to prevent.
      //
      // Set to 'true' on 2026-07-29 for funder 0x4C81F1…bdee, and it is an attestation with a verified
      // basis rather than a formality. Read on-chain the same day (eth_call, block 91098546):
      //   pUSD balance on the funder                          100.0
      //   pUSD allowance → CTFExchangeV2                      unlimited
      //   pUSD allowance → NegRiskCtfExchangeV2               unlimited
      //   pUSD allowance → NegRiskAdapter                     unlimited
      //   CTF ERC-1155 setApprovalForAll → all three           granted
      // Confirmed twice, by scripts/maker-wallet-preflight.ts and by an independent direct read.
      //
      // THIS FLAG ALONE PLACES NOTHING. It removes ONE gate. MAKER_MODE=off still means no adapter is
      // built at all, and MAKER_PLACEMENT=dry-run still means a fully armed adapter signs and validates
      // but never POSTs. If the funder ever changes, set this back to 'false' FIRST.
      //
      // MAKER_FUNDER_ADDRESS / MAKER_SIGNATURE_TYPE — WHO the maker signs FOR (lib/.../funder.js).
      // agent35-maker.js does NOT read .env itself; it takes process.env from pm2, so these must be
      // named HERE or the agent silently falls back to self-custody EOA (type 0, maker == signer, an
      // account holding nothing). Both are PUBLIC values (a 0x address and a small integer), so they
      // are inlined rather than pulled from the gitignored .env — .env carries the same pair for the
      // tsx scripts, which load it by hand. KEEP THE TWO IN SYNC: agent35 logs the pair it resolved on
      // every boot ("signing identity — signatureType=… funder=…"), so drift shows up in `pm2 logs
      // agent35-maker` rather than at the venue.
      //
      // funder 0x4C81F1…bdee: confirmed by polymarket.com's profile API, by eth_getCode (a deployed
      // Solady ERC-1967 proxy whose owner() is the signer), and by CTFExchangeV2.validateOrder().
      // It is NOT getProxyWalletAddress(signer) = 0x87a01e28…, which has no code and no funds.
      // type 3 (POLY_1271): chosen by the VENUE, not by us — scripts/maker-signing-proof.ts signed a
      // real order for this funder at each candidate type and validateOrder() reverted on 1 and 2 and
      // ACCEPTED 3. This is a post-2026-06-29 ERC-1271 deposit wallet, so 1 and 2 cannot work on it.
      //
      // MAKER_LIVE_MIN_MARKET — repointed 2026-07-29 to the Harry Kane Ballon d'Or market
      // (0x12dc2b61…d06a). The previous pin (0x6bd56627…, "Putin out by 2026") could not host a viable
      // test: its mid is 0.085, and a one-sided configuration with the mid in the tails (<0.10) scores
      // EXACTLY ZERO under Polymarket's reward formula, while making it two-sided cost ~$198 because
      // min_incentive_size there is 200 shares and the NO side prices near $0.91. The new market has
      // min_incentive_size 50, mid ≈0.461 (nowhere near the tails) and a $117/day pool, so a genuine
      // two-sided pair costs ~$50 against the 100 pUSD actually deposited. Tick 0.001, negRisk TRUE —
      // its orders route to NegRiskCtfExchangeV2, so the Neg-Risk approvals are load-bearing here.
      //
      // MAKER_LIVE_MIN_CAP_USD — 25 → 30 (luglio) → 1000 il 3 agosto 2026, su istruzione esplicita
      // dell'operatore. Questo tetto e' PER ORDINE (adapter.js rifiuta qualunque postOrder sopra), non un
      // totale, ed e' il MINIMO fra questo e maxOrderNotionalUsd in data/safety-risk-limits.json a
      // vincolare davvero: vanno alzati INSIEME, altrimenti il piu' basso continua a mordere.
      //
      // PERCHE' E' STATO TOLTO. A $30 il tetto non proteggeva da un rischio: tagliava l'allocazione.
      // L'allocatore di produzione proponeva $324 su un mercato e il motore poteva piazzarne $30 per
      // lato, quindi i $600 finivano spalmati su dieci mercati mediocri per aggirare un limite invece
      // che concentrati dove rendono. A 1000 il vincolo sparisce e l'allocazione torna quella ottimale.
      //
      // COSA RESTA A PROTEGGERE: maxOpenNotionalUsd ($600, ma conta solo i fill RICONCILIATI e la
      // riconciliazione gira ogni 60s), maxOrdersPerWindow (20/60s, immediato), maxDailyLossUsd ($25,
      // ma sulla perdita REALIZZATA) e — il backstop vero — il collaterale sul venue, che non lascia
      // comprare piu' di quanto si possiede.
      //
      // MAKER_PLACEMENT — 'send' as of 2026-07-29, at the operator's explicit instruction. THIS IS THE
      // SWITCH THAT LETS REAL ORDERS LEAVE THIS HOST. In 'dry-run' (the code default, and every value
      // that is not the exact string 'send') the engine builds and SIGNS each order, puts it to
      // CTFExchangeV2.validateOrder() via eth_call, reports it and drops it. In 'send' that same order
      // continues to POST /order with real collateral behind it.
      //
      // WHAT STILL STANDS BETWEEN THIS AND A LIVE ORDER: exactly one thing — the ARMING RECORD
      // (lib/maker/arming, data/maker-arming.json), which is currently DISARMED. An unarmed live engine
      // stands down exactly like a killed one, so nothing is placed today. Arming it is now the last
      // act; it is deliberately a two-step, TTL-bounded, preflight-gated write and not an env edit.
      //
      // If you are reading this while trying to work out why an order went out: this line is the answer.
      // Set it back to 'dry-run' to stop sends without touching anything else.
      //
      // Bounds in force when the first order does go out: per-order cap $30 (adapter, hard), open
      // notional $120, realised daily loss $25 (trips a durable auto-kill), post-only, GTD 180s native
      // expiry that survives host death, single pinned market, two legs totalling ~$49.55.
      env:           { NODE_ENV: 'production', HOME: '/root', ADMIN_ACCESS_SECRET: process.env.ADMIN_ACCESS_SECRET, MAKER_MODE: 'live-min', MAKER_PLACEMENT: 'send', MAKER_FUNDING_APPROVED: 'true', MAKER_FUNDER_ADDRESS: '0x4C81F19a436e8174f1f3b07d7c0169150Fbdbdee', MAKER_SIGNATURE_TYPE: '3', MAKER_LIVE_MIN_MARKET: '0x12dc2b61723b2a54fc1947a307389b5f32038e7a29a0e936ad1fe410b969d06a', MAKER_LIVE_MIN_CAP_USD: '1000', MAKER_ORDER_TTL_SECONDS: '180' },
    },
    {
      name:          'agent36-book-velocity',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent36-book-velocity.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      // MEMORY CAP JUSTIFICATION (4GB box, ~82% used, no other agent capped below this
      // without reason — this one is genuinely small and must stay small):
      //   • Retained state is a bounded ring of 40 book snapshots x ~260 markets x 5
      //     numbers ≈ 52k numbers ≈ well under 1MB. Nothing accumulates across cycles:
      //     the ring is spliced to RING every push and series for markets that leave
      //     the watchlist are deleted each cycle.
      //   • The only large transient is the Polymarket batch /books response —
      //     MEASURED at 473KB of JSON for all 120 tokens, a few MB once parsed, freed
      //     each cycle. Kalshi's batch is smaller.
      //   • Node baseline RSS for this shape of agent is ~45-55MB (agent34, same
      //     library surface, sits at 55.7MB).
      // 200M therefore leaves ~3.5x headroom over the expected working set while still
      // being a hard stop well below the level that could contribute to an OOM cascade
      // on this box. Matches agent34-clob-ws, the closest comparable process.
      max_memory_restart: '200M',
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent37-maker-watchdog',
      script:        './agents/agent37-maker-watchdog.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      // The DEAD-MAN switch for agent35-maker. SEPARATE process by design — a watchdog inside the process
      // it watches dies with it. Polls data/maker-heartbeat.json every 15s; if stale beyond
      // MAKER_DEADMAN_SECONDS (120) it cancels ALL open orders on every configured venue via the
      // CANCEL-ONLY surface (lib/maker/cancel-all → address-only signer; structurally cannot place) and
      // alerts Telegram. Tiny footprint (reads two small JSON files, no book/market data). NOTE: a
      // same-host watchdog does NOT survive host death — that is the venue-native order TTL's job.
      // (Named 37, not 36: slot 36 is agent36-book-velocity.)
      max_memory_restart: '150M',
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root', MAKER_DEADMAN_SECONDS: '120' },
    },
    {
      name:          'agent40-manual-reprice',
      script:        './agents/agent40-manual-reprice.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      // The BAND-EXIT WATCHER for HAND-PLACED orders. Replaces the fixed ~180s GTD expiry on manual
      // orders with a price-driven rule: on a market whose auto-reprice switch is ON, a hand order rests
      // as GTC (no venue expiry) and is cancelled+re-placed ONLY when the live mid has moved enough to
      // push it out of the reward band. If the mid stays put, the order is never touched.
      //
      // INERT UNTIL SWITCHED ON. Both the global master switch and the per-market opt-in live in
      // data/maker-auto-reprice.json and default OFF, so this process running changes nothing on its own;
      // it logs "idle: disabled-global" and does no venue I/O at all. It also does nothing while the
      // global kill switch is set, or on a market that is not in manual mode.
      //
      // It owns no adapter, no credentials and no signing key: its only reachable venue surface is
      // lib/maker/manual-order.replaceManualOrder — the same function the panel's "Riprezza" button
      // calls — so MANUAL_ORDER_PLACEMENT, the caps, venue-rules and validateOrder() all still apply.
      // FOOTPRINT, measured rather than guessed: ~107 MB steady. Most of it is the CLOB read path's
      // ethers dependency, loaded once. Per cycle it does two small JSON reads, a getOpenOrders per
      // enabled market, and an INCREMENTAL tail of the append-only audit trail.
      //
      // WHY THE CEILING IS 350M AND NOT 200M. On a cold start the attribution cache has to catch up on
      // the whole audit trail (80 MB / 268k lines today, and it grows), which transiently peaks around
      // 158 MB before settling back to ~107 MB. At 200M pm2 killed the process mid-catch-up roughly twice
      // a minute — a restart loop with an EMPTY error log and exit code 0, because nothing crashed: pm2
      // was enforcing the ceiling. 350M leaves room for that one-off catch-up and for the trail to keep
      // growing, while still being a real ceiling at ~3x the steady state.
      // (Named 40: slots 36-39 are book-velocity, maker-watchdog, tape-watchdog, net-rerun.)
      max_memory_restart: '350M',
      watch:         false,
      autorestart:   true,
      // ── MAKER_FUNDING_APPROVED — ESPLICITA, NON PIU' SOLO IMPLICITA (4 agosto 2026) ───────────────
      // ATTENZIONE A COSA QUESTA RIGA E' E A COSA NON E'. Non corregge un difetto: agent40 aveva GIA'
      // l'attestazione a runtime, perche' in testa al file c'e' un caricatore di .env scritto a mano
      // («pm2 does not auto-load project env files») che la legge da li' all'avvio.
      //
      // L'errore che ha prodotto questa riga vale piu' della riga stessa: /proc/<pid>/environ mostra
      // l'ambiente al momento dell'EXEC, non quello che il processo si costruisce dopo. Un processo che
      // scrive process.env all'avvio e' invisibile a /proc, e leggere /proc «invece di pm2» sembrava piu'
      // rigoroso mentre rispondeva a una domanda diversa da quella posta.
      //
      // Perche' tenerla comunque: due fonti che dicono la stessa cosa sono meglio di una che dipende dal
      // fatto che .env esista e sia leggibile dal processo, e cosi' la variabile diventa ispezionabile
      // dall'esterno (pm2 env, /proc) invece che solo dall'interno.
      //
      // NON accende niente: e' un'attestazione umana (il wallet e' finanziato e le approvazioni on-chain
      // ci sono). L'interruttore di invio resta MANUAL_ORDER_PLACEMENT, e restano kill-switch, cap,
      // venue-rules e validateOrder.
      env:           { NODE_ENV: 'production', HOME: '/root', MAKER_FUNDING_APPROVED: 'true' },
    },
    {
      name:          'agent38-tape-watchdog',
      script:        './agents/agent38-tape-watchdog.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      // Continuity watchdog for the rewards TRADE-TAPE + MID-HISTORY journals (Jul-25 45h collection).
      // SEPARATE process by design — a watchdog inside agent34 dies with it. Reads only the two newest
      // daily journals (trailing-window tailRows, never the whole day), so a tiny footprint. It does NOT
      // duplicate agent34's socket self-heal (PING/35s watchdog/backoff); it catches the case those miss —
      // the process WEDGED-but-online with the files not growing — by restarting agent34 ONCE (by name,
      // never pkill) and, only if that fails, sending ONE Telegram alert per fault episode. Places nothing.
      max_memory_restart: '150M',
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent39-net-rerun',
      // DISABILITATO 2026-08-06 — vedi la nota in testa al file.
      autostart:     false,
      script:        './agents/agent39-net-rerun.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      // Automates the TRIGGER for the rewards net verdict, never the conclusion. Hourly, it measures the
      // CONTINUOUS tape coverage (span − Σ mid-history outage gaps) and, only at ≥48h of real coverage,
      // runs scripts/rewards-replay --method tape once, writes a dated result, and sends ONE Telegram
      // headline. It never fires early and never relaxes the replay's refusal-to-annualise guard; a
      // fragmented window (agent34 restarted mid-collection) is reported as fragmented, not annualised.
      // Tiny footprint (streams two journals' timestamps hourly). Places/signs/decrypts nothing.
      max_memory_restart: '200M',
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent41-realloc-scheduler',
      script:        './agents/agent41-realloc-scheduler.js',
      cwd:           '/root/prediction-market',
      restart_delay: 30000,
      max_restarts:  20,
      // IL RIALLOCATORE PERIODICO. Ogni 6 ore chiede al VENUE (non alla cache locale) se i mercati in
      // gestione sono ancora quelli su cui il piano fu deciso — risolto, non più negoziabile, senza
      // banda, in scadenza, o con il montepremi crollato sotto metà — e se anche uno solo non lo è più
      // rifà il piano al saldo libero attuale (tetto 30% per mercato) e lo mette in opera con
      // lib/maker/allocation-reset.js. Se sono tutti ancora buoni non fa niente: niente churn.
      //
      // Il reset scatta per DUE motivi indipendenti, registrati separatamente: la VALIDITÀ (sopra) e il
      // VALORE — ogni ciclo ricalcola anche il piano ristretto ai mercati già in gestione e, se il piano
      // libero vale più del 20% in più, rialloca anche con tutti i mercati ancora validi.
      //
      // È L'UNICO PROCESSO CHE PUÒ CANCELLARE E PIAZZARE ORDINI VERI SENZA UNA CONFERMA UMANA, per
      // eccezione esplicita dell'operatore (3 agosto 2026). Perciò la riga qui sotto NON basta ad
      // accenderlo: senza REALLOC_SCHEDULER_ENABLED=1 il processo resta vivo e completamente inerte —
      // nessuna lettura del venue, nessun piano, nessun ordine.
      //
      // STATO ATTUALE — 7 agosto 2026: ACCESO, E FERMO PERCHÉ NESSUNO HA ANCORA PREMUTO AVVIA. Gira il
      // ciclo intero ogni 6 ore, entrambi i trigger, e scrive nel registro cosa AVREBBE fatto; non
      // cancella e non piazza niente.
      //
      // QUI NON C'È PIÙ NESSUN INTERRUTTORE FRA «RACCONTA» E «FA». C'era, era REALLOC_SCHEDULER_DRY_RUN,
      // ed è stata rimossa il 7 agosto 2026 insieme al codice che la leggeva. Adesso decide un flag
      // solo, `data/maker-bot-enabled.json`, che l'operatore commuta col tasto AVVIA/FERMA nella tab
      // Mercati e che agent41 rilegge A OGNI GIRO: non serve toccare questo file e non serve un
      // riavvio. Non rimettere qui una variabile per la stessa decisione — due interruttori per una
      // cosa sola significano che spegnerne uno non la spegne.
      //
      // Non apre nessuna strada nuova verso il venue: passa dalle stesse funzioni del bottone del
      // pannello (listManualOrders / cancelManualOrder in corsia cancel-only / runBulkAllocation), quindi
      // kill switch, cap di esposizione, rate limit 20/60s e gate per riga valgono identici. Ogni ciclo
      // finisce in data/realloc-scheduler.jsonl, un passo per riga.
      max_memory_restart: '400M',
      watch:         false,
      autorestart:   true,
      env:           {
        NODE_ENV: 'production', HOME: '/root',
        REALLOC_SCHEDULER_ENABLED: '1',   // ← fa esistere il processo; NON gli fa piazzare niente (vedi sopra).
        // ── DICHIARATA, NON PIÙ SOLO EREDITATA (4 agosto 2026) ────────────────────────────────────
        // Qui la fragilità è REALE, a differenza del caso di agent40: agent41 NON ha il caricatore di
        // .env scritto a mano che agent40 ha in testa al file (verificato: `grep -c "Load .env"` → 0).
        // Girava con MAKER_FUNDING_APPROVED=true solo perché la ereditava dall'ambiente del demone pm2
        // — cercandola in questo file non c'era, e nessuna riga di configurazione la garantiva.
        //
        // Perché conta proprio su questo processo: agent41 è l'UNICO che apre posizioni da solo. Se un
        // giorno il demone pm2 ripartisse da una shell pulita, agent41 perderebbe l'attestazione senza
        // che niente lo dica, e OGNI piazzamento verrebbe rifiutato con gate `funding-approval` —
        // silenziosamente, dentro un ciclo automatico che nessuno sta guardando. È lo stesso difetto
        // appena corretto su agent40, sul processo dove farebbe più danno.
        //
        // NON arma niente: è un'attestazione umana. L'interruttore fra «racconta» e «fa» resta la riga
        // qui sopra, e resta a 1.
        MAKER_FUNDING_APPROVED: 'true',
      },
    },
    {
      name:          'agent42-watch-makers',
      script:        './agents/agent42-watch-makers.js',
      cwd:           '/root/prediction-market',
      restart_delay: 20000,
      max_restarts:  20,
      // IL MONITOR DEI 21 MAKER DI RIFERIMENTO. Segue l'attività pubblica dei 21 wallet del manuale v2
      // (data/manuale-operativo-maker-v2.md) e ne ricava tre segnali: ingressi su mercati mai toccati,
      // convergenze (≥2 dei 21 sullo stesso mercato entro due ore) e ritiri pre-risoluzione. Scrive
      // data/maker-21-{eventi.jsonl,stato,statistiche,gamma-cache}.json e niente altro.
      //
      // È L'UNICO PROCESSO DELLA FLOTTA CHE NON PUÒ, NEMMENO IN LINEA DI PRINCIPIO, TOCCARE CAPITALE.
      // Non importa nulla da lib/maker/, non legge nessuno dei file che decidono il piazzamento, non
      // ha credenziali e non ne riceve dall'ambiente qui sotto: l'env dichiarato è il minimo che serve
      // a un processo node, senza una sola chiave. I file che scrive non hanno nessun lettore fra i
      // processi che piazzano — li legge solo /api/maker/watch-21, che a sua volta è di sola lettura.
      // Il segnale è informativo per COSTRUZIONE, non per disciplina: perché diventi un criterio di
      // selezione servirebbe una modifica esplicita all'allocatore, che non esiste.
      //
      // Perché un processo separato e non un ramo di agent34: agent34 parla col socket CLOB, che NON
      // porta l'identità di chi esegue (`last_trade_price` è {asset_id, price, side} — vedi
      // lib/clob-ws/live-book.js:125). L'attribuzione di un fill a un wallet esiste solo sulla
      // data-api, quindi questa è una fonte diversa con una cadenza diversa, e appenderla al processo
      // che tiene vivo il book significherebbe far dipendere il book da un polling che non gli serve.
      //
      // Cadenza 30 s + ~7 s di giro dei 21 wallet ⇒ un battito ogni ~37 s (agent-monitor lo sorveglia
      // con soglia 5 min). Un'assenza si recupera ripaginando la data-api; oltre 7 giorni diventa un
      // evento `buco` nel giornale, mai un silenzio.
      max_memory_restart: '250M',
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent43-guardian',
      script:        './agents/agent43-guardian.js',
      cwd:           '/root/prediction-market',
      restart_delay: 20000,
      max_restarts:  20,
      // IL GUARDIANO DELLE PERDITE ECONOMICHE. Sorveglia il CAPITALE, non i processi.
      //
      // NOME: era `agent42-guardian`, e condivideva il 42 con agent42-watch-makers qui sopra. pm2
      // distingue per nome intero e i due non collidevano, ma rompeva la convenzione «un numero, un
      // processo» che il resto della flotta rispetta (vedi agent37: «Named 37, not 36»). Rinominato
      // l'8 agosto 2026 in `agent43-guardian`, che era il candidato gia' indicato qui.
      //
      // COSA NON INSTRADA. La chiave di battito e' cambiata insieme al nome, ma NESSUNO la legge:
      // agent-monitor non sorveglia questo processo (non e' in WATCHED_AGENTS_RAW) e agent37 guarda i
      // battiti dei MOTORI, non i suoi. Il campo `by` del referto passa a `agent43-guardian` per i
      // referti NUOVI; quelli storici restano col nome vecchio, ed e' giusto — dicono chi li ha scritti.
      //
      // COSA FA CHE agent37 NON PUÒ FARE. agent37 chiede «il motore è vivo?» e guarda i battiti: un
      // motore che batte regolare, supera ogni preflight e intanto perde soldi è, per lui, sano. Questo
      // guarda l'unica cosa che quella domanda non copre — il capitale scende? Ogni 30 s confronta
      // (saldo pUSD + posizioni al prezzo corrente) con il baseline in data/guardian-baseline.json, e
      // oltre GUARDIAN_LOSS_PCT o GUARDIAN_LOSS_ABS cancella tutti gli ordini a riposo, deposita un
      // referto reason='guardian-auto-kill' e mette il bot su FERMA. Sono due guasti indipendenti,
      // quindi due processi: un doppio scatto simultaneo è innocuo (la seconda cancellazione trova il
      // libro già vuoto e riporta 0, non un errore) e i due referti restano distinguibili per `id`.
      //
      // LE SOGLIE SI RILEGGONO A OGNI GIRO dal file .env, non da questo env: `process.env` in pm2 è una
      // fotografia dell'avvio, e una soglia che per cambiare pretende un riavvio è una soglia che
      // durante il riavvio non protegge. Qui NON si dichiarano quindi GUARDIAN_LOSS_*: metterle qui
      // creerebbe un secondo posto dove sono definite, e due posti per un numero solo significano che
      // cambiarne uno non lo cambia.
      //
      // NON PUÒ PIAZZARE, per costruzione: la sua unica superficie verso il venue è lib/maker/cancel-all
      // (adapter di sola cancellazione, signer che non sa firmare). lib/maker/guardian-perdite.test.js
      // cammina il suo albero di require e fallisce se qualcuno ci trascina dentro un modulo di
      // piazzamento, oltre a vietare signTypedData/postOrder/placeManualOrder nel sorgente.
      //
      // NON FERMA LE USCITE. Usa FERMA (data/maker-bot-enabled.json) e NON il kill-switch, perché il
      // kill blocca anche lib/maker/auto-close («una chiusura è comunque un ordine nuovo»): killare
      // lascerebbe senza uscita proprio le posizioni che c'era da proteggere. Vedi il blocco in testa
      // ad agents/agent43-guardian.js per il ragionamento completo, incluso ciò che FERMA NON copre.
      //
      // Footprint atteso simile ad agent37 (due letture JSON e una lettura di saldo in cache per giro),
      // con l'aggiunta del path ethers di saldo-cache: 200M lascia margine abbondante.
      max_memory_restart: '200M',
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
  ],
};
