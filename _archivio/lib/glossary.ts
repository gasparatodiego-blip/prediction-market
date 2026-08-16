// lib/glossary.ts — SINGLE SOURCE OF TRUTH for every jargon definition on
// Edgeradar. Both the inline <InfoDot> tooltips and the public /how-it-works
// page render from this file, so a definition can never drift between the two.
//
// Copy rules (honest-engine): plain language, no hype, no promises. A Signal is
// NOT guaranteed and can lose; a run-rate is a projection, not a return; unknown
// stays "—". Keep each `short` to one or two honest sentences.

export interface GlossaryEntry {
  /** Human-readable term, exactly as it should appear as a heading. */
  title: string;
  /** The honest one/two-line definition shown in tooltips AND on the page. */
  short: string;
}

export const GLOSSARY = {
  signal: {
    title: 'Signal',
    short:
      'A value / +EV single bet measured against a sharp reference. Favorable, but NOT guaranteed — it can still lose. Not a locked-in arbitrage.',
  },
  cashable: {
    title: 'Cashable',
    short:
      'A true arbitrage (leg prices sum to under 1) that includes a Pinnacle (sharp) covering leg. The most reliable tier — profit is locked if both legs fill at the shown prices.',
  },
  arb_soft: {
    title: 'Arb soft',
    short:
      'A true arbitrage using only soft books — no sharp (Pinnacle) leg. Mathematically an arb, but fragile: soft books limit or ban arb winners and move lines fast.',
  },
  no_vig_fair: {
    title: 'No-vig fair',
    short:
      "A bookmaker's price with its built-in margin (vig) mathematically stripped out, leaving the implied fair probability. We anchor to Pinnacle's no-vig line.",
  },
  vig: {
    title: 'Vig',
    short:
      "The bookmaker's built-in margin (overround) baked into the odds. Removing it gives the no-vig fair line used as the reference.",
  },
  sharp_book: {
    title: 'Sharp book',
    short:
      'A bookmaker whose prices are treated as the market reference because they are sharp and rarely limit winners. On our roster only Pinnacle qualifies.',
  },
  net_per_day: {
    title: 'Net $/day',
    short:
      'Estimated net profit per day after fees and funding — the primary number we lead with. A run-rate estimate at current conditions, not a guarantee.',
  },
  run_rate: {
    title: 'Run-rate',
    short:
      'A figure projected forward at the current rate (e.g. annualized). It assumes conditions hold — it is not a promise of future return, and is capped so it never reads as too-good-to-be-true.',
  },
  unrealized: {
    title: 'Unrealized',
    short:
      'Paper P&L on positions still open, marked at real live/settled data. It can still move both ways — it is not money booked.',
  },
  realized: {
    title: 'Realized',
    short:
      'P&L actually locked in from closed positions. Nothing is realized while a position is still open.',
  },
  capacity: {
    title: 'Capacity',
    short:
      'How much size the opportunity can absorb at the shown price, measured from the real order book — not open interest. Beyond it, the edge decays.',
  },
  thin: {
    title: 'THIN / not executable at size',
    short:
      'The book is too thin to fill a full ticket at the shown price. Shown separately and excluded from the headline P&L — never merged in.',
  },
  near_zero_price: {
    title: 'Near-zero-price',
    short:
      'A contract priced very close to 0 (or 1). Tiny absolute moves swing the percentage wildly, so these are flagged — the % edge can look huge but is not executable.',
  },
  signal_only_venue: {
    title: 'Signal-only venue',
    short:
      'A venue treated as reference only, not executable for a cashable claim. Its prices inform Signal but never count toward a guaranteed arb.',
  },
  market_implied: {
    title: 'Market-implied probability',
    short:
      "The market's own live price read as a probability — the CLOB bid/ask mid (or last trade). It is what the crowd is trading at right now, NOT our forecast and NOT an edge we computed.",
  },
  indicative: {
    title: 'Indicative',
    short:
      'Shown for reference only. A live market price that moves continuously — not a locked quote, not a guarantee, and not a number we derive an edge from.',
  },
  margin: {
    title: 'Margin',
    short:
      "The collateral you put up to open a leveraged position. It backs the trade — if the trade moves against you, it's drawn from your margin.",
  },
  usdt_margined: {
    title: 'USDT-M (USDT-margined)',
    short:
      "Contract collateralized and settled in USDT (a dollar-stablecoin). Like betting in dollars: your margin and P&L are in stable value, so it's simple and predictable. Preferred for clean cash & carry — we label these Cashable.",
  },
  coin_margined: {
    title: 'COIN-M (coin-margined)',
    short:
      "Contract collateralized and settled in the coin itself (e.g. BTC for BTC futures). Like betting in Bitcoin: if the coin's price falls, your collateral's value falls too. These are inverse contracts with non-linear P&L — more complex and riskier, so we label them Speculative.",
  },
  inverse_contract: {
    title: 'Inverse contract',
    short:
      "A futures contract quoted and settled in the base coin instead of dollars. The payoff isn't linear in price — the same price move doesn't produce a proportional P&L, which makes it harder to size and hedge cleanly.",
  },
} satisfies Record<string, GlossaryEntry>;

export type GlossaryTerm = keyof typeof GLOSSARY;

// Display order for the full glossary on /how-it-works (tooltips index by key).
export const GLOSSARY_ORDER: GlossaryTerm[] = [
  'cashable',
  'arb_soft',
  'signal',
  'no_vig_fair',
  'vig',
  'sharp_book',
  'net_per_day',
  'run_rate',
  'unrealized',
  'realized',
  'capacity',
  'thin',
  'near_zero_price',
  'signal_only_venue',
  'margin',
  'usdt_margined',
  'coin_margined',
  'inverse_contract',
];
