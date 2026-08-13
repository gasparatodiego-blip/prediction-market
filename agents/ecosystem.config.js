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
// ⚠ REGISTRO STORICO. Il consumatore descritto qui sotto — agent35-maker — È STATO RIMOSSO dalla
// flotta e dal repo il 9 agosto 2026, insieme ad agent37-maker-watchdog e all'intero meccanismo di
// ARMING. Quello che segue resta come memoria del difetto e del criterio, non come descrizione dello
// stato attuale: oggi la severità di agent27 raggiunge /api/rewards-unified e nessun rail di motore.
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
      // ── PERCHE' NON PIU' `npm start` — trovato dalla prova `kill -9` del 12 agosto 2026 ───────────
      // `script:'npm', args:'start -- --port 3000'` faceva gestire a pm2 il PADRE (npm), che a sua
      // volta lancia `next start`, che lancia `next-server`. La porta 3000 la tiene il NIPOTE.
      // Un `kill -9` sul processo gestito da pm2 uccideva quindi solo il padre e lasciava
      // `next-server` ORFANO e vivo, con la porta ancora occupata: pm2 rilanciava, il nuovo processo
      // trovava la porta presa e moriva con EADDRINUSE, all'infinito. Misurato: 30 riavvii instabili
      // in tre minuti, e il servizio e' tornato solo dopo aver ucciso l'orfano A MANO.
      // Con la politica VECCHIA (`max_restarts: 20`) sarebbe stato marcato `errored` al ventesimo e
      // sarebbe rimasto giu' per sempre — cioe' i due difetti insieme producevano un dashboard che
      // non si rialzava da un crash. La politica robusta gli ha tenuto aperta la strada; questa riga
      // toglie la ragione per cui non riusciva a percorrerla.
      //
      // Eseguendo il binario di next DIRETTAMENTE, il processo che pm2 gestisce E' quello che possiede
      // la porta: `kill -9` la libera, e il riavvio trova campo libero. Nessuna catena di processi in
      // mezzo, quindi anche `pm2 stop`/`restart` diventano esatti invece che approssimati.
      // NB: `npm start` resta valido per l'avvio a mano — questo cambia solo come lo lancia pm2.
      script:        './node_modules/next/dist/bin/next',
      // ARGOMENTI IN FORMA DI ARRAY, e non come stringa: con `args: 'start --port 3000'` next riceveva
      // `3000` come PERCORSO DEL PROGETTO («Invalid project directory provided, no such directory:
      // /root/rewards-bot/3000») perche' `--port` si perdeva nel passaggio. L'array non viene ri-diviso
      // da nessuno, quindi ogni elemento arriva esattamente com'e' scritto.
      args:          ['start', '-p', '3000'],
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
      // It is the SAME attestation the maker lane has always carried (funder 0x4C81F1…bdee, 100 pUSD,
      // all six v2 approvals granted, read on-chain 2026-07-29).
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
      // (Named 40: slots 36-39 erano book-velocity, maker-watchdog, tape-watchdog, net-rerun. Il 37 è
      // libero dal 9 agosto 2026 — il dead-man dei motori è stato rimosso con agent35 — e resta tale:
      // riusare un numero renderebbe illeggibili i log storici.)
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
      // processo» che il resto della flotta rispetta (era la stessa regola del vecchio agent37,
      // «Named 37, not 36», rimosso il 9 agosto 2026). Rinominato
      // l'8 agosto 2026 in `agent43-guardian`, che era il candidato gia' indicato qui.
      //
      // COSA NON INSTRADA. La chiave di battito e' cambiata insieme al nome, ma NESSUNO la legge:
      // agent-monitor non sorveglia questo processo (non e' in WATCHED_AGENTS_RAW), e il dead-man dei
      // motori che guardava i battiti non esiste piu'. Il campo `by` del referto passa a `agent43-guardian` per i
      // referti NUOVI; quelli storici restano col nome vecchio, ed e' giusto — dicono chi li ha scritti.
      //
      // COSA FA CHE UN DEAD-MAN NON PUÒ FARE. Un dead-man chiede «il motore è vivo?» e guarda i battiti:
      // un motore che batte regolare e intanto perde soldi è, per lui, sano. Questo
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
      // Footprint atteso da processo leggero (due letture JSON e una lettura di saldo in cache per giro),
      // con l'aggiunta del path ethers di saldo-cache: 200M lascia margine abbondante.
      max_memory_restart: '200M',
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent44-audit-scoperta',
      script:        './agents/agent44-audit-scoperta.js',
      cwd:           '/root/prediction-market',
      // ── L'AUDIT DI SCOPERTA. TROVA, ARCHIVIA, ESCE. ──────────────────────────────────────────────
      // Legge il codice del bot una volta al giorno cercando i pattern di rischio che in questo
      // progetto hanno già prodotto guasti veri (costanti dello stesso concetto con valori diversi,
      // protezioni presenti su un percorso e assenti su un altro, flag che nessuno legge più, commenti
      // fermi a un valore vecchio, test rossi nuovi, collisioni di numerazione) e scrive
      // data/audit-coda.{json,md}. NON corregge niente e non tocca ordini né capitale — un test
      // cammina il suo albero dei require e fallisce se qualcuno ce li trascina dentro.
      //
      // ── PERCHÉ NON È SEMPRE VIVO, ED È LA COSA PIÙ IMPORTANTE DI QUESTO BLOCCO ───────────────────
      // Questo box ha DUE vCPU e dodici processi che gestiscono capitale reale, con load average già
      // intorno a 2. Un tredicesimo processo sempre in ascolto costerebbe RAM tutto il giorno per
      // lavorare due minuti. Quindi `cron_restart` + `autorestart: false`: pm2 lo avvia all'ora
      // giusta, lui gira, esce, e resta `stopped` fino al giorno dopo. Fra una scansione e l'altra
      // consuma ESATTAMENTE zero — si vede in `pm2 list`, dove sta a 0% e 0b.
      //
      // Perché pm2 e non una riga di crontab: la flotta di questo progetto è descritta in QUESTO file
      // e si ispeziona con `pm2 list`. Un job in crontab sarebbe l'unico pezzo invisibile a quella
      // convenzione — e la prima cosa che nessuno ricorderebbe di guardare. In più `pm2 save` lo porta
      // nel dump, quindi sopravvive a un riavvio della macchina senza un secondo posto da ricordare.
      //
      // ── L'ORA, SCELTA SUI DATI E NON A INTUITO ───────────────────────────────────────────────────
      // `sar` su nove giorni: le ore più quiete in UTC sono 02 (28,5% CPU), 03 (28,6%) e 04 (29,2%);
      // la peggiore è 08 (40,7%), poi 20 (39,0%) e 19 (38,7%). Fra le tre quiete si sceglie le 03
      // perché è l'unica che sta DOPO la finestra della riconciliazione notturna di agent40
      // (23:55 · 00:20 · 00:40 · 01:00) — così l'audit legge il confronto stima/consuntivo della notte
      // appena chiusa invece di quello del giorno prima — e prima della salita delle 06-08.
      // Il minuto 7 e non 0: in cima all'ora scattano i cron di sistema, e accodarsi a quelli sarebbe
      // il modo più semplice di rendere inutile tutto il resto di questo blocco.
      cron_restart: '7 3 * * *',
      autorestart:  false,
      // ── I TETTI DI RISORSA ──────────────────────────────────────────────────────────────────────
      // 150M è il taglio che questo repo usa già per i processi leggeri (agent38): non
      // introduce una scala nuova. La fotografia del codice sta in decine di MB, quindi c'è margine.
      // NB: con `autorestart:false` questo tetto è la seconda linea — la prima è il vigile interno
      // dell'agente, che si ferma da solo e SCRIVE PERCHÉ invece di essere ucciso in silenzio.
      max_memory_restart: '150M',
      watch:         false,
      // Se una scansione fallisce, il posto giusto per accorgersene è la coda del giorno dopo, non un
      // riavvio a raffica: `max_restarts` basso e `restart_delay` lungo perché anche il caso peggiore
      // (crash immediato in loop) non possa diventare un consumo di CPU.
      max_restarts:  3,
      restart_delay: 60000,
      // La priorità CPU/I/O NON si imposta qui: pm2 esegue lo script direttamente e non c'è modo di
      // anteporgli `nice`/`ionice`. È l'agente ad abbassarsi da solo alla prima riga di lavoro
      // (`os.setPriority` + `ionice -c 3` sul proprio pid), il che è anche più robusto — vale comunque
      // lo si lanci, anche a mano.
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent45-osservatore',
      script:        './agents/agent45-osservatore.js',
      cwd:           '/root/prediction-market',
      // ── L'OSSERVATORE MUTO. CAMPIONA, SCRIVE, NIENT'ALTRO. ──────────────────────────────────────
      // Un campione ogni 60 s in data/osservatore/: ordini a riposo, mercati coperti, posizioni,
      // saldo, PnL del guardiano, stato degli interruttori. Piu' un giornale in italiano con gli
      // eventi (pre-allarme, scatto, collasso, transizioni di copertura, merge, cancellazioni).
      //
      // ── PERCHE' E' SEMPRE VIVO, a differenza di agent44 ─────────────────────────────────────────
      // agent44 fotografa il CODICE, che fra una notte e l'altra non cambia da solo: puo' girare una
      // volta al giorno e uscire. Questo fotografa lo STATO, che cambia di minuto in minuto, e una
      // serie temporale con dei buchi non e' una serie temporale. Il costo e' quello di un processo
      // che dorme 59 secondi su 60 e legge qualche file: misurabile in pm2, non in percentuale di CPU.
      //
      // ── PERCHE' PUO' RIAVVIARSI DA SOLO SENZA CHIEDERE (§2 regola 2) ────────────────────────────
      // La regola 2 chiede conferma perche' un riavvio puo' cambiare cosa il bot FA. Questo processo
      // non fa niente: non piazza, non cancella, non tocca AVVIA/FERMA/KILL, e scrive esclusivamente
      // sotto data/osservatore/. Un test (`lib/osservatore/campionamento.test.js`) cammina il suo
      // albero dei `require` e fallisce se qualcuno ci trascina dentro l'adapter, il signer,
      // manual-order, cancel-all, bot-enabled o il kill switch. Riavviarlo puo' al piu' produrre un
      // buco nella serie — che il campione successivo DICHIARA come salto invece di nasconderlo.
      autorestart:   true,
      // 150M e' il taglio dei processi leggeri di questo repo (agent38, agent44): non introduce una
      // scala nuova. L'osservatore tiene in memoria l'ultima ora di campioni e poco altro; la coda del
      // giornale maker la legge in modo incrementale, con un tetto di 8 MB per giro.
      max_memory_restart: '150M',
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// LA POLITICA DI RIAVVIO DEI PROCESSI CRITICI — 12 agosto 2026
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// IL BUCO, MISURATO SUI PROCESSI VIVI e non dedotto dal file: tutti e dieci i processi critici girano
// con `max_restarts: 20` e `min_uptime` NON impostato, cioe' il difetto di pm2 di **1 secondo**.
// La semantica di pm2 e' questa: un'uscita prima di `min_uptime` conta come riavvio *instabile*, e al
// ventesimo instabile consecutivo pm2 marca l'app `errored` e **SMETTE DI RIPROVARE**.
//
//   oggi:  20 tentativi x 15 s di `restart_delay` = **5 minuti**, poi giu' per sempre.
//
// Cinque minuti e' quanto basta a un 429 prolungato del venue in fase di boot, o a un disco pieno che
// si libera da solo. E chi resta giu' non e' un processo qualsiasi: `agent43-guardian` e' l'unica cosa
// che sorveglia le perdite, e `agent40-manual-reprice` l'unica che gestisce le posizioni aperte.
// Dal 9 agosto 2026 (§5 punto 63, rimozione di agent37) **nessuno guarda piu' il loro battito**: un
// `errored` silenzioso non verrebbe notato da nessun meccanismo automatico.
//
// LA CORREZIONE, e le due cifre che la compongono:
//   · `min_uptime: 30_000` — un processo che sta su 30 s e' partito davvero, e il contatore degli
//     instabili si AZZERA. Il boot piu' lento della flotta e' agent40 (~5 s per agganciare il feed in
//     push), quindi 30 s sta comodamente sopra a tutti: un'uscita dentro quella finestra e' davvero
//     «non e' riuscito a partire», non «e' partito e poi e' successo qualcosa».
//   · `max_restarts: 500` — con i `restart_delay` gia' presenti (5-60 s, DELIBERATI e NON toccati qui)
//     diventano da ~42 minuti (dashboard, 5 s) a ~8 ore (agent24, 60 s) di tentativi prima di
//     arrendersi, contro i 5 minuti di adesso. E per esaurirli serve un crash loop VERO: qualunque
//     avvio che regga 30 s riporta il contatore a zero.
//
// PERCHE' QUI E NON IN DIECI BLOCCHI. La stessa decisione scritta dieci volte e' il reperto che il
// rilevatore D1 dell'audit cerca, e la divergenza qui vorrebbe dire «un processo critico ha una
// politica di riavvio diversa dagli altri e nessuno se n'e' accorto». Un punto solo, e un test
// (`lib/safety/riavvio-robusto.test.js`) che lo verifica leggendo il modulo.
//
// COSA NON TOCCA: `restart_delay` (per-agente, deciso caso per caso — agent24 ha 60 s per non
// martellare Gamma), `max_memory_restart`, `autostart`, e i processi FUORI dall'elenco. In
// particolare **agent44-audit-scoperta resta com'e'**: `autorestart:false` + `max_restarts:3` +
// `cron_restart` sono la sua politica giusta (§3), e applicargli questa lo trasformerebbe in un
// processo sempre vivo, che e' l'opposto di cio' che e'.
//
// ⚠ QUANDO DIVENTA EFFETTIVA. pm2 tiene la propria copia in memoria della descrizione del processo:
// un `pm2 restart <nome>` NON rilegge questo file. Serve `pm2 restart agents/ecosystem.config.js
// --only <nome>`. Finche' non lo si fa per un processo, quel processo gira con la politica vecchia.
const RIAVVIO_ROBUSTO = Object.freeze({
  autorestart: true,     // gia' il difetto di pm2, ma dichiarato: un difetto non e' una decisione
  min_uptime:  30_000,
  max_restarts: 500,
});

// I processi il cui `errored` silenzioso ha una conseguenza. `agent44-audit-scoperta` non c'e' per
// costruzione (vedi sopra), e nemmeno i trenta fermati dalla riduzione all'insieme minimo.
const PROCESSI_CRITICI = Object.freeze([
  'agent24-liquidity-rewards',   // il board: senza, il piano invecchia e il trigger smette di piazzare
  'agent27-news-guard',
  'agent34-clob-ws',             // i book: senza, ogni mercato diventa cieco e gli ordini si ritirano
  'agent38-tape-watchdog',
  'agent40-manual-reprice',      // riprezzo, uscita, merge: l'unico che gestisce le posizioni aperte
  'agent41-realloc-scheduler',   // l'unico che puo' piazzare da solo
  'agent42-watch-makers',
  'agent43-guardian',            // l'unico che sorveglia le perdite
  'agent-monitor',
  'dashboard',
]);

for (const app of module.exports.apps) {
  if (PROCESSI_CRITICI.includes(app.name)) Object.assign(app, RIAVVIO_ROBUSTO);
}

module.exports.RIAVVIO_ROBUSTO = RIAVVIO_ROBUSTO;
module.exports.PROCESSI_CRITICI = PROCESSI_CRITICI;
