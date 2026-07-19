#!/usr/bin/env node
/**
 * Cash & carry HOLD-TO-EXPIRY backtest on real persisted basis history.
 *
 * Strategy under test: buy spot at the executable ask, short the dated future at
 * the executable bid, hold to contract expiry, let the future cash-settle at index
 * and sell the spot. The edge is structural: the basis converges to zero at expiry
 * by settlement, known in advance.
 *
 * ── THE PAYOFF ALGEBRA (why settlement price is a VERIFIER, not a P&L input) ──
 *   Entry:  buy 1 unit spot @ spotAsk_0     (capital deployed = spotAsk_0)
 *           short 1 unit future @ futureBid_0
 *   Expiry: future cash-settles at index S_T; spot sold at that same S_T.
 *
 *     spot leg   = S_T - spotAsk_0
 *     short leg  = futureBid_0 - S_T
 *     total      = futureBid_0 - spotAsk_0        <- S_T CANCELS
 *     return     = (futureBid_0 - spotAsk_0) / spotAsk_0 = executableBasisPct
 *     net        = executableBasisPct - feePct
 *
 * So the hold-to-expiry return is LOCKED AT ENTRY. Backfilled settlement does not
 * move the number; it VERIFIES that convergence actually occurred (future settled
 * to index, spot sellable at that index). We still backfill it, because an
 * unverified structural claim is just a claim.
 *
 * ── WHAT THIS SCRIPT WILL AND WILL NOT CLAIM ──
 *   REALIZED  — only for contracts whose expiry has PASSED and whose settlement we
 *               sourced. Nothing else is ever labelled realized.
 *   LOCKED    — expiry still in the future: return is contractually locked at entry
 *               by the algebra above, but NOT yet realized. Carries settlement risk
 *               (venue solvency, delivery mechanics) and, for coin-margined
 *               contracts, USD-denomination risk.
 *   MARK      — compression-to-date, purely unrealized mark-to-market.
 *
 * Fees: FEES[venue] in agent19 is already the FULL round-trip hold-to-expiry cost
 * (spot open + futures taker + delivery + spot close), taker on every leg — the
 * honest worst case. Maker entry would improve it; spot-maker fills are not
 * priceable from this data, so we do not model them.
 *
 * Borrow cost: structurally ABSENT, not omitted. Long spot is bought outright with
 * cash; nothing is borrowed. The true cost of that cash is its opportunity cost,
 * which is exactly the risk-free comparison in the capital-adjusted section.
 *
 * Read-only on the history tree. Writes only data/basis-settlements.json and
 * data/basis-hold-to-expiry.json.
 */

const fs = require('fs');
const path = require('path');
const { rlGet } = require('../lib/rateLimitedFetch');

const HISTORY_DIR = '/root/prediction-market/data/history/basis';
const OUT_DIR     = path.join(__dirname, '..', 'data');
const DERIBIT_RL  = { host: 'deribit.com', minIntervalMs: 300 };

// Deribit publishes daily delivery (settlement) prices per index. This is the
// canonical settlement source for its dated futures. Only btc/eth indices exist;
// anything else has no Deribit settlement and is reported UNSUPPORTED_INDEX
// rather than guessed at.
const DERIBIT_INDEX = { BTC: 'btc_usd', ETH: 'eth_usd' };

const RISK_FREE_PCT   = 4.0;   // ~risk-free benchmark, %/yr
const FUNDING_BEST_PCT = 2.79; // best-case funding lane result, %/yr, for comparison
const APY_CAP_PCT     = 200;   // honest-engine: above this, label run-rate not guaranteed

