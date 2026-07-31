#!/usr/bin/env node
'use strict';
// scripts/maker-multimarket-selfcheck.js — proves the MULTI-MARKET unblocking, gate by gate.
//
// WHAT CHANGED AND WHAT HAD TO STAY. live-min used to be bound to ONE pinned market
// (MAKER_LIVE_MIN_MARKET); it is now bound to the operator's ENABLED LIST (cfg.enabledMarketIds) plus that
// pin. The safety property was never "exactly one market" — it was "only markets a human deliberately
// enabled, named in advance". This file asserts that the new bound still is that, in every direction it
// can fail: an empty list refuses, an unknown marketId refuses, a market NOT on the list refuses, and an
// unreadable list counts as empty rather than as unrestricted.
//
// It also exhausts the second half of the change: an order's GTD window is no longer a constant. It is
// bounded by the market's OWN remaining life, and under the threshold no order is placed at all — the
// difference between a 92-day market (Harry Kane, the historical pin) and a 5-minute one (Bitcoin Up or
// Down) is exactly the case the old constant got wrong.
//
// NOTHING HERE CAN PLACE AN ORDER. Every adapter built below is handed credential and signer providers
// that THROW, so any path that reached signing would fail loudly rather than sign; the assertions are all
// on refusals that happen before that point. The catalog/enable tests write to a TEMP directory, never to
// data/. The only network use is READ-ONLY Gamma lookups (skipped with --offline).
//
//   node scripts/maker-multimarket-selfcheck.js            # includes the live venue reads
//   node scripts/maker-multimarket-selfcheck.js --offline  # pure arithmetic + local state only

const fs = require('fs');
const os = require('os');
const path = require('path');

const OFFLINE = process.argv.includes('--offline');

let passed = 0; let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}`); }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 74 - t.length))}`); }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maker-multimarket-'));
const tmp = (f) => path.join(tmpDir, f);

// The two REAL markets the change is about: the historical pin (resolves in months) and a genuinely
// short-dated one. KANE is asserted against the repo's own board data; the short market is looked up live.
const KANE = '0x12dc2b61723b2a54fc1947a307389b5f32038e7a29a0e936ad1fe410b969d06a';
const OTHER = '0xcd2640464754b9a894ffec98ac11554fdd507ea89ca01237eabb3a6de4a606e6'; // a real, DIFFERENT market
const NOT_ENABLED = '0x' + 'ab'.repeat(32);

const { evaluateLiveMinMarketGate, createMakerAdapter } = require('../lib/venues/polymarket-clob-maker/adapter');
const { resolveMarketWindow, marketWindowFor, readMarketCloseMs, minMinutesToClose, MIN_SAFE_MINUTES, GTD_FRACTION } = require('../lib/maker/market-clock');
const { upsertMarket, readMarketCatalog, missingFields } = require('../lib/maker/market-catalog');
const { rewardLabelFor, NO_REWARD_LABEL } = require('../lib/maker/market-search');
const { resolveManualTtlSeconds } = require('../lib/maker/manual-order');
const { RESTING_GTD_SECONDS, REFRESH_MARGIN_SECONDS } = require('../lib/maker/auto-reprice-config');

const thrower = async () => { throw new Error('selfcheck: no credentials/keys may be loaded here'); };
// A permissive safety layer, exactly as maker-selfcheck.js builds one: it must not be the thing refusing,
// or the market-gate assertions below would pass for the wrong reason.
function permissiveSafety() {
  const EA = require('../lib/safety/execution-audit');
  const auditFile = tmp('exec-audit.jsonl');
  return {
    checkKill: () => ({ killed: false, gate: null, scope: null }),
    evaluateForOrder: () => ({ venueAllowed: true, limits: { allow: true }, clampEvents: [] }),
    recordIntent: (i) => EA.recordIntent(i, { auditFile }),
    recordOutcome: (o) => EA.recordOutcome(o, { auditFile }),
    deriveIdempotencyKey: EA.deriveIdempotencyKey,
    setUserKill: () => {},
  };
}

