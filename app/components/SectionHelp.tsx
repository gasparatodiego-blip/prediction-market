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

      { t: 'h', s: 'Status: OFFLINE' },
      { t: 'p', s: 'Live odds fetching via OddsAPI is currently disabled. The free-tier quota is too small for continuous scanning across multiple sports and bookmakers. Enabling live data requires a paid OddsAPI subscription. The matching engine, stake-split calculator, and margin logic are all built and will activate when the feed is live.' },

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
        ['Sports',           'Cross-bookmaker arb. Currently OFFLINE — live data needs a paid OddsAPI plan.'],
        ['Portfolio',        'Manual log of trades you have entered. Track realized P&L.'],
        ['History',          'Log of scanner-detected opportunities over time.'],
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
