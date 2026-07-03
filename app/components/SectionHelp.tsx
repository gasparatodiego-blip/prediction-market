'use client';

import { useState } from 'react';

// ── Content model ─────────────────────────────────────────────────────────────

type Block =
  | { t: 'h'; s: string }
  | { t: 'p'; s: string }
  | { t: 'dl'; items: [string, string][] }
  | { t: 'ul'; items: string[] };

const CONTENT: Record<string, { title: string; blocks: Block[] }> = {

  opportunities: {
    title: 'How to use: Opportunities',
    blocks: [
      { t: 'h', s: 'What it is' },
      { t: 'p', s: 'A ranked list of live opportunities across Edgeradar\'s strategies, ordered by net return. Reference prices are public; the edge itself — spread, basis, ROI, capacity — is computed by Edgeradar, not the source platform.' },

      { t: 'h', s: 'Badge types' },
      { t: 'dl', items: [
        ['CASHABLE', 'A binary arbitrage at executable (bid/ask) prices, not midpoints. Profit is realized only if both legs fill and the market resolves as priced — fees, slippage, and partial fills can reduce or erase it.'],
        ['SIGNAL',   'Informational only. Source is a play-money or mid-price platform. Not executable — read it as a directional signal, never as a trade.'],
        ['SPORTS',   'Cross-bookmaker arb — back every outcome across books so implied probabilities sum to under 1. Margin is small and account limits apply; not risk-free.'],
        ['FUNDING',  'Delta-neutral crypto funding-rate harvest. Long the exchange paying less, short the one paying more. See Funding for detail.'],
      ]},

      { t: 'h', s: 'Reading a card' },
      { t: 'p', s: 'Legs show platform · side · price. Net $/day is the primary number — an estimate at current prices and rates, not a promise. Annualized figures are a run-rate extrapolated from today\'s spread; not guaranteed, and can look large on a small, short-lived edge. "net/yr" is after estimated fees. "max —" means orderbook depth is not verified — sizing is your call.' },

      { t: 'h', s: 'Verdicts' },
      { t: 'dl', items: [
        ['ACTIONABLE',          'Spread looks real and executable — worth a closer look before prices move.'],
        ['CAPITAL-LOCKUP-SKIP', 'Real spread, but resolution is far enough out that the annualized return is unattractive for how long the capital would be tied up.'],
        ['SIGNAL',              'Informational only, from a non-executable source. Do not trade on this alone.'],
        ['HARVEST · variable',  'Funding arb at the current rate. Variable — can flip on the next reset, not locked.'],
        ['STALE-CHECK',         'Data may be stale. Re-verify prices on the source platforms before acting.'],
      ]},

      { t: 'h', s: 'Capital & leverage control' },
      { t: 'p', s: 'Enter your capital to see per-item dollar projections: notional per leg, round-trip fees, net 30d, net/yr, and return-on-capital. APY is calculated on notional, not your capital — at 1× leverage you commit roughly 2× the per-leg notional in margin across both legs, so return-on-capital runs lower than the headline APY. Higher leverage raises return-on-capital but adds liquidation risk. Orderbook depth is not verified, so sizing is your responsibility.' },

      { t: 'h', s: 'Honesty' },
      { t: 'ul', items: [
        'Zero or few opportunities is normal — it reflects honest market conditions, not a bug.',
        'Never act on SIGNAL items. They come from non-real-money sources and are not executable.',
        'Annualized figures are a run-rate extrapolated over the resolution window, not a return you are owed.',
        'Nothing here is financial advice. Verify prices yourself before committing capital.',
      ]},
    ],
  },

  funding: {
    title: 'How to use: Funding',
    blocks: [
      { t: 'h', s: 'What it is' },
      { t: 'p', s: 'Real-time cross-exchange perpetual funding-rate spread monitor across Binance, Bybit, OKX, Gate.io, Bitget (8h resets) and Hyperliquid, dYdX (hourly resets). Every cross-venue pair is ranked by Net $/day after fees — the headline number, not a side note.' },

      { t: 'h', s: 'The trade' },
      { t: 'p', s: 'Delta-neutral: long the perp where you pay little or nothing, short where you collect the higher rate. A positive rate means shorts collect; a negative rate means longs collect. You harvest the differential — price direction does not matter, only the spread and how long it holds.' },

      { t: 'h', s: 'Reading a spread row' },
      { t: 'dl', items: [
        ['Sell side (you collect)', 'Exchange with the higher rate — short here and collect funding each interval.'],
        ['Buy side (you pay)',      'Exchange with the lower (or negative) rate — go long here.'],
        ['Net $/day · ROC',         'Primary metric. Dollar yield on your entered capital, fees already deducted, with run-rate ROC %/yr shown below it. Not guaranteed — the rate resets every 1–8h.'],
        ['Before fees',             'Gross annualized spread, no fees subtracted — for reference, not the number to trade on.'],
        ['Round-trip fees',         'Cost of 4 legs: open and close on both exchanges. Exact fee per venue is shown in-app and varies by exchange.'],
        ['Days to repay fees',      'Days at the current spread until fees are recovered. Shorter is better.'],
        ['Status',                  'HARVEST = ≤5 days to repay · CAUTION = 5–10 days · MARGINAL = >10 days.'],
        ['Green cap',               'Largest size where modeled entry+exit slippage (amortized 14 days) stays under 30% of gross yield. $0 = book too thin to enter cleanly.'],
      ]},

      { t: 'h', s: 'Caveats — read before trading' },
      { t: 'ul', items: [
        'Net $/day and ROC are on notional, not free capital. At 1× you tie up roughly 2× notional in margin across both legs.',
        'Funding is variable. It resets every 1–8h depending on venue — the rate you see now is not what you will earn on the next reset.',
        'DEX legs (Hyperliquid, dYdX) need a one-time bridge or deposit plus gas. Factor this into cost for small positions.',
        'Green cap is a slippage model, not a guarantee — confirm live depth on each exchange before sizing in.',
        'Not financial advice. Funding arb is a real strategy, but execution details vary by exchange, account type, and margin mode.',
      ]},

      { t: 'h', s: 'Rate heatmap' },
      { t: 'p', s: 'Raw funding rate per exchange per coin. Positive → shorts collect; negative → longs collect. Hyperliquid and dYdX rates are hourly; CEX rates are per 8h period. Wide divergence between two rows flags a potential spread.' },
    ],
  },

  sports: {
    title: 'How to use: Sports',
    blocks: [
      { t: 'h', s: 'What it is' },
      { t: 'p', s: 'Cross-bookmaker sports arbitrage scanner. When bookmakers price the same event so implied probabilities sum to under 1, backing every outcome across books can lock in a margin regardless of result — before fees, limits, and execution risk.' },

      { t: 'h', s: 'How surebets work' },
      { t: 'ul', items: [
        'One book offers high odds on Home, another offers high odds on Away (or Draw).',
        'Stakes are split per outcome so the payout on any result covers the total outlay plus margin.',
        'Margin % is the edge as a fraction of total stake — before account limits or odds moving against you.',
        'Odds move fast. This is a manual, dual-tab trade, not an automated one.',
      ]},

      { t: 'h', s: 'Snapshot scanning, not a live feed' },
      { t: 'p', s: 'This is a periodic snapshot scan via OddsAPI (EU/UK/US h2h), run on demand — not continuous polling. Every result must clear a 4-bookmaker minimum, a median outlier filter that drops suspiciously generous prices, and a 6% ROI plausibility cap (anything above is quarantined as implausible). Credit use is metered against a monthly budget with a safety floor; scanning stops automatically when the floor is reached. No fake data is ever shown: when offline or paused, the card shows an honest OFFLINE / PAUSED status.' },

      { t: 'h', s: 'Each row shows' },
      { t: 'ul', items: [
        'Event, league, and the bookmakers involved.',
        'Per-outcome stake split, pre-calculated to lock the margin whatever the result.',
        'Margin % — the edge as a percentage of total stake.',
        'Time to kickoff and whether the price survived outlier filtering.',
      ]},

      { t: 'h', s: 'Honesty' },
      { t: 'p', s: 'Bookmakers routinely limit or ban accounts that consistently place arb bets. Margins are small, so a delay or partial fill can turn a profit into a loss. This is a real strategy, but it needs speed, multiple funded accounts, and acceptance of account-limitation risk.' },
    ],
  },

  overview: {
    title: 'How to use: Overview',
    blocks: [
      { t: 'h', s: 'What is Edgeradar?' },
      { t: 'p', s: 'A multi-strategy arbitrage and funding-rate scanner. It surfaces live edges across prediction markets, crypto perpetuals, and sports — it does not execute trades. You decide whether to act; verifying prices and managing risk is on you.' },

      { t: 'h', s: 'Where to start' },
      { t: 'dl', items: [
        ['Prediction',   'Cross-platform arbitrage on Polymarket, Kalshi, PredictIt and Manifold — AI-matched pairs, fee-adjusted net ROI.'],
        ['Funding',      'Cross-exchange perp funding-rate spreads (Binance / Bybit / OKX / Gate.io / Bitget / Hyperliquid / dYdX). Delta-neutral, Net $/day first.'],
        ['Cash & Carry', 'Spot + dated-futures basis trades on Binance, OKX and Deribit. Basis is locked at entry and held to expiry.'],
        ['Sports',       'Cross-bookmaker surebets via OddsAPI snapshot scans — outlier-filtered and credit-metered, not a live feed.'],
        ['Traders',      'Polymarket realized-PnL leaderboard, follow and alerts. Read-only, no keys collected. Past PnL is not a forecast.'],
        ['Rewards',      'Read-only liquidity-reward yield estimator across Polymarket CLOB and Kalshi LIP markets. Estimates only — neither platform publishes its exact reward formula.'],
        ['Portfolio',    'Your manual log of trades entered. Tracks realized P&L that you record yourself.'],
      ]},

      { t: 'h', s: 'Honesty' },
      { t: 'ul', items: [
        'Nothing shown here is financial advice.',
        'Returns are variable and not guaranteed.',
        'Edgeradar surfaces patterns in public market data; execution, fees, and slippage are your responsibility.',
        'Opportunities are sometimes zero for days at a time. That is honest market reality, not a bug.',
      ]},
    ],
  },

  portfolio: {
    title: 'How to use: Portfolio',
    blocks: [
      { t: 'h', s: 'What it tracks' },
      { t: 'p', s: 'A manual ledger of trades you have entered. Record entry details (size, platform, ROI estimate) and outcome to track realized P&L over time. Nothing here is connected to an exchange or broker — it is a personal log; no trade is executed or verified automatically.' },

      { t: 'h', s: 'Accuracy note' },
      { t: 'p', s: 'P&L depends entirely on the prices and fees you enter. Edgeradar does not pull live account balances, verify executions, or confirm a trade filled at the recorded price. Treat this as a journal, not a brokerage statement.' },
    ],
  },

  mm: {
    title: 'How to use: Rewards',
    blocks: [
      { t: 'h', s: 'What it is' },
      { t: 'p', s: 'A read-only estimator for two maker-reward programs: Polymarket\'s CLOB liquidity rewards and Kalshi\'s Liquidity Incentive Program (LIP). Both pay makers for resting orders near the mid-price on eligible markets. This scans eligible markets, estimates the reward pool and your likely share of it, and ranks by estimated daily yield per $200 deployed. No orders are placed.' },

      { t: 'h', s: 'Polymarket: how the pool is estimated' },
      { t: 'dl', items: [
        ['Daily pool', 'vol24 × takerFeeRate × 2×min(mid,1−mid) × rebateRate — the USDC Polymarket redistributes daily to qualifying makers. The price factor peaks at 1.0 when mid=0.5 and shrinks toward the extremes.'],
        ['Your share', 'sampleCapital / (sampleCapital + competingDepth), where competingDepth is USDC resting in the reward band, snapshotted every 15 min.'],
        ['Est. daily reward / yield %', 'dailyPool × yourShare, divided by sampleCapital for a %/day figure. Moves whenever competition moves.'],
      ]},

      { t: 'h', s: 'Kalshi LIP — different program, less certain' },
      { t: 'p', s: 'Kalshi has not published its LIP scoring formula. This estimate uses an inferred flat pro-rata model, not an official one. Competition is currently thin, so Kalshi yields read higher than Polymarket\'s and should compress as more makers enter — treat this as the least certain figure on the page.' },

      { t: 'h', s: 'Adverse selection risk' },
      { t: 'p', s: 'Passive makers earn the reward but bear adverse selection: when informed traders know the true price has moved away from your quote, they fill you and you lose on the position. The risk score (LOW / MED / MED-HIGH / HIGH) is a structural proxy — mid-range markets away from resolution score lower; markets near resolution (mid<0.05 or >0.95) score HIGH because informed flow dominates there.' },

      { t: 'h', s: 'What these estimates cannot tell you' },
      { t: 'ul', items: [
        'Actual rewards: both platforms calculate rewards with formulas not fully exposed in any public API. This is a reasonable model, not a verified figure.',
        'Your real fill rate and adverse-selection loss — unmeasurable without placing live orders.',
        'Competition between scans: depth snapshots are taken every 15 min; real competition is continuous.',
        'Program changes: either platform can adjust reward rates or eligibility at any time.',
      ]},
    ],
  },

  whales: {
    title: 'How to use: Whale Watch',
    blocks: [
      { t: 'h', s: 'What it is' },
      { t: 'p', s: 'A read-only look at Polymarket\'s short-duration crypto Up/Down markets (5-minute, 15-minute and 4-hour windows). For each resolved market, it pulls public trades, groups them by pseudonymous proxyWallet, and computes realized PnL. Wallets are ranked once they clear the minimum resolved-market count shown above the table, within the current rolling window.' },

      { t: 'h', s: 'PnL methodology' },
      { t: 'dl', items: [
        ['Cost basis', 'Sum of all BUY orders (USDC) across both Up and Down outcomes.'],
        ['Payoff',     'Winning-outcome tokens held at resolution × $1.00. Losing tokens pay $0.'],
        ['PnL',        'Sell proceeds + terminal payoff − cost basis. Negative means a loss.'],
        ['Caveat',     'Computed from public trade data only — off-chain netting or OTC activity is invisible to this.'],
      ]},

      { t: 'h', s: 'Observable patterns' },
      { t: 'dl', items: [
        ['Entry timing',  'Average trade time relative to the window (0% = at open, 100% = at close). Late entries can suggest a latency advantage.'],
        ['Side bias',     'Whether a wallet mostly bets Up or Down. Balanced suggests market-making; skewed suggests conviction or a systematic model.'],
        ['Trades/market', 'Average trades per market. A high count suggests algorithmic order splitting.'],
        ['Avg exposure',  'Average USDC per market. Small and consistent = systematic; large and variable = discretionary.'],
      ]},

      { t: 'h', s: 'Critical honesty warnings' },
      { t: 'ul', items: [
        'Consistently profitable wallets in 5m/15m markets are more likely latency-arbitrage bots with a data or speed edge than humans with better models.',
        'Seeing WHAT a wallet does tells you nothing about WHY — copying the behavior without the same infrastructure will not replicate the edge.',
        'PnL is measured over a recent rolling window. A wallet ranked #1 today can be flat or negative next week.',
        'proxyWallet is a pseudonymous identifier. One person can run many wallets; one wallet can be shared by many people.',
        'This is pattern analysis, not a copy-trade signal. Never mirror a position based on this data alone.',
      ]},
    ],
  },

  history: {
    title: 'How to use: History',
    blocks: [
      { t: 'h', s: 'What it shows' },
      { t: 'p', s: 'A log of opportunities Edgeradar detected over time. Useful for reviewing what surfaced on a given day and checking whether a specific arb resolved as expected. Data goes back as far as the scan log runs.' },

      { t: 'h', s: 'Limitations' },
      { t: 'ul', items: [
        'History reflects what the engine detected at scan time — prices may have moved before you could act on any item.',
        'Past opportunity frequency does not predict future frequency.',
        'Confidence scores and AI match quality vary run to run. Use history for pattern review, not as a performance guarantee.',
      ]},
    ],
  },
};

