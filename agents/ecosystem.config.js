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
      // MAKER_LIVE_MIN_CAP_USD — raised 25 → 30. This cap is PER ORDER (adapter.js rejects any single
      // postOrder above it), not a total. At min_incentive_size 50 the NO leg is 50 × ~0.534 ≈ $26.70,
      // which a $25 cap would have rejected outright — leaving a one-sided book that earns nothing. $30
      // is the smallest round number that admits both legs while still bounding a single order to well
      // under a third of the deposited collateral. Total at rest is ~$50 of the 100 pUSD.
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
      env:           { NODE_ENV: 'production', HOME: '/root', ADMIN_ACCESS_SECRET: process.env.ADMIN_ACCESS_SECRET, MAKER_MODE: 'live-min', MAKER_PLACEMENT: 'send', MAKER_FUNDING_APPROVED: 'true', MAKER_FUNDER_ADDRESS: '0x4C81F19a436e8174f1f3b07d7c0169150Fbdbdee', MAKER_SIGNATURE_TYPE: '3', MAKER_LIVE_MIN_MARKET: '0x12dc2b61723b2a54fc1947a307389b5f32038e7a29a0e936ad1fe410b969d06a', MAKER_LIVE_MIN_CAP_USD: '30', MAKER_ORDER_TTL_SECONDS: '180' },
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
      // Small footprint: two small JSON reads per cycle plus a getOpenOrders per enabled market.
      // (Named 40: slots 36-39 are book-velocity, maker-watchdog, tape-watchdog, net-rerun.)
      max_memory_restart: '200M',
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
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
  ],
};