// ── load history ────────────────────────────────────────────────────────────
function loadHistory() {
  const files = fs.readdirSync(HISTORY_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const snaps = [];
  for (const f of files) {
    const arr = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8'));
    for (const s of arr) if (Array.isArray(s.rows)) snaps.push(s);
  }
  snaps.sort((a, b) => a.t - b.t);
  return { files, snaps };
}

// Collapse snapshots into one record per contract: entry = FIRST time we saw it.
function buildContracts(snaps) {
  const map = new Map();
  for (const s of snaps) {
    for (const r of s.rows) {
      if (!r.expiry || !(r.spotAsk > 0) || !(r.futureBid > 0)) continue;
      const key = `${r.venue}|${r.instrument}`;
      let c = map.get(key);
      if (!c) {
        c = {
          key, coin: r.coin, venue: r.venue, instrument: r.instrument,
          expiry: r.expiry, coinMargined: !!r.coinMargined,
          entry: null, last: null, snapshots: 0, maxCapacityUsd: 0, everThin: false,
        };
        map.set(key, c);
      }
      const obs = {
        t: s.t, iso: s.iso, spotAsk: r.spotAsk, spotBid: r.spotBid,
        futureBid: r.futureBid, futureAsk: r.futureAsk,
        basisPct: r.executableBasisPct, daysToExpiry: r.daysToExpiry,
        feePct: r.feePct, capacityUsd: r.capacityUsd || 0, tier: r.tier,
      };
      c.snapshots++;
      c.maxCapacityUsd = Math.max(c.maxCapacityUsd, obs.capacityUsd);
      if (r.thinFlag) c.everThin = true;
      if (!c.entry || obs.t < c.entry.t) c.entry = obs;
      if (!c.last  || obs.t > c.last.t)  c.last  = obs;
    }
  }
  return [...map.values()];
}

// ── settlement backfill ─────────────────────────────────────────────────────
async function fetchDeliveryPrices(indexName, needBefore) {
  // Paginate back until we cover the oldest expiry we care about, or run out.
  const out = new Map();
  const PAGE = 100;
  for (let offset = 0; offset < 1000; offset += PAGE) {
    const url = `https://www.deribit.com/api/v2/public/get_delivery_prices`
              + `?index_name=${indexName}&offset=${offset}&count=${PAGE}`;
    let res;
    try { res = await rlGet(url, DERIBIT_RL); } catch (e) { break; }
    const data = res && res.data && res.data.result && res.data.result.data;
    if (!Array.isArray(data) || !data.length) break;
    let oldest = null;
    for (const d of data) {
      if (d && d.date && Number.isFinite(d.delivery_price)) {
        out.set(d.date, d.delivery_price);
        oldest = d.date;
      }
    }
    if (oldest && oldest <= needBefore) break;
  }
  return out;
}

async function backfillSettlements(contracts, nowMs) {
  const expiries = [...new Set(contracts.map(c => c.expiry))].sort();
  const oldest = expiries[0];

  const coins = [...new Set(contracts.map(c => c.coin))];
  const series = {};
  for (const coin of coins) {
    const idx = DERIBIT_INDEX[coin];
    if (!idx) continue;
    series[coin] = await fetchDeliveryPrices(idx, oldest);
  }

  const settlements = {};
  for (const exp of expiries) {
    const expiredAt = Date.parse(`${exp}T08:00:00Z`); // Deribit/Binance/OKX dated futures settle 08:00 UTC
    const hasExpired = expiredAt < nowMs;
    for (const coin of coins) {
      const id = `${coin}|${exp}`;
      if (!hasExpired) {
        settlements[id] = {
          coin, expiry: exp, settlement: null, status: 'UNKNOWN',
          reason: 'NOT_YET_EXPIRED',
          detail: `Expiry ${exp} is in the future as of ${new Date(nowMs).toISOString()}. No settlement exists to source.`,
        };
        continue;
      }
      const idx = DERIBIT_INDEX[coin];
      if (!idx) {
        settlements[id] = {
          coin, expiry: exp, settlement: null, status: 'UNKNOWN',
          reason: 'UNSUPPORTED_INDEX',
          detail: `Deribit publishes delivery prices for btc_usd/eth_usd only; no public index for ${coin}.`,
        };
        continue;
      }
      const px = series[coin] && series[coin].get(exp);
      settlements[id] = Number.isFinite(px)
        ? { coin, expiry: exp, settlement: px, status: 'OK',
            source: 'deribit.public.get_delivery_prices',
            method: 'DERIBIT_DELIVERY_PRICE',
            detail: `Deribit published delivery price for index ${idx} on ${exp}.` }
        : { coin, expiry: exp, settlement: null, status: 'UNKNOWN',
            reason: 'NO_DELIVERY_PRICE_PUBLISHED',
            detail: `Expiry ${exp} has passed but Deribit returned no delivery price for ${idx}.` };
    }
  }
  return { settlements, seriesSizes: Object.fromEntries(Object.entries(series).map(([k, v]) => [k, v.size])) };
}

// ── backtest ────────────────────────────────────────────────────────────────
function annualize(netPct, days) {
  if (!(days > 0)) return null;
  return netPct * 365 / days;
}

function backtest(contracts, settlements, nowMs) {
  const results = [];
  for (const c of contracts) {
    const e = c.entry;
    const expiredAt = Date.parse(`${c.expiry}T08:00:00Z`);
    const hasExpired = expiredAt < nowMs;
    const st = settlements[`${c.coin}|${c.expiry}`];

    // Sizing: real persisted book-walk capacity. Never OI, never midpoint.
    // No capacity -> excluded, not silently sized.
    const capacity = c.maxCapacityUsd;
    const sizingOk = capacity > 0;

    // Locked-at-entry economics (see header algebra).
    const grossPct = e.basisPct;             // executable basis at entry
    const feePct   = e.feePct;               // full round-trip hold-to-expiry taker cost
    const netPct   = grossPct - feePct;
    const daysHeld = e.daysToExpiry;
    const annPct   = annualize(netPct, daysHeld);

    // Compression actually observed in the window (mark, unrealized).
    const compressionPct = e.basisPct - c.last.basisPct;
    const daysObserved   = (c.last.t - e.t) / 86_400_000;

    let status, statusNote;
    if (!sizingOk) {
      status = 'EXCLUDED';
      statusNote = 'No persisted book-walk capacity — cannot size honestly.';
    } else if (hasExpired && st && st.status === 'OK') {
      status = 'REALIZED';
      statusNote = 'Expiry passed and settlement sourced — convergence verified.';
    } else if (hasExpired) {
      status = 'EXCLUDED';
      statusNote = `Expiry passed but settlement unsourceable (${st ? st.reason : 'NO_RECORD'}).`;
    } else {
      status = 'LOCKED_NOT_REALIZED';
      statusNote = 'Expiry in the future. Return locked at entry by the payoff algebra, '
                 + 'but not realized — carries settlement and venue risk'
                 + (c.coinMargined ? ', and coin-settled so the USD return is not locked.' : '.');
    }

    results.push({
      key: c.key, coin: c.coin, venue: c.venue, instrument: c.instrument,
      expiry: c.expiry, coinMargined: c.coinMargined,
      status, statusNote,
      entryIso: e.iso, entryDaysToExpiry: daysHeld,
      entrySpotAsk: e.spotAsk, entryFutureBid: e.futureBid,
      grossBasisPct: grossPct, feePct, netBasisPct: netPct,
      annualizedPct: annPct,
      annualizedCapped: annPct != null && annPct * 100 > APY_CAP_PCT,
      settlement: st && st.status === 'OK' ? st.settlement : null,
      settlementStatus: st ? st.status : 'NO_RECORD',
      settlementMethod: st && st.method ? st.method : null,
      capacityUsd: capacity,
      snapshots: c.snapshots, everThin: c.everThin,
      observedCompressionPct: compressionPct, daysObserved,
      lastBasisPct: c.last.basisPct, lastIso: c.last.iso,
      net1k:  sizingOk ? 1000  * netPct : null,
      net10k: sizingOk ? 10000 * netPct : null,
    });
  }
  results.sort((a, b) => (b.netBasisPct || 0) - (a.netBasisPct || 0));
  return results;
}

// Peak concurrent capital: every position is opened at entry and held to its own
// expiry, so overlap is the norm. Sweep the timeline and take the max.
function peakCapital(results, perContractUsd) {
  const events = [];
  for (const r of results) {
    if (r.status === 'EXCLUDED') continue;
    events.push({ t: Date.parse(r.entryIso), d: +perContractUsd });
    events.push({ t: Date.parse(`${r.expiry}T08:00:00Z`), d: -perContractUsd });
  }
  events.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0, peak = 0;
  for (const ev of events) { cur += ev.d; peak = Math.max(peak, cur); }
  return peak;
}

(async () => {
  const nowMs = Date.now();
  const { files, snaps } = loadHistory();
  const contracts = buildContracts(snaps);

  console.log(`history: ${files.length} files, ${snaps.length} snapshots, ${contracts.length} contracts`);
  console.log(`window: ${snaps[0].iso} -> ${snaps[snaps.length - 1].iso}`);

  const { settlements, seriesSizes } = await backfillSettlements(contracts, nowMs);
  const results = backtest(contracts, settlements, nowMs);

  const realized = results.filter(r => r.status === 'REALIZED');
  const locked   = results.filter(r => r.status === 'LOCKED_NOT_REALIZED');
  const excluded = results.filter(r => r.status === 'EXCLUDED');

  const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
  const expiriesOf = a => [...new Set(a.map(r => r.expiry))];

  const aggregate = (label, arr, perUsd) => {
    if (!arr.length) return null;
    const net = sum(arr, r => perUsd * r.netBasisPct);
    const peak = peakCapital(arr, perUsd);
    // Capital-weighted annualized: total net over peak capital, scaled by the
    // mean holding period actually required to earn it.
    const meanDays = sum(arr, r => r.entryDaysToExpiry) / arr.length;
    const pctOnPeak = peak > 0 ? (net / peak) * 100 : null;
    const annOnPeak = pctOnPeak != null && meanDays > 0 ? pctOnPeak * 365 / meanDays : null;
    return {
      label, contracts: arr.length, expiries: expiriesOf(arr).length,
      perContractUsd: perUsd, totalNetUsd: net,
      wins: arr.filter(r => r.netBasisPct > 0).length,
      losses: arr.filter(r => r.netBasisPct <= 0).length,
      peakConcurrentCapitalUsd: peak, netPctOnPeakCapital: pctOnPeak,
      annualizedPctOnPeakCapital: annOnPeak, meanHoldDays: meanDays,
    };
  };

  const out = {
    generatedAt: new Date(nowMs).toISOString(),
    method: {
      strategy: 'buy spot @ executable ask, short dated future @ executable bid, hold to expiry',
      payoffAlgebra: 'P&L = futureBid_entry - spotAsk_entry; settlement price cancels out. '
                   + 'Return is locked at entry = executableBasisPct - feePct.',
      settlementRole: 'Backfilled settlement VERIFIES convergence; it is not a P&L input.',
      fees: 'FEES[venue] from agent19 — full round-trip taker (spot open + futures + delivery + spot close). Honest worst case.',
      borrowCost: 'Structurally absent: long spot is bought outright, nothing borrowed. '
                + 'Opportunity cost of the cash is the risk-free comparison.',
      sizing: 'Real persisted book-walk capacityUsd only. Never OI, never midpoint. No capacity -> EXCLUDED.',
      makerCaveat: 'Taker on every leg. Maker entry would improve returns; spot-maker fills are not priceable from this data, so not modelled.',
    },
    window: { files: files.length, snapshots: snaps.length, from: snaps[0].iso, to: snaps[snaps.length - 1].iso },
    counts: {
      total: results.length, realized: realized.length,
      lockedNotRealized: locked.length, excluded: excluded.length,
      distinctExpiries: expiriesOf(results).length,
      expiredExpiries: expiriesOf(results).filter(e => Date.parse(`${e}T08:00:00Z`) < nowMs).length,
    },
    deribitDeliveryRecordsFetched: seriesSizes,
    realizedAggregate: { at1k: aggregate('realized', realized, 1000), at10k: aggregate('realized', realized, 10000) },
    lockedAggregate:   { at1k: aggregate('locked',   locked,   1000), at10k: aggregate('locked',   locked,   10000) },
    benchmarks: { riskFreePct: RISK_FREE_PCT, fundingBestCasePct: FUNDING_BEST_PCT },
    contracts: results,
  };

  fs.writeFileSync(path.join(OUT_DIR, 'basis-settlements.json'), JSON.stringify({
    generatedAt: out.generatedAt,
    source: 'deribit public /api/v2/public/get_delivery_prices',
    method: 'DERIBIT_DELIVERY_PRICE — daily published delivery price per index; dated futures cash-settle to it at 08:00 UTC on expiry.',
    fallback: 'None applied. Where a settlement is unavailable the contract is marked UNKNOWN and EXCLUDED — never inferred.',
    unsupported: 'Deribit publishes btc_usd/eth_usd only. Other coins -> UNSUPPORTED_INDEX.',
    recordsFetched: seriesSizes,
    settlements,
  }, null, 2) + '\n');

  fs.writeFileSync(path.join(OUT_DIR, 'basis-hold-to-expiry.json'), JSON.stringify(out, null, 2) + '\n');

  // ── report ────────────────────────────────────────────────────────────────
  const pc = v => v == null ? '—' : (v * 100).toFixed(2) + '%';
  const money = v => v == null ? '—' : (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2);

  console.log(`\nsettlements: ${Object.values(settlements).filter(s => s.status === 'OK').length} OK, `
            + `${Object.values(settlements).filter(s => s.status !== 'OK').length} UNKNOWN`);
  console.log(`REALIZED ${realized.length} | LOCKED(not realized) ${locked.length} | EXCLUDED ${excluded.length}`);

  const table = (title, arr) => {
    if (!arr.length) { console.log(`\n${title}: none`); return; }
    console.log(`\n${title}`);
    console.log('VENUE            | INSTRUMENT       | EXPIRY     | days | gross  | fee    | NET    | ann%/yr | net$1k  | net$10k | cap$');
    for (const r of arr) {
      console.log([
        r.venue.padEnd(16), r.instrument.padEnd(16), r.expiry,
        String(r.entryDaysToExpiry).padStart(4),
        pc(r.grossBasisPct).padStart(6), pc(r.feePct).padStart(6), pc(r.netBasisPct).padStart(6),
        (r.annualizedPct == null ? '—' : (r.annualizedPct * 100).toFixed(2)).padStart(7),
        money(r.net1k).padStart(8), money(r.net10k).padStart(8),
        ('$' + Math.round(r.capacityUsd)).padStart(8),
      ].join(' | '));
    }
  };

  table('REALIZED (expiry passed, settlement sourced)', realized);
  table('LOCKED AT ENTRY — NOT REALIZED (expiry still in the future)', locked);
  if (excluded.length) {
    console.log('\nEXCLUDED');
    for (const r of excluded) console.log(`  ${r.venue} ${r.instrument} ${r.expiry} — ${r.statusNote}`);
  }

  const showAgg = (name, a) => {
    if (!a) { console.log(`\n${name}: no contracts`); return; }
    console.log(`\n${name} @ $${a.perContractUsd}/contract`);
    console.log(`  contracts ${a.contracts} across ${a.expiries} expiries | wins ${a.wins} losses ${a.losses}`);
    console.log(`  total net ${money(a.totalNetUsd)}`);
    console.log(`  peak concurrent capital $${a.peakConcurrentCapitalUsd.toLocaleString()}`);
    console.log(`  net on peak capital ${a.netPctOnPeakCapital == null ? '—' : a.netPctOnPeakCapital.toFixed(3) + '%'}`
              + ` over mean hold ${a.meanHoldDays.toFixed(0)}d`);
    console.log(`  ANNUALIZED ON PEAK CAPITAL ${a.annualizedPctOnPeakCapital == null ? '—' : a.annualizedPctOnPeakCapital.toFixed(2) + '%/yr'}`);
  };
  showAgg('REALIZED aggregate', out.realizedAggregate.at1k);
  showAgg('REALIZED aggregate', out.realizedAggregate.at10k);
  showAgg('LOCKED (not realized) aggregate', out.lockedAggregate.at1k);
  showAgg('LOCKED (not realized) aggregate', out.lockedAggregate.at10k);

  // Equal-weighting all 42 contracts is not how anyone would trade this: most are
  // the SAME trade duplicated across venues. The fair best case is the single best
  // contract per expiry. Report both so the strategy is judged at its ceiling.
  const bestPerExpiry = [];
  for (const exp of expiriesOf(locked)) {
    const pool = locked.filter(r => r.expiry === exp);
    bestPerExpiry.push(pool.reduce((a, b) => (b.annualizedPct > a.annualizedPct ? b : a)));
  }
  bestPerExpiry.sort((a, b) => b.annualizedPct - a.annualizedPct);
  console.log('\nBEST CONTRACT PER EXPIRY (how this would actually be traded)');
  console.log('EXPIRY     | VENUE            | INSTRUMENT       | days | NET    | ann%/yr');
  for (const r of bestPerExpiry) {
    console.log([r.expiry, r.venue.padEnd(16), r.instrument.padEnd(16),
      String(r.entryDaysToExpiry).padStart(4), pc(r.netBasisPct).padStart(6),
      (r.annualizedPct * 100).toFixed(2).padStart(7)].join(' | '));
  }
  const bestAgg1k = aggregate('best-per-expiry', bestPerExpiry, 1000);
  showAgg('BEST-PER-EXPIRY aggregate', bestAgg1k);
  const ceiling = Math.max(...locked.map(r => r.annualizedPct)) * 100;
  console.log(`\nCEILING — best single contract anywhere: ${ceiling.toFixed(2)}%/yr`);
  console.log(`  vs risk-free ${RISK_FREE_PCT}%/yr  -> ${ceiling > RISK_FREE_PCT ? 'BEATS' : 'BELOW'}`);
  console.log(`  vs funding best ${FUNDING_BEST_PCT}%/yr -> ${ceiling > FUNDING_BEST_PCT ? 'BEATS' : 'BELOW'}`);
  out.bestPerExpiry = { contracts: bestPerExpiry.map(r => r.key), aggregate: bestAgg1k, ceilingAnnualizedPct: ceiling };
  fs.writeFileSync(path.join(OUT_DIR, 'basis-hold-to-expiry.json'), JSON.stringify(out, null, 2) + '\n');

  console.log('\nwrote data/basis-settlements.json, data/basis-hold-to-expiry.json');
})();