// ── Renderer ──────────────────────────────────────────────────────────────────

function renderBlock(block: Block, i: number) {
  switch (block.t) {
    case 'h':
      return (
        <div key={i} className={`font-body text-[10px] uppercase tracking-widest text-muted/80 ${i === 0 ? 'mt-0' : 'mt-3'}`}>
          {block.s}
        </div>
      );
    case 'p':
      return (
        <p key={i} className="font-body text-[11px] text-muted leading-relaxed">
          {block.s}
        </p>
      );
    case 'dl':
      return (
        <dl key={i} className="space-y-1">
          {block.items.map(([term, def], j) => (
            <div key={j} className="font-body text-[11px] leading-relaxed">
              <span className="text-ink-2 font-medium">{term}</span>
              <span className="text-muted/50"> — </span>
              <span className="text-muted">{def}</span>
            </div>
          ))}
        </dl>
      );
    case 'ul':
      return (
        <ul key={i} className="space-y-0.5">
          {block.items.map((item, j) => (
            <li key={j} className="font-body text-[11px] text-muted leading-relaxed flex gap-1.5">
              <span className="text-muted/40 shrink-0 mt-px">·</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      );
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SectionHelp({ section }: { section: string }) {
  const [open, setOpen] = useState(false);
  const content = CONTENT[section];
  if (!content) return null;

  return (
    <div className="border border-line/50 mb-5 bg-surface rounded-card">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-4 py-2.5 flex items-center justify-between text-left hover:bg-bg-soft/30 transition-colors duration-100 focus-visible:outline-none rounded-card"
        aria-expanded={open}
      >
        <span className="font-body text-[10px] uppercase tracking-widest text-muted/70">
          How to use this section
        </span>
        <span className="font-body text-[10px] text-muted/40 ml-2 shrink-0 select-none">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-line/30 space-y-2">
          {content.blocks.map((block, i) => renderBlock(block, i))}
        </div>
      )}
    </div>
  );
}
