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
      { t: 'p', s: 'A ranked list of live opportunities across four strategy types, ordered by annualized ROI. CASHABLE/SIGNAL/SPORTS items are populated by running matcher-v2.js manually (it uses a paid AI model, so it stays on-demand). FUNDING items update automatically every 60 s from the live funding engine.' },

      { t: 'h', s: 'Badge types' },
      { t: 'dl', items: [
        ['CASHABLE', 'A locked binary arbitrage you can execute now. Buy YES on one platform, NO on another; the combined cost is below $1. Profit is realized when the market resolves.'],
        ['SIGNAL',   'Informational only. Source is a play-money or mid-price platform (Manifold, Metaculus, Futuur). NOT executable — use as a directional signal only, never as a trade.'],
        ['SPORTS',   'Cross-bookmaker arb — back every outcome across different books so implied probabilities sum to <1. Profit is locked regardless of result. Currently offline.'],
        ['FUNDING',  'Delta-neutral crypto funding-rate harvest. LONG on the exchange paying the lower rate, SHORT where you collect the higher rate. See Funding Monitor for detail.'],
      ]},

      { t: 'h', s: 'Reading a card' },
      { t: 'p', s: 'Legs show platform · side · price. The large bold number is the ANNUALIZED ROI — extrapolated at the current spread or rate, not a guaranteed return. "net/yr" = after estimated fees. The countdown runs to resolution. "max —" means orderbook depth is NOT verified; position size is unknown. Capacity is always null for FUNDING items by design.' },

      { t: 'h', s: 'Verdicts' },
      { t: 'dl', items: [
        ['ACTIONABLE',          'Spread looks real and executable — worth a closer look before prices move.'],
        ['CAPITAL-LOCKUP-SKIP', 'Real spread, but resolution is so far out that the annualized return is unattractive relative to the capital locked up for that duration.'],
        ['SIGNAL',              'Informational only; from a non-executable source. Do not trade on this alone.'],
        ['HARVEST · variable',  'Funding arb at current rate. Rate is variable — can flip on the next reset. Not locked.'],
        ['STALE-CHECK',         'Data may be stale. Re-verify prices on the source platforms before acting.'],
      ]},

      { t: 'h', s: 'Capital & leverage control' },
      { t: 'p', s: 'Enter your capital to see per-item dollar projections: notional per leg, fees (round-trip), net 30d, net/yr, and return-on-capital. APY is calculated on NOTIONAL, not on your capital — at 1× leverage you commit roughly 2× the per-leg notional in margin across both perp legs, so return-on-capital is lower than the gross APY figure. Higher leverage raises return-on-capital but introduces liquidation risk. No orderbook depth is verified, so position size suitability is your responsibility to check.' },

      { t: 'h', s: 'Honesty' },
      { t: 'ul', items: [
        'Opportunities are often few or zero. That is normal and reflects honest market conditions — not a bug.',
        'Never act on SIGNAL items. They come from non-real-money sources and are not executable.',
        'Annualized ROI on CASHABLE items is extrapolated over the resolution window; the actual % is much smaller.',
        'Nothing here is financial advice. Verify prices yourself before committing capital.',
      ]},
    ],
  },

  funding: {
    title: 'How to use: Funding Monitor',
    blocks: [
      { t: 'h', s: 'What it is' },
      { t: 'p', s: 'Real-time cross-exchange perpetual funding-rate spread monitor. Venues: Binance, Bybit, OKX (8h funding intervals) and Hyperliquid DEX (1h intervals). The scanner computes and ranks every cross-venue pair by gross annualized spread, then shows net after round-trip fees.' },

      { t: 'h', s: 'The trade' },
      { t: 'p', s: 'Delta-neutral: LONG the perp on the exchange where you collect funding, SHORT on the other. Sign rule: positive funding rate → shorts collect; negative rate → longs collect. You harvest the differential; delta exposure is near zero, so price direction does not matter — only the spread and its stability matter.' },

      { t: 'h', s: 'Reading a spread row' },
      { t: 'dl', items: [
        ['SHORT (collect)', 'Exchange with the higher annualized rate — you short here and collect funding every interval.'],
        ['LONG (pay)',      'Exchange with the lower annualized rate — you go long here.'],
        ['GROSS APY',       'Annualized spread before any fees (extrapolated at the current rate).'],
        ['FEES',            'Round-trip cost across 4 legs (open + close on both sides). CEX: 0.04%/leg. Hyperliquid: 0.025%/leg.'],
        ['BREAKEVEN',       'Days at the current rate until fees are fully covered. Shorter is better.'],
        ['NET 30d APY',     'Annualized net after amortizing the round-trip fee cost over 30 days.'],
        ['STATUS',          'HARVEST = ≤5d breakeven · CAUTION = ≤10d · MARGINAL = >10d.'],
      ]},

      { t: 'h', s: 'Caveats — read before trading' },
      { t: 'ul', items: [
        'APY is on NOTIONAL, not your capital. At 1× you tie up ~2× notional in margin across both perps; return-on-capital is lower than the gross APY figure shown.',
        'Funding is VARIABLE. CEX resets every 8h, Hyperliquid resets every hour. The rate you see now is NOT what you will earn — it can flip on the very next reset.',
        'DEX leg (Hyperliquid) requires a one-time bridge deposit (~10 min, ~$1–5 ETH gas). Factor this into cost for small positions.',
        'Liquidity at a given size is NOT verified. The scanner does not check orderbook depth — confirm slippage and depth on each exchange before sizing in.',
        'This is not financial advice. Funding arb is a real strategy but execution details vary by exchange, account type, and margin mode.',
      ]},

      { t: 'h', s: 'Rate heatmap' },
      { t: 'p', s: 'Shows the raw funding rate per exchange per coin. Positive → shorts collect. Negative → longs collect. Hyperliquid rates are per hour (/hr); CEX rates are per 8h period (/8h). Wide divergence between two rows = potential spread opportunity.' },
    ],
  },

  sports: {
    title: 'How to use: Sports Arbitrage',
    blocks: [
      { t: 'h', s: 'What it is' },
      { t: 'p', s: 'Cross-bookmaker sports arbitrage scanner. When different bookmakers price the same event with implied probabilities that sum to less than 1, you can back every outcome across books and lock a guaranteed profit regardless of result. The profit margin is small (typically 1–4%) but has no directional risk.' },

      { t: 'h', s: 'How surebets work' },
      { t: 'ul', items: [
        'Find an event where bookmaker A offers high odds on Home, bookmaker B offers high odds on Away (or Draw).',
        'Calculate stakes per outcome so the payout on ANY result exceeds your total outlay.',
        'The margin % is guaranteed profit as a fraction of total stake — before account limits or odds movement.',
        'Odds move fast. Speed and dual-tab execution matter; this is manual, not automated.',
      ]},

      { t: 'h', s: 'Credit-safe polling' },
      { t: 'p', s: 'The scanner polls OddsAPI every 45 minutes (configurable). It calls /sports first (0 credits) to discover active leagues, then fetches /odds only for the top 3 in-season sports. Two free-tier API keys rotate automatically — the agent pauses and sends a Telegram alert when both hit the credit floor (default: 50 remaining). No fake data is ever shown: when offline or paused, the card shows an honest OFFLINE / PAUSED status.' },

      { t: 'h', s: 'When live, each row will show' },
      { t: 'ul', items: [
        'Event, league, and the two (or more) bookmakers involved.',
        'Per-outcome stake split — pre-calculated to lock the margin whatever the result.',
        'Margin % — the locked profit as a percentage of total stake.',
        'Time to kickoff and odds-freshness indicator.',
      ]},

      { t: 'h', s: 'Honesty' },
      { t: 'p', s: 'Bookmakers routinely limit or ban accounts that consistently stake on arbs. Margins are small; any delay or partial fill can flip a profit into a loss. This is a real strategy, but it requires speed, multiple funded accounts, and acceptance of account-limitation risk.' },
    ],
  },

  overview: {
    title: 'How to use: Dashboard',
    blocks: [
      { t: 'h', s: 'What is ArbScanner?' },
      { t: 'p', s: 'A multi-strategy arbitrage and funding-rate scanner. It surfaces live opportunities across prediction markets, crypto perpetuals, and sports — it does not execute trades. You decide whether to act; you are responsible for verifying prices and managing risk.' },

      { t: 'h', s: 'Where to start' },
      { t: 'dl', items: [
        ['Opportunities',    'The main ranked list. Shows all live items across every strategy type. Best first stop.'],
        ['Funding Monitor',  'Real-time cross-exchange perp funding-rate spreads (Binance / Bybit / OKX / Hyperliquid). For delta-neutral trades.'],
        ['Sports',           'Cross-bookmaker arb via OddsAPI. Polls every 45 min with credit-safe key rotation. Shows OFFLINE / PAUSED when data is unavailable — never fake numbers.'],
        ['Portfolio',        'Manual log of trades you have entered. Track realized P&L.'],
        ['History',          'Log of scanner-detected opportunities over time.'],
        ['MM Analyzer',      'Read-only Polymarket market-making simulation. Two P&L numbers: measured (verified) and estimated rewards (labeled assumption).'],
        ['Whale Watch',      'Realized-PnL ranking of consistently-active Polymarket short-market wallets. Observational only.'],
      ]},

      { t: 'h', s: 'Honesty' },
      { t: 'ul', items: [
        'Nothing shown here is financial advice.',
        'Returns are variable and not guaranteed.',
        'The scanner surfaces patterns in public market data; execution details, fees, and slippage are your responsibility.',
        'Opportunities are sometimes zero for days at a time. That is honest market reality, not a bug.',
      ]},
    ],
  },

  portfolio: {
    title: 'How to use: Portfolio',
    blocks: [
      { t: 'h', s: 'What it tracks' },
      { t: 'p', s: 'A manual ledger of trades you have entered. Record entry details (size, platform, ROI estimate) and outcome to track realized P&L over time. Positions are not connected to any exchange or broker — this is a personal log only; nothing is executed or verified automatically.' },

      { t: 'h', s: 'Accuracy note' },
      { t: 'p', s: 'P&L figures depend entirely on the prices and fees you enter. The scanner does not pull live account balances, verify executions, or validate that a trade was actually filled at the recorded price. Treat this as a journal, not a brokerage statement.' },
    ],
  },

  mm: {
    title: 'How to use: MM Analyzer',
    blocks: [
      { t: 'h', s: 'What it is' },
      { t: 'p', s: 'A read-only simulation of passive two-sided market making on Polymarket binary markets. The agent models a $50 resting YES quote (bid and ask) on each eligible market, infers fills from the public trade stream, and records each simulated cycle\'s outcome. No orders are placed. Zero Claude API calls.' },

      { t: 'h', s: 'Market eligibility (golden rule)' },
      { t: 'dl', items: [
        ['Mid 0.30–0.70', 'Markets near 50/50 — wide enough that both sides attract real volume.'],
        ['Vol ≥$100/day', 'Minimum 24h trade volume; below this fills are too sparse to simulate.'],
        ['≥14 days',      'Enough time horizon that a maker position can cycle multiple times before resolution.'],
        ['acceptingOrders', 'CLOB must be open (some markets pause order books near resolution).'],
      ]},

      { t: 'h', s: 'Fill simulation — APPROXIMATE' },
      { t: 'p', s: 'Fills are inferred from the public data-api trade stream. When a SELL Yes trade crosses at price ≤ our bid, we assume our buy order filled. When a BUY Yes trade crosses at price ≥ our ask, we assume our sell order filled. Queue position is unknown — actual fills in a live order book depend on time-priority. This is a statistical approximation, not an exact replay.' },

      { t: 'h', s: 'Cycle types' },
      { t: 'dl', items: [
        ['perfect', 'Both bid and ask filled within the 30-min window — spread captured. P&L = (ask − bid) × shares.'],
        ['adverse', 'Only one side filled. Closed at 5pp adverse move (cut-loss) or after 30-min timeout. P&L may be negative.'],
        ['resolved', 'Market resolved before the cycle closed. P&L computed from terminal payoff.'],
      ]},

      { t: 'h', s: 'Two P&L numbers — why separate' },
      { t: 'dl', items: [
        ['Measured net P&L', 'Spread captures minus adverse-selection losses. Computed from observed trade data. Verified and honest — this is what the simulation actually shows.'],
        ['Estimated rewards', 'ASSUMPTION: 0.25%/day of quoted notional. The actual Polymarket maker reward rate is set by governance off-chain and is NOT available in any public API. This number is an adjustable estimate, not a fact. Typical published range: 0.10%–0.50%/day.'],
      ]},

      { t: 'h', s: 'Why adverse selection is the killer' },
      { t: 'ul', items: [
        'In active markets, informed traders (bots with private feeds or better models) trade against stale quotes.',
        'A passive maker\'s ask fills when someone is confident the true price is ABOVE the ask. That\'s adverse for us.',
        'A single 10pp adverse move can erase 5× the spread earned on perfect cycles.',
        'The measured P&L is honest about this — rewards are kept entirely separate so the real cost of adverse selection is visible.',
        'If measured P&L is negative and the total only becomes positive with rewards, the strategy is reward-dependent — a fragile position if Polymarket changes its reward program.',
      ]},

      { t: 'h', s: 'Hard limitations' },
      { t: 'ul', items: [
        'Queue position unknown. Fill inference may over- or under-count actual fills.',
        'Gas/spread costs on Polymarket (MATIC gas, 0% maker fee but taker-driven) are not modeled.',
        'negRisk markets (multi-outcome) may have different fill dynamics; treated identically here.',
        'Reward rate is not from any API. If you rely on rewards, verify the actual current rate via Polymarket\'s reward documentation before sizing in.',
      ]},
    ],
  },

  whales: {
    title: 'How to use: Whale Watch',
    blocks: [
      { t: 'h', s: 'What it is' },
      { t: 'p', s: 'A read-only analysis of Polymarket short-crypto-market wallets (5-min, 15-min, 4-hour, 1-hour Up/Down markets). For each resolved market, it pulls all public trades, groups by pseudonymous proxyWallet, and computes realized PnL. Wallets appearing in ≥10 resolved markets over the past 7 days are ranked.' },

      { t: 'h', s: 'PnL methodology' },
      { t: 'dl', items: [
        ['Cost basis', 'Sum of all BUY orders (in USDC) across both Up and Down outcomes.'],
        ['Payoff',     'Winning-outcome tokens held at resolution × $1.00. Losing tokens → $0.'],
        ['PnL',        'Sell proceeds + terminal payoff − cost basis. Negative = loss.'],
        ['Caveat',     'Computed from public trade data only. Off-chain netting or OTC activity is invisible.'],
      ]},

      { t: 'h', s: 'Observable patterns' },
      { t: 'dl', items: [
        ['Entry timing', 'Average trade timestamp relative to the window start (0% = entered at open, 100% = at close). Late-window entry may indicate latency advantages.'],
        ['Side bias',    'Whether the wallet predominantly bet Up or Down across markets. Balanced suggests market-making; skewed suggests directional conviction or systematic model.'],
        ['Trades/market', 'Average number of trades per market. High count suggests algorithmic order splitting.'],
        ['Avg exposure', 'Average USDC deployed per market. Small, consistent sizing = systematic; large variable sizing = discretionary.'],
      ]},

      { t: 'h', s: 'Critical honesty warnings' },
      { t: 'ul', items: [
        'Most consistently-profitable wallets in 5m/15m markets are almost certainly latency arbitrage bots with co-location or private data-feed advantages — not humans with better models.',
        'Observing WHAT a wallet does tells you nothing about WHY, and copying behavior without the same infrastructure cannot replicate the edge.',
        'PnL is historical over a 7-day window. A wallet ranking #1 today may be flat or negative this week.',
        'proxyWallet is a pseudonymous identifier. One person can operate many wallets; one wallet can be controlled by many people.',
        'This is pattern analysis, not a copy-trade signal. Never mirror positions based solely on this data.',
      ]},
    ],
  },

  history: {
    title: 'How to use: History',
    blocks: [
      { t: 'h', s: 'What it shows' },
      { t: 'p', s: 'A log of opportunities the scanner detected over time. Useful for reviewing what was surfaced on a given day and checking whether specific arbs resolved as expected. Data goes back as far as the scan log runs.' },

      { t: 'h', s: 'Limitations' },
      { t: 'ul', items: [
        'History reflects what the engine detected at scan time. Prices may have moved before you could act on any item.',
        'Past opportunity frequency is not indicative of future opportunity frequency.',
        'Confidence scores and AI match quality vary run-to-run. Use history for pattern review, not as a performance guarantee.',
      ]},
    ],
  },
};