// ══ 1. THE ALLOWLIST GATE (pure) ══════════════════════════════════════════════════════════════════════
section('1. live-min market allowlist — pure gate');
{
  const list = [KANE, OTHER];

  ok(evaluateLiveMinMarketGate({ mode: 'live-min', allowedMarketIds: list, marketId: KANE }).allow === true,
    'a market ON the enabled list is ACCEPTED (this is the unblocking)');
  ok(evaluateLiveMinMarketGate({ mode: 'live-min', allowedMarketIds: list, marketId: OTHER }).allow === true,
    'a SECOND market on the list is accepted too — the bound is a list, no longer one pinned market');
  ok(evaluateLiveMinMarketGate({ mode: 'live-min', allowedMarketIds: list, marketId: KANE.toUpperCase().replace('0X', '0x') }).allow === true,
    'the comparison stays case-insensitive (hex casing is not a mismatch)');

  const mism = evaluateLiveMinMarketGate({ mode: 'live-min', allowedMarketIds: list, marketId: NOT_ENABLED });
  ok(mism.allow === false && mism.gate === 'live-min-market-mismatch',
    'a market NOT on the list is still REFUSED — the base safety check is intact');
  ok(/NOT on the enabled list/.test(mism.reason || ''), 'the refusal names what happened, not a generic error');

  ok(evaluateLiveMinMarketGate({ mode: 'live-min', allowedMarketIds: [], marketId: KANE }).gate === 'live-min-market-unset',
    'an EMPTY list with no pin refuses everything (a restriction naming no market is not a restriction)');
  ok(evaluateLiveMinMarketGate({ mode: 'live-min', allowedMarketIds: null, liveMinMarket: '', marketId: KANE }).gate === 'live-min-market-unset',
    'an UNREADABLE list arrives as null/empty and refuses — never as "unrestricted"');
  ok(evaluateLiveMinMarketGate({ mode: 'live-min', allowedMarketIds: list, marketId: undefined }).gate === 'live-min-market-unknown',
    'an order with NO marketId is refused (a check that could not run is not a check that passed)');
  ok(evaluateLiveMinMarketGate({ mode: 'live-min', allowedMarketIds: ['  ', ''], marketId: KANE }).gate === 'live-min-market-unset',
    'whitespace-only entries are not markets');

  // Backward compatibility: the env pin still works on its own, exactly as before this change.
  ok(evaluateLiveMinMarketGate({ mode: 'live-min', liveMinMarket: KANE, allowedMarketIds: [], marketId: KANE }).allow === true,
    'the MAKER_LIVE_MIN_MARKET pin alone still admits its market (nothing that worked before stopped working)');
  ok(evaluateLiveMinMarketGate({ mode: 'live-min', liveMinMarket: KANE, allowedMarketIds: [], marketId: OTHER }).gate === 'live-min-market-mismatch',
    'the pin alone still refuses every other market');
  for (const m of ['live', 'paper', 'off']) {
    ok(evaluateLiveMinMarketGate({ mode: m, allowedMarketIds: [], marketId: NOT_ENABLED }).allow === true,
      `the gate is scoped to live-min only (mode='${m}' unaffected)`);
  }
}

// ══ 2. THE SAME GATE THROUGH A REAL ADAPTER ═══════════════════════════════════════════════════════════
section('2. live-min market allowlist — through createMakerAdapter (no creds, no key, no network)');
{
  const listed = createMakerAdapter({
    mode: 'live-min', allowedMarketIds: [KANE, OTHER], liveMinMarket: '',
    credsProvider: thrower, signerProvider: thrower, safety: permissiveSafety(),
  });
  ok(Array.isArray(listed.allowedMarketIds) && listed.allowedMarketIds.length === 2,
    'the adapter reports the markets it may touch (a readable property, not a new callable op)');
  ok(typeof listed.allowedMarketIds !== 'function',
    'and it is NOT a method: the adapter\'s callable surface stays exactly ALLOWED_OPS');

  // NOTE the size: the adapter checks its live-min NOTIONAL CAP before the market gate, so a $50 order
  // would be refused for being too big and the market-gate assertions below would pass for the wrong
  // reason. $10 is under the default $25 cap, which puts the market gate genuinely next in line.
  const spec = (marketId) => ({
    marketId, tokenId: '123', side: 'BUY', price: 0.5, size: 20, tickSize: 0.01,
    venueRules: { tick: 0.01, scoringMid: 0.5, maxSpreadCents: 4.5, minSize: 10 },
  });

  return (async () => {
    const bad = await listed.postOrder(spec(NOT_ENABLED));
    ok(bad.sent === false && bad.gate === 'live-min-market-mismatch',
      'an order on a market OUTSIDE the list is refused before any creds/key/network');

    const good = await listed.postOrder(spec(KANE));
    ok(good.gate !== 'live-min-market-mismatch' && good.gate !== 'live-min-market-unset',
      'an order on a LISTED market passes the market gate (it is then refused by a LATER gate, as designed)');
    ok(good.sent === false, 'and it still does not reach the venue in this selfcheck (no funding attestation, throwing providers)');

    const none = await listed.postOrder(spec(undefined));
    ok(none.gate === 'live-min-market-unknown', 'an order with no marketId is refused by the adapter too');

    const unpinned = createMakerAdapter({
      mode: 'live-min', allowedMarketIds: [], liveMinMarket: '',
      credsProvider: thrower, signerProvider: thrower, safety: permissiveSafety(),
    });
    const up = await unpinned.postOrder(spec(KANE));
    ok(up.gate === 'live-min-market-unset', 'an adapter with an EMPTY allowlist and no pin can place nothing at all');

    // A provider that THROWS must fail closed, not open — the one failure mode a gate cannot tolerate.
    const brokenList = createMakerAdapter({
      mode: 'live-min', liveMinMarket: '',
      allowedMarketIdsProvider: () => { throw new Error('config store on fire'); },
      credsProvider: thrower, signerProvider: thrower, safety: permissiveSafety(),
    });
    const br = await brokenList.postOrder(spec(KANE));
    ok(br.gate === 'live-min-market-unset', 'a THROWING allowlist provider refuses everything (fail closed, never "allow all")');

    await rest();
  })();
}

