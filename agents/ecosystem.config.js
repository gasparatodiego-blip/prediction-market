module.exports = {
  apps: [
    {
      name:          'agent14-rebalancer',
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
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent-data-collector',
      script:        './agents/agent-data-collector.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent10-binance',
      script:        './agents/agent10-binance.js',
      cwd:           '/root/prediction-market',
      restart_delay: 5000,
      max_restarts:  20,
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent-master',
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
      script:        './agents/agent-marketmaker.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent-liquidity',
      script:        './agents/agent-liquidity.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent2-fetcher',
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
      script:        './agents/agent3-matcher-politics.js',
      cwd:           '/root/prediction-market',
      restart_delay: 30000,
      max_restarts:  10,
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent4-matcher-other',
      script:        './agents/agent4-matcher-other.js',
      cwd:           '/root/prediction-market',
      restart_delay: 30000,
      max_restarts:  10,
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent5-calculator',
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
      env:           { NODE_ENV: 'production', HOME: '/root', MAKER_MODE: 'off', MAKER_ORDER_TTL_SECONDS: '60' },
    },
    {
      name:          'agent36-book-velocity',
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
  ],
};