// ── Renderer ──────────────────────────────────────────────────────────────────

function renderBlock(block: Block, i: number) {
  switch (block.t) {
    case 'h':
      return (
        <div key={i} className={`font-mono text-[9px] uppercase tracking-widest text-text-muted/80 ${i === 0 ? 'mt-0' : 'mt-3'}`}>
          {block.s}
        </div>
      );
    case 'p':
      return (
        <p key={i} className="font-mono text-[11px] text-text-muted leading-relaxed">
          {block.s}
        </p>
      );
    case 'dl':
      return (
        <dl key={i} className="space-y-1">
          {block.items.map(([term, def], j) => (
            <div key={j} className="font-mono text-[11px] leading-relaxed">
              <span className="text-text-secondary">{term}</span>
              <span className="text-text-muted/50"> — </span>
              <span className="text-text-muted">{def}</span>
            </div>
          ))}
        </dl>
      );
    case 'ul':
      return (
        <ul key={i} className="space-y-0.5">
          {block.items.map((item, j) => (
            <li key={j} className="font-mono text-[11px] text-text-muted leading-relaxed flex gap-1.5">
              <span className="text-text-muted/40 shrink-0 mt-px">·</span>
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
    <div className="border border-border/50 mb-5 bg-bg-panel/40">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-4 py-2.5 flex items-center justify-between text-left hover:bg-bg-elevated/30 transition-colors duration-100 focus-visible:outline-none"
        aria-expanded={open}
      >
        <span className="font-mono text-[10px] uppercase tracking-widest text-text-muted/70">
          How to use this section
        </span>
        <span className="font-mono text-[10px] text-text-muted/40 ml-2 shrink-0 select-none">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-border/30 space-y-2">
          {content.blocks.map((block, i) => renderBlock(block, i))}
        </div>
      )}
    </div>
  );
}