// ══ 3. THE MARKET CLOCK — dynamic GTD ════════════════════════════════════════════════════════════════
async function rest() {
  section('3. dynamic GTD window — pure arithmetic');
  {
    const now = 1_800_000_000_000;
    const mins = (m) => now + m * 60_000;

    const long = resolveMarketWindow({ endMs: mins(60 * 24 * 90), nowMs: now, baseTtlSeconds: RESTING_GTD_SECONDS, baseRefreshMarginSeconds: REFRESH_MARGIN_SECONDS });
    ok(long.ttlSeconds === RESTING_GTD_SECONDS && long.refreshMarginSeconds === REFRESH_MARGIN_SECONDS && long.shortened === false,
      'a LONG-dated market keeps the usual 23-min window and 3-min margin (nothing regressed)');

    const short = resolveMarketWindow({ endMs: mins(5), nowMs: now, baseTtlSeconds: RESTING_GTD_SECONDS, baseRefreshMarginSeconds: REFRESH_MARGIN_SECONDS });
    ok(short.tooClose === false && short.shortened === true, 'a 5-minute market is placeable but SHORTENED');
    ok(short.ttlSeconds === Math.floor(5 * 60 * GTD_FRACTION), `its window is ${Math.round(GTD_FRACTION * 100)}% of the remaining life (${short.ttlSeconds}s), not 1380s`);
    ok(short.ttlSeconds < 5 * 60, 'and it expires BEFORE the market closes — the whole point');
    ok(short.refreshMarginSeconds != null && short.refreshMarginSeconds < short.ttlSeconds && short.refreshMarginSeconds < REFRESH_MARGIN_SECONDS,
      'the renewal margin shrank with it (a 4.5-min order cannot be renewed "3 minutes early")');

    const mid = resolveMarketWindow({ endMs: mins(20), nowMs: now, baseTtlSeconds: RESTING_GTD_SECONDS, baseRefreshMarginSeconds: REFRESH_MARGIN_SECONDS });
    ok(mid.ttlSeconds === Math.floor(20 * 60 * GTD_FRACTION) && mid.ttlSeconds < RESTING_GTD_SECONDS,
      'a 20-minute market gets 18 minutes, not the 23 it would have been signed for before');

    const tooClose = resolveMarketWindow({ endMs: mins(4), nowMs: now, baseTtlSeconds: RESTING_GTD_SECONDS, baseRefreshMarginSeconds: REFRESH_MARGIN_SECONDS });
    ok(tooClose.tooClose === true && tooClose.gate === 'market-too-close-to-close',
      'under the threshold the answer is REFUSE, not "place something shorter"');

    const closed = resolveMarketWindow({ endMs: mins(-1), nowMs: now, baseTtlSeconds: RESTING_GTD_SECONDS });
    ok(closed.tooClose === true && closed.gate === 'market-closed', 'an already-closed market refuses with its own gate');

    const unknown = resolveMarketWindow({ endMs: null, nowMs: now, baseTtlSeconds: RESTING_GTD_SECONDS, baseRefreshMarginSeconds: REFRESH_MARGIN_SECONDS });
    ok(unknown.closeKnown === false && unknown.tooClose === false && unknown.ttlSeconds === RESTING_GTD_SECONDS,
      'an UNKNOWN close time keeps the ordinary window — unknown is not treated as imminent, and not invented either');

    ok(minMinutesToClose({ MAKER_MIN_MINUTES_TO_CLOSE: '1' }) === MIN_SAFE_MINUTES,
      `the threshold cannot be configured below the venue-derived floor (${MIN_SAFE_MINUTES} min)`);
    ok(minMinutesToClose({ MAKER_MIN_MINUTES_TO_CLOSE: '15' }) === 15, 'but it can be raised');
    const raised = resolveMarketWindow({ endMs: mins(10), nowMs: now, baseTtlSeconds: 1380, minMinutes: 15 });
    ok(raised.tooClose === true, 'and raising it refuses markets that a lower threshold would have allowed');
  }

  section('4. dynamic GTD window — the two REAL markets, through the placement path resolver');
  {
    const close = readMarketCloseMs(KANE);
    ok(close.readable === true && close.source === 'reward-board', `Harry Kane's close time is read from real data (${close.endIso})`);
    const kane = resolveManualTtlSeconds({ marketId: KANE });
    ok(kane.tooClose === false && kane.ttlSeconds === RESTING_GTD_SECONDS && kane.refreshMarginSeconds === REFRESH_MARGIN_SECONDS,
      'Harry Kane (months away): unchanged 23-min GTD renewed at 3 min — the historical behaviour is preserved exactly');

    // The same resolver, same market, but with the clock injected at a short horizon: this is the code
    // path a 5-minute Bitcoin market takes, asserted deterministically.
    const asShort = resolveManualTtlSeconds({ marketId: KANE }, { marketClockDeps: { endMs: Date.now() + 5 * 60_000 } });
    ok(asShort.tooClose === false && asShort.ttlSeconds < RESTING_GTD_SECONDS && asShort.ttlSeconds <= 270,
      `the SAME market with 5 minutes of life left gets ${asShort.ttlSeconds}s instead of 1380s`);
    ok(/market-clock/.test(asShort.source), 'and the result says WHY it was shortened (source carries market-clock)');

    const refused = resolveManualTtlSeconds({ marketId: KANE }, { marketClockDeps: { endMs: Date.now() + 2 * 60_000 } });
    ok(refused.tooClose === true && refused.gate === 'market-too-close-to-close',
      'with 2 minutes left the resolver tells the placement path to REFUSE');

    const explicitGtc = resolveManualTtlSeconds({ marketId: KANE, ttlSeconds: 0 }, { marketClockDeps: { endMs: Date.now() + 10 * 60_000 } });
    ok(explicitGtc.orderType === 'GTD' && explicitGtc.ttlSeconds > 0 && explicitGtc.ttlSeconds <= 540,
      'an explicit GTC (no expiry) on a dated market becomes a bounded GTD — nothing may outlive its market');
  }

  section('5. the hand-added market catalog (temp files — data/ untouched)');
  {
    const deps = { catalogFile: tmp('catalog.json'), catalogAuditFile: tmp('catalog-audit.jsonl') };

    const incomplete = upsertMarket({ marketId: NOT_ENABLED, question: 'senza tick' }, { by: 'selfcheck' }, deps);
    ok(incomplete.ok === false && incomplete.missing.includes('tick'),
      'a market whose venue metadata is incomplete is REFUSED at registration, naming what is missing');

    const noReward = upsertMarket({
      marketId: NOT_ENABLED, question: 'Bitcoin Up or Down - test', tokenIdYes: '1', tokenIdNo: '2',
      tick: 0.01, negRisk: false, rewardsDailyRate: null, endDate: new Date(Date.now() + 3.6e6).toISOString(), mid: 0.5,
    }, { by: 'selfcheck', reason: 'mercato senza reward' }, deps);
    ok(noReward.ok === true, 'a market with NO reward programme IS accepted — that is the point of the change');
    ok(noReward.record.hasRewards === false && noReward.record.rewardsDailyRate === null,
      'and it is recorded as reward-less: null, never coerced to 0');
    ok(rewardLabelFor(noReward.record) === NO_REWARD_LABEL,
      `the UI label for it is the warning one ("${NO_REWARD_LABEL}")`);
    ok(rewardLabelFor({ hasRewards: true, rewardsDailyRate: 125 }) === 'reward 125$/g',
      'a market WITH a pot is labelled with the pot instead');

    const back = readMarketCatalog(deps);
    ok(back.readable === true && back.markets[NOT_ENABLED.toLowerCase()], 'the record is durable (read back from disk)');
    const audit = fs.readFileSync(deps.catalogAuditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok(audit.some((a) => a.event === 'market-added' && a.marketId === NOT_ENABLED.toLowerCase()),
      'and the write is AUDITED (who/when/what), like every other critical state in this repo');
    ok(missingFields({ tokenIdYes: '1', tokenIdNo: '2', tick: 0.01, negRisk: true }).length === 0,
      'a complete record has nothing missing');

    // The catalog is what makes a hand-added market judgeable at all: the placement path can now read its
    // rules instead of refusing with rules-unreadable for a market the reward board never carried.
    const { resolveMarketRules } = require('../lib/maker/manual-order');
    const rules = resolveMarketRules(NOT_ENABLED, { books: null, norm: null, catalogRecord: noReward.record });
    ok(rules.tick === 0.01 && rules.tokenId === '1' && rules.negRisk === false && rules.rulesSource === 'manual-catalog',
      'resolveMarketRules answers for a hand-added market from the catalog (tick/token/negRisk, none of them guessed)');
    ok(rules.rewardProgramme === 'none' && rules.readable === false && rules.missing.includes('maxSpread'),
      'but a market with NO published reward band still fails closed at the band guard — and now SAYS so ("nessun programma reward") instead of a bare "rules unreadable"');
  }

  section('6. the enabled list is the SAME durable, audited write the panel already used');
  {
    const { setAutoReprice, readAutoRepriceConfig } = require('../lib/maker/auto-reprice-config');
    const deps = { configFile: tmp('reprice.json'), autoAuditFile: tmp('reprice-audit.jsonl') };

    setAutoReprice({ scope: 'global', enabled: true, by: 'selfcheck', reason: 'master' }, deps);
    setAutoReprice({ scope: 'market', marketId: KANE, enabled: true, by: 'selfcheck', reason: 'pin storico' }, deps);
    setAutoReprice({ scope: 'market', marketId: OTHER, enabled: true, by: 'selfcheck', reason: 'secondo mercato' }, deps);
    const cfg = readAutoRepriceConfig(deps);
    ok(cfg.enabledMarketIds.length === 2 && cfg.enabledMarketIds.includes(KANE.toLowerCase()) && cfg.enabledMarketIds.includes(OTHER.toLowerCase()),
      'two markets can be enabled at once — cfg.enabledMarketIds is a list and always was');

    // The gate reads exactly this list: enable → accepted, disable → refused again, no restart in between.
    ok(evaluateLiveMinMarketGate({ mode: 'live-min', allowedMarketIds: cfg.enabledMarketIds, marketId: OTHER }).allow === true,
      'the gate accepts the newly enabled market straight from the file the panel writes');
    setAutoReprice({ scope: 'market', marketId: OTHER, enabled: false, by: 'selfcheck', reason: 'disabilitato' }, deps);
    const after = readAutoRepriceConfig(deps);
    ok(evaluateLiveMinMarketGate({ mode: 'live-min', allowedMarketIds: after.enabledMarketIds, marketId: OTHER }).gate === 'live-min-market-mismatch',
      'and disabling it makes the gate refuse again — the control binds in both directions');

    const audit = fs.readFileSync(deps.autoAuditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok(audit.filter((a) => a.marketId === OTHER.toLowerCase()).length === 2,
      'every flip is audited (enable + disable), so "who enabled this market" is answerable');
  }

  section('7. the band-exit watcher stands off a market that is about to close');
  {
    const AR = require('../lib/maker/auto-reprice');
    const { setAutoReprice } = require('../lib/maker/auto-reprice-config');
    const cfgDeps = { configFile: tmp('w-reprice.json'), autoStateFile: tmp('w-state.json'), autoAuditFile: tmp('w-audit.jsonl') };
    setAutoReprice({ scope: 'global', enabled: true, by: 'selfcheck' }, cfgDeps);
    setAutoReprice({ scope: 'market', marketId: KANE, enabled: true, by: 'selfcheck' }, cfgDeps);

    let listed = 0; const replaced = [];
    const baseDeps = {
      configDeps: cfgDeps,
      killStatus: () => ({ effectivelyKilled: false, readable: true }),
      isManual: () => ({ manual: true, readable: true }),
      resolveRules: () => ({ readable: true, tick: 0.01, mid: 0.5, maxSpreadCents: 4.5, minSize: 10, bandRadiusCents: 2.25, tokenId: '1', tokenIdNo: '2' }),
      listOrders: async () => { listed++; return { ok: true, simulated: false, count: 0, orders: [] }; },
      replaceOrder: async (s) => { replaced.push(s); return { ok: true }; },
      audit: () => {},
    };

    const closing = await AR.runAutoRepriceCycle({ ...baseDeps, marketWindow: () => ({ tooClose: true, gate: 'market-too-close-to-close', reason: 'mancano 2.0 min alla chiusura' }) });
    const cm = closing.markets.find((x) => x.marketId === KANE.toLowerCase());
    ok(cm && cm.gate === 'market-too-close-to-close', 'the watcher skips a market inside its final minutes, naming the gate');
    ok(listed === 0, 'and it does so BEFORE any venue read — no cancel attempt, no refusal loop every 5s for the whole tail of the market');
    ok(replaced.length === 0, 'nothing is renewed: with no renewal the venue\'s own GTD retires the resting orders, which is the wanted behaviour at the close');

    const healthy = await AR.runAutoRepriceCycle({ ...baseDeps, marketWindow: () => ({ tooClose: false, gate: null, reason: 'lontano dalla chiusura' }) });
    const hm = healthy.markets.find((x) => x.marketId === KANE.toLowerCase());
    ok(listed === 1 && hm && hm.gate !== 'market-too-close-to-close',
      'a market NOT near its close is watched exactly as before (the stand-off is scoped, not a new blanket refusal)');
  }

  section('8. a market enabled BY HAND is a market agent34 actually subscribes to');
  {
    // THE BUG THIS PINS DOWN. agent34 used to subscribe to the reward board only, so a market added from
    // the Allocazione tab — typically one with no reward programme, which agent24 therefore never fetches
    // — was never on the live feed. Its price in the panel was the snapshot taken when it was added
    // (midSource 'manual-catalog'), frozen; and lib/maker/auto-reprice refuses outright to move a real
    // order on a mid that is not agent34's live book. A market we let the operator quote on has to be a
    // market we watch. Everything below runs on injected deps: no network, no writes to data/.
    const A34 = require('../agents/agent34-clob-ws');
    const BTC = '0x' + 'cd'.repeat(32);   // stands in for the hand-added Bitcoin Up/Down market
    const depsCat = { catalogFile: tmp('a34-catalog.json'), catalogAuditFile: tmp('a34-catalog-audit.jsonl') };
    const depsCfg = { configFile: tmp('a34-reprice.json'), autoAuditFile: tmp('a34-reprice-audit.jsonl') };
    const { setAutoReprice } = require('../lib/maker/auto-reprice-config');
    upsertMarket({
      marketId: BTC, question: 'Bitcoin Up or Down - test', tokenIdYes: '900', tokenIdNo: '901',
      tick: 0.01, negRisk: false, rewardsDailyRate: null, mid: 0.5,
    }, { by: 'selfcheck' }, depsCat);
    setAutoReprice({ scope: 'global', enabled: true, by: 'selfcheck' }, depsCfg);
    setAutoReprice({ scope: 'market', marketId: KANE, enabled: true, by: 'selfcheck' }, depsCfg);
    setAutoReprice({ scope: 'market', marketId: BTC, enabled: true, by: 'selfcheck' }, depsCfg);

    const ids = A34.readOperatorEnabledIds(depsCfg);
    ok(ids.includes(KANE.toLowerCase()) && ids.includes(BTC.toLowerCase()),
      'agent34 reads the operator\'s enabled markets from the SAME file the panel writes and the live-min gate reads');

    // A board of 60 markets (the reward cap), Kane among them — exactly today's production shape.
    const board = { markets: [] };
    for (let i = 0; i < 60; i++) {
      const isKane = i === 29;
      board.markets.push({
        conditionId: isKane ? KANE : `0x${String(i).padStart(64, '0')}`,
        tokenId: `${1000 + i}`, tokenIdNo: `${2000 + i}`,
        rewardsMinSize: 50, rewardsMaxSpread: 4.5, tickSize: 0.001,
        rewardsDailyRate: isKane ? 126 : (i % 7) + 1,
        question: isKane ? 'Will Harry Kane win the 2026 Ballon d\'Or?' : `board ${i}`,
      });
    }
    const desired = A34.collectDesiredMarkets({ watchlist: board });
    ok(desired.size === 60 && desired.has(KANE), 'the reward board is collected exactly as before: 60 markets, cap unchanged, Kane included');

    const noNet = { resolveTokens: async () => { throw new Error('selfcheck: no network here'); } };
    await A34.unionOperatorMarkets(desired, { ...depsCat, ...depsCfg, ...noNet });
    ok(desired.size === 61, 'the hand-added market is UNIONED in — 60 board + 1 operator, not 60');
    const btc = desired.get(BTC.toLowerCase());
    ok(!!btc && btc.tokenId === '900' && btc.tokenIdNo === '901',
      'its two token ids come from the durable catalog the panel wrote — no network, nothing guessed');
    ok(btc.minSize === null && btc.maxSpread === null,
      'a market with NO reward programme keeps null min-size and null band — never a fabricated 1 that would satisfy a gate the venue never published');
    ok(btc.source === 'operator-enabled' && btc.operatorEnabled === true, 'and the row says WHY it is subscribed');

    // Kane is on the board AND enabled by hand. That must be ONE subscription, flagged — never two.
    const kaneMeta = desired.get(KANE);
    ok(kaneMeta.operatorEnabled === true && kaneMeta.source === 'reward-board' && kaneMeta.tokenId === '1029',
      'a market that is BOTH on the board and hand-enabled is subscribed ONCE, keeping its board metadata, just flagged');
    ok([...desired.keys()].filter((k) => k.toLowerCase() === KANE.toLowerCase()).length === 1,
      'no duplicate subscription for it (dedup is case-insensitive on the conditionId)');

    // PRECEDENCE AT THE CAP: a market the operator chose by hand never loses to a weak reward market.
    const full = new Map();
    for (let i = 0; i < A34.TOTAL_MARKET_CAP; i++) {
      full.set(`0x${String(i).padStart(64, 'f')}`, { conditionId: `0x${String(i).padStart(64, 'f')}`, tokenId: `t${i}`, tokenIdNo: `n${i}`, source: 'reward-board', rewardsDailyRate: i + 1, minSize: 50, maxSpread: 4.5 });
    }
    await A34.unionOperatorMarkets(full, { ...depsCat, ...depsCfg, ...noNet, operatorIds: [BTC.toLowerCase()] });
    ok(full.size === A34.TOTAL_MARKET_CAP && full.has(BTC.toLowerCase()),
      `at the total cap (${A34.TOTAL_MARKET_CAP} markets) the hand-added market still gets in — it is not the one dropped`);
    ok(!full.has(`0x${String(0).padStart(64, 'f')}`) && A34.operatorLaneState().evicted.length === 1,
      'what gave way is the WEAKEST reward market (lowest $/day), and the eviction is recorded, not silent');

    // …and when there is genuinely nothing left to give up, the drop is LOUD, never silent.
    const allMine = new Map();
    for (let i = 0; i < A34.TOTAL_MARKET_CAP; i++) {
      const k = `0x${String(i).padStart(64, 'e')}`;
      allMine.set(k, { conditionId: k, tokenId: `t${i}`, tokenIdNo: `n${i}`, source: 'operator-enabled', operatorEnabled: true, rewardsDailyRate: null, minSize: null, maxSpread: null });
    }
    await A34.unionOperatorMarkets(allMine, { ...depsCat, ...depsCfg, ...noNet, operatorIds: [BTC.toLowerCase()] });
    ok(!allMine.has(BTC.toLowerCase()) && A34.operatorLaneState().dropped.includes(BTC.toLowerCase()),
      'with nothing evictable the market is reported as DROPPED (feed.operatorDropped) instead of being silently missing');

    // THE POINT OF THE WHOLE THING: with agent34 subscribed, the panel's mid is LIVE, and the venue rules
    // the catalog holds are still there — the live book carries a price, never a tick or a negRisk flag.
    const { resolveMarketRules } = require('../lib/maker/manual-order');
    const catalogRec = require('../lib/maker/market-catalog').readMarketRecord(BTC, depsCat);
    const before = resolveMarketRules(BTC, { books: null, norm: null, catalogRecord: catalogRec });
    ok(before.midSource === 'manual-catalog', 'BEFORE the subscription the panel showed a snapshot mid (midSource manual-catalog) — the behaviour that is being fixed');
    const liveBooks = { markets: { [BTC.toLowerCase()]: { mid: 0.63, ageMs: 1200, live: true, tokenId: '900', tokenIdNo: '901', minSize: null, maxSpread: null } } };
    const after = resolveMarketRules(BTC, { books: liveBooks, norm: null, catalogRecord: catalogRec });
    ok(after.midSource === 'live-book' && after.mid === 0.63 && after.midAgeSec === 1,
      'AFTER it, the same market reads midSource live-book with the live mid and its real age');
    ok(after.tick === 0.01 && after.negRisk === false && after.tokenId === '900' && after.rulesSource === 'live-book+manual-catalog',
      'and the catalog rules SURVIVE the live book: tick/negRisk/tokens still there, both sources named');
    ok(after.rewardProgramme === 'none',
      'the "no reward programme" explanation survives too — it is why the band guard refuses, and it must not degrade to a bare "rules unreadable"');

    // agent40 refuses to move a real order on a second-hand mid. That refusal is exactly what a frozen
    // manual-catalog mid triggered; with the subscription it no longer fires.
    const { decideReprice } = require('../lib/maker/auto-reprice');
    const { loadAutoRepriceTuning } = require('../lib/maker/auto-reprice-config');
    // The REAL production tuning (requireLiveBook defaults true) — asserting against a hand-made {} would
    // silently disable the very gate under test.
    const tuning = loadAutoRepriceTuning({});
    ok(tuning.requireLiveBook === true, 'the production tuning does require agent34\'s live book by default');
    const order = { price: 0.62, size: 10, book: 'yes' };
    const beforeRules = { ...before, readable: true, maxSpreadCents: 4.5, minSize: 10, tick: 0.01 };
    const afterRules = { ...after, readable: true, maxSpreadCents: 4.5, minSize: 10, tick: 0.01 };
    ok(decideReprice({ order, rules: beforeRules, config: tuning }).gate === 'mid-not-live',
      'agent40 on the OLD frozen mid: skip / mid-not-live — the automatism was blind on hand-added markets');
    ok(decideReprice({ order, rules: afterRules, config: tuning }).gate !== 'mid-not-live',
      'agent40 on the LIVE mid: that refusal is gone, the order is judged against the current book');

    // NON-REGRESSION for the board lane: Kane is answered by its board row exactly as before.
    const kaneNorm = { markets: [{ marketId: KANE, title: 'Kane', midpoint: 0.5, tickSize: 0.001, maxSpread: 4.5, minSize: 50, tokenId: '1029', tokenIdNo: '2029', negRisk: false, updatedAt: new Date().toISOString() }] };
    const kaneBooks = { markets: { [KANE]: { mid: 0.52, ageMs: 3000, live: true, minSize: 50, maxSpread: 4.5, yes: { bestBid: 0.51, bestAsk: 0.53 } } } };
    const kaneRules = resolveMarketRules(KANE, { books: kaneBooks, norm: kaneNorm });
    ok(kaneRules.readable === true && kaneRules.midSource === 'live-book' && kaneRules.rulesSource === 'live-book' && kaneRules.mid === 0.52,
      'a reward-board market is untouched by all of this: readable, live-book mid, rulesSource live-book');
  }

  if (!OFFLINE) {
    section('9. LIVE venue read — the search really is unfiltered, and a real short market shortens the window');
    const { searchMarkets, fetchMarketByConditionId } = require('../lib/maker/market-search');

    const res = await searchMarkets({ q: 'bitcoin up or down', limit: 12 });
    ok(res.ok === true, `Gamma search answered (${res.count} mercati)`);
    ok(res.withoutRewards > 0, `markets with NO reward programme are RETURNED, not filtered out (${res.withoutRewards} of ${res.count})`);
    ok(res.markets.every((m) => m.tick != null || m.closed), 'every returned row carries a tick (or is closed)');
    ok(res.markets.every((m) => Object.prototype.hasOwnProperty.call(m, 'spreadCents') && Object.prototype.hasOwnProperty.call(m, 'rewardsDailyRate')),
      'every row carries the three decision fields: reward rate, spread, tick');

    const soon = res.markets.filter((m) => m.minutesToClose != null && m.minutesToClose > 0).sort((a, b) => a.minutesToClose - b.minutesToClose)[0];
    if (soon) {
      const w = resolveMarketWindow({ endMs: Date.now() + soon.minutesToClose * 60_000, baseTtlSeconds: RESTING_GTD_SECONDS, baseRefreshMarginSeconds: REFRESH_MARGIN_SECONDS });
      console.log(`     mercato reale più vicino: «${(soon.question || '').slice(0, 46)}» fra ${soon.minutesToClose} min · reward ${soon.rewardsDailyRate ?? 'nessuno'} · finestra ${w.tooClose ? 'RIFIUTATA (' + w.gate + ')' : w.ttlSeconds + 's'}`);
      ok(w.tooClose || w.ttlSeconds <= Math.floor(soon.minutesToClose * 60 * GTD_FRACTION) + 1,
        'a REAL short-dated market gets a window inside its own remaining life (or is refused outright)');
    } else {
      console.log('     (nessun mercato breve aperto in questo momento — asserzione saltata)');
    }

    const kane = await fetchMarketByConditionId(KANE);
    ok(kane.ok === true && kane.market.hasRewards === true && kane.market.tick != null,
      'the same lookup on Harry Kane returns a reward market with its pot, spread and tick');
  } else {
    console.log('\n(--offline: letture live del venue saltate)');
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} ok, ${failed} failed`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(failed === 0 ? 0 : 1);
}
