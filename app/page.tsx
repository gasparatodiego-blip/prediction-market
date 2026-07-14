import fs from 'fs';
import type { ReactNode } from 'react';
import Link from 'next/link';
import PlatformLogo from '@/components/PlatformLogo';
import { type EdgeChipVariant } from '@/app/components/ui/EdgeChip';
import RadarMark    from '@/app/components/ui/RadarMark';
import skin from './landing-skin.module.css';
import { HeroField, CyclingCard } from '@/app/components/landing/LiveField';
import { tierColor } from '@/app/components/landing/tier-color';
import { Instrument_Serif, Manrope, IBM_Plex_Mono } from 'next/font/google';
import { getCryptoSpreadsData, calcSpreadSizing } from '@/lib/spread-compute';
import { filterSane, enforceVerified } from '@/lib/display-sanity';
import { applyGuardian } from '@/lib/guardian-suppress';
import { LANDING_CAPITAL_BASIS } from '@/lib/honest-display';
import { isSanePolymarketLevel } from '@/lib/reward-gating';
import { estimateReward, type MarketSnapshot } from '@/lib/rewards-estimate';
import { isExpired } from '@/lib/instrument-expiry';

export const dynamic = 'force-dynamic';

// ── Landing re-skin fonts — "The live field" ─────────────────────────────────
// Page-scoped; applied only on the landing root via CSS variables, so no shared
// component is edited. Display = Instrument Serif (private-bank serif — the
// deliberate risk); body = Manrope; data/readouts = IBM Plex Mono.
const instrument = Instrument_Serif({
  subsets: ['latin'], weight: '400', style: ['normal', 'italic'],
  display: 'swap', variable: '--font-instrument',
});
const manrope = Manrope({
  subsets: ['latin'], weight: ['300', '400', '500'],
  display: 'swap', variable: '--font-manrope',
});
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'], weight: ['400', '500'],
  display: 'swap', variable: '--font-plex-mono',
});

// ── Scan scope (hero headline) ───────────────────────────────────────────────
// Real, measured count of markets Edgeradar fetches: predictit + manifold +
// kalshi + polymarket in /tmp/markets-raw.json summed to 84,276–84,458 across
// reads on 2026-07-14. That file is 88MB (~1.2s to parse) — far too heavy to
// read on every force-dynamic request — so this is a conservative rounded-DOWN
// constant of the real scanning scope. NOT fabricated, NOT inflated, NOT a
// volatile financial readout. The one number that MUST be live — the count of
// surviving opportunities — is liveRows.length, bound in the hero below.
const SCANNED_SCOPE = '~84,000';

const NUM_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
function numberWord(n: number): string {
  return n >= 0 && n < NUM_WORDS.length ? NUM_WORDS[n] : String(n);
}
// Chip variant → exact honest label (same strings as EdgeChip). Preserved verbatim.
const TIER_LABEL: Record<string, string> = {
  cashable: 'CASHABLE', signal: 'SIGNAL', copy_trader: 'SIGNAL',
  speculative: 'SPECULATIVE', paper: 'PAPER', trap: 'TRAP',
};

// ── Server-side stats ──────────────────────────────────────────────────────
interface FundingStat  { dayUsd1k: number; coin: string; shortExchange: string; longExchange: string; netApy30d: number }
interface PredStat     { cashable: number; pairsChecked: number }
interface BasisStat    { netAnnualized: number; asset: string; exchange: string; contract: string; coinMargined: boolean }
interface SportsStat   { netMargin: number; homeTeam: string; awayTeam: string; sport: string }
// Highest est net/day per $1k (after adverse-selection cost) among the current
// sane reward-eligible markets for `platform`. bestDayUsd1k is null when no
// eligible market produces a real positive estimate — the card then shows a
// "see Rewards tab" signal with NO number (never a fabricated figure).
interface RewardsStat  { bestDayUsd1k: number | null; eligibleCount: number; platform: string }

interface LiveRow {
  key:        string;
  icon:       string;
  tileColor:  'mint' | 'violet' | 'gold';
  name:       ReactNode;
  sub?:       ReactNode;
  chip:       EdgeChipVariant;
  value:      ReactNode;
  unit:       string;
  valueTone:  'up' | 'neutral';
  // Net $/day this row is actually worth at the shared LANDING_CAPITAL_BASIS
  // ($1k). Only set when that's a genuine, non-fabricated number — a
  // continuously-accruing rate (funding, rewards, carry) has one; a one-off
  // matched-bet arb (sports) or an opportunity count (prediction) does not,
  // and we never invent a day-rate for those. Rows with a real $/day sort
  // above rows without one; each bucket is then ordered by its own metric.
  dayUsd1k:   number | null;
  fallbackScore: number;
}

function readLandingStats(): {
  funding: FundingStat | null; prediction: PredStat | null;
  basis: BasisStat | null; sports: SportsStat | null; rewards: RewardsStat | null;
} {
  let funding: FundingStat | null    = null;
  let prediction: PredStat | null    = null;
  let basis: BasisStat | null        = null;
  let sports: SportsStat | null      = null;
  let rewards: RewardsStat | null    = null;

  try {
    const raw  = JSON.parse(fs.readFileSync('/tmp/arbitrage-opportunities.json', 'utf8'));
    const s    = raw?.stats ?? {};
    const cash = s.confirmedCashable ?? 0;
    const tot  = cash + (s.rejectedNotSameEvent ?? 0) + (s.pendingVerification ?? 0);
    prediction = { cashable: cash, pairsChecked: tot };
  } catch { /* file absent or stale */ }

  try {
    // Same pipeline the funding-arb dashboard uses (lib/spread-compute.ts). The
    // landing must show the SAME real maximum the dashboard surfaces — so it scans
    // the exact SAME list the funding-arb page renders. getCryptoSpreadsData() is
    // read directly (not the paid-gated /api/crypto route), so netApy30d is never
    // redacted here; but that means we must re-apply the /api/crypto route's own
    // display-sanity backstop that the raw lib call skips. filterSane('funding')
    // drops phantom rows (a per-leg rate over the plausible cap, or a grossApy above
    // the 200%/yr display cap — the edgeX cap-pin spike class, e.g. TON aster/edgeX
    // ~2300%/yr) and enforceVerified drops source-verifier mismatches — the identical
    // anti-spike/dead-contract guard the funding-arb page applies. This is NOT the
    // thin-book size filter: thin / one-leg-unverified pairs (sub-cap real
    // opportunities like TRX $2.10) still pass and stay eligible for the max; a thin
    // book only limits executable SIZE (surfaced separately on the order page).
    const { spreads: rawSpreads } = getCryptoSpreadsData();
    // Guardian (rules A–E) runs last, same as the funding-arb tab, so the landing's
    // headline max can never come from a row the tab itself would suppress.
    const spreads = applyGuardian('funding',
      enforceVerified('funding', filterSane('funding', rawSpreads))).rows;
    // Surface the SINGLE highest real net/day per $1k across the sanity-passed
    // spreads — NOT first-in-list. Ranked by calcSpreadSizing at the shared $1k/1x
    // basis — the SAME sizing (== the page's netDayForCapital) — so this equals the
    // dashboard's #1 net/day for that pair, and can never surface a row the
    // funding-arb page itself rejects.
    let best: { spread: (typeof spreads)[number]; dayUsd: number } | null = null;
    for (const s of spreads) {
      if (s.netApy30d == null) continue;   // sizing needs the fee-net rate; not an eligibility gate
      const sizing = calcSpreadSizing(s, 1000, 1);
      if (!sizing) continue;
      if (best == null || sizing.dayUsd > best.dayUsd) best = { spread: s, dayUsd: sizing.dayUsd };
    }
    if (best && best.dayUsd > 0) {
      funding = {
        dayUsd1k:      Math.round(best.dayUsd * 100) / 100,
        coin:          best.spread.coin,
        shortExchange: best.spread.shortExchange,
        longExchange:  best.spread.longExchange,
        netApy30d:     best.spread.netApy30d!,
      };
    }
  } catch { /* file absent */ }

  try {
    const raw  = JSON.parse(fs.readFileSync('/tmp/basis-opportunities.json', 'utf8'));
    const opps = (raw?.opportunities ?? []) as Array<{
      asset: string; exchange: string; contract: string;
      netAnnualizedExecutable?: number; netAnnualized?: number; coinMargined?: boolean;
    }>;
    const nowMs = Date.now();
    const sorted = [...opps]
      // Never surface an expired dated future (single source: lib/instrument-expiry).
      .filter(o => !isExpired(o, nowMs))
      .filter(o => (o.netAnnualizedExecutable ?? o.netAnnualized ?? 0) > 0)
      .sort((a, b) => (b.netAnnualizedExecutable ?? b.netAnnualized ?? 0) - (a.netAnnualizedExecutable ?? a.netAnnualized ?? 0));
    if (sorted.length > 0) {
      const top = sorted[0];
      basis = {
        // netAnnualizedExecutable/netAnnualized are fractions (0.0363 = 3.63%/yr,
        // see verdict field in /tmp/basis-opportunities.json) — *100 before rounding
        // to 1 decimal, same conversion app/dashboard/carry/page.tsx's fmtAnnualized() uses.
        netAnnualized: Math.round((top.netAnnualizedExecutable ?? top.netAnnualized ?? 0) * 1000) / 10,
        asset:         top.asset,
        exchange:      top.exchange,
        contract:      top.contract,
        coinMargined:  top.coinMargined ?? false,
      };
    }
  } catch { /* file absent */ }

  try {
    const raw = JSON.parse(fs.readFileSync('/tmp/sports-odds.json', 'utf8'));
    // Only use data fresh within 2 hours
    const ageMs = Date.now() - (typeof raw.fetchedAt === 'number' ? raw.fetchedAt : 0);
    if (ageMs < 7_200_000) {
      const arbs = (raw?.arbOpportunities ?? []) as Array<{
        homeTeam: string; awayTeam: string; sport: string;
        netMargin: number; grossMargin: number; isStale?: boolean;
      }>;
      const valid = arbs
        .filter(a => !a.isStale && (a.netMargin ?? a.grossMargin ?? 0) > 0)
        .sort((a, b) => (b.netMargin ?? 0) - (a.netMargin ?? 0));
      if (valid.length > 0) {
        sports = {
          netMargin: valid[0].netMargin ?? valid[0].grossMargin,
          homeTeam:  valid[0].homeTeam,
          awayTeam:  valid[0].awayTeam,
          sport:     valid[0].sport,
        };
      }
    }
  } catch { /* file absent or stale */ }

  try {
    // Maker-rewards headline = the SINGLE HIGHEST estimated net/day per $1k
    // (AFTER adverse-selection cost) among the current sane Polymarket reward
    // markets — the real max for this category, matching what the Rewards tab
    // shows for that same market (never fabricated, still SIGNAL not cashable).
    //   • Source: /tmp/liquidity-rewards.json — the normalized snapshot
    //     (lib/rewards-normalize.js) whose fields ARE lib/rewards-estimate.ts's
    //     MarketSnapshot input (real book depth only, never OI/midpoint).
    //   • Estimate: lib/rewards-estimate.ts at a standard $1k two-sided
    //     placement resting mid-band — the SAME call the Rewards tab makes
    //     (app/dashboard/liquidity-rewards/page.tsx typicalNet()).
    //   • Sane gate: isSanePolymarketLevel (zero dashboard flags) — the SAME
    //     gate the dashboard uses; TRAP/SHORT_BURST/THIN_CAP/etc. are excluded.
    //   • Scope: Polymarket only. The card is a Polymarket-rewards card, and
    //     Kalshi's flat pro-rata model produces run-rates that would read as
    //     too-good-to-be-true on a public landing (honest-engine). A market
    //     whose estimate nets <= 0 after adverse cost is not a reward
    //     opportunity, so only real positive nets enter the median.
    const norm    = JSON.parse(fs.readFileSync('/tmp/liquidity-rewards.json', 'utf8'));
    const normMkts = (norm?.markets ?? []) as Array<MarketSnapshot & {
      venue: string; flags?: string[];
    }>;
    const nets: number[] = [];
    for (const m of normMkts) {
      if (m.venue !== 'polymarket') continue;
      if (!isSanePolymarketLevel({ flags: m.flags ?? [] })) continue;
      const snapshot: MarketSnapshot = {
        venue:               'polymarket',
        midpoint:            m.midpoint,
        maxSpread:           m.maxSpread,
        minSize:             m.minSize,
        dailyPool:           m.dailyPool,
        qualifyingLiquidity: m.qualifyingLiquidity,
        bookDepthAtBand:     m.bookDepthAtBand,
        volatilityStdev:     m.volatilityStdev ?? null,
        twoSidedRequired:    m.twoSidedRequired,
        sides:               m.sides ?? null,
      };
      const dist = (m.maxSpread ?? 2) / 2;   // rest mid-band, same as the Rewards tab
      const r = estimateReward({
        venue: 'polymarket', capital: LANDING_CAPITAL_BASIS, twoSided: true,
        distanceCents: dist, market: snapshot,
      });
      if (r.netPerDay != null && r.netPerDay > 0) nets.push(r.netPerDay);
    }
    if (nets.length > 0) {
      // Single HIGHEST est net/day per $1k among sane markets — the real max
      // for this category, equal to the per-market number the Rewards tab shows
      // for that market (not a median, never a fabricated figure).
      const best = Math.max(...nets);
      rewards = { bestDayUsd1k: Math.round(best * 100) / 100, eligibleCount: nets.length, platform: 'Polymarket' };
    } else {
      // Sane gate/estimator left nothing real: keep the card as a signal with
      // NO number (honest guard — never fabricate a figure).
      rewards = { bestDayUsd1k: null, eligibleCount: 0, platform: 'Polymarket' };
    }
  } catch { /* file absent */ }

  return { funding, prediction, basis, sports, rewards };
}

function capFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Live card rows ─────────────────────────────────────────────────────────
function buildLiveRows(stats: ReturnType<typeof readLandingStats>): LiveRow[] {
  const { funding, prediction, basis, sports, rewards } = stats;
  const rows: LiveRow[] = [];

  if (funding && funding.dayUsd1k > 0) {
    const icon = funding.coin === 'BTC' ? '₿' : funding.coin === 'ETH' ? 'Ξ' : funding.coin[0];
    rows.push({
      key: 'funding', icon, tileColor: 'mint',
      name: (
        <>
          {funding.coin} funding spread{' '}
          <span className="text-muted font-normal text-[11px] ml-0.5">
            — fee gap between exchanges you capture
          </span>
        </>
      ),
      sub: (
        <>
          short <PlatformLogo platform={funding.shortExchange} size={12} className="mx-1" />
          {capFirst(funding.shortExchange)} · long <PlatformLogo platform={funding.longExchange} size={12} className="mx-1" />
          {capFirst(funding.longExchange)}
        </>
      ),
      chip: 'cashable', valueTone: 'up',
      value: `+$${funding.dayUsd1k.toFixed(2)}`,
      unit:  'net/day per $1k',
      dayUsd1k: funding.dayUsd1k, fallbackScore: funding.dayUsd1k,
    });
  }

  if (sports && sports.netMargin > 0) {
    const icon = sports.sport.includes('basketball') ? '🏀' : sports.sport.includes('football') ? '🏈' : '⚽';
    rows.push({
      key: 'sports', icon, tileColor: 'mint',
      name: 'Cross-book arb',
      sub:  `${sports.homeTeam} vs ${sports.awayTeam}`.slice(0, 34),
      chip: 'cashable', valueTone: 'up',
      value: `+${sports.netMargin.toFixed(1)}%`,
      unit:  'confirmed margin',
      // A matched-bet margin is a one-off locked profit, not a recurring
      // rate — no genuine $/day exists without a fabricated settlement-time
      // assumption, so this stays out of the $/day ranking (see LiveRow.dayUsd1k).
      dayUsd1k: null, fallbackScore: sports.netMargin,
    });
  }

  if (rewards) {
    // Maker rewards are a CONDITIONAL incentive, NOT a cashable arb: earning
    // them requires actively quoting in-book, competing with other LPs (your
    // share dilutes as makers arrive), and the program's rate can change. So
    // this is SIGNAL, never cashable — and although we now show a REAL highest
    // net/day per $1k (after adverse-selection cost, from lib/rewards-estimate.ts),
    // it stays out of the cashable $/day ranking (dayUsd1k: null) so it can't
    // inflate "best net/day". The headline is the primary honest metric ($/day),
    // never an annualized run-rate. Honest guard: no eligible market → NO number.
    const tip = 'Highest estimated net/day per $1,000 among current reward markets, '
      + 'after adverse-selection cost. Varies by market — see Rewards tab.';
    const hasBest = rewards.bestDayUsd1k != null;
    rows.push({
      key: 'rewards', icon: '◈', tileColor: 'violet',
      name: (
        <>
          <PlatformLogo platform={rewards.platform} size={14} className="mr-1.5" />
          <span title={tip}>{rewards.platform} maker rewards</span>{' '}
          <span className="text-muted font-normal text-[11px] ml-0.5">
            — liquidity incentive, not a locked arb
          </span>
        </>
      ),
      sub: hasBest
        ? `Highest of ${rewards.eligibleCount} current ${rewards.platform} reward markets · after adverse-selection cost`
        : 'Rewards-program signal · conditional: needs active quoting, competes with LPs',
      chip: 'signal', valueTone: 'neutral',
      value: hasBest
        ? `+$${rewards.bestDayUsd1k!.toFixed(2)}/day`
        : (<span className="text-muted font-normal" style={{ fontSize: 12 }}>see Rewards tab</span>),
      // Decorated unit (not the audited 'net/day per $1k' vocab token) — a
      // conditional signal estimate, kept honest with an explicit "est" qualifier.
      unit: hasBest ? 'per $1k · est · not guaranteed' : '',
      // Conditional incentive → out of the cashable day-rate ranking; sorts among
      // the no-day-rate rows by its best net/day.
      dayUsd1k: null, fallbackScore: rewards.bestDayUsd1k ?? 0,
    });
  }

  if (basis && basis.netAnnualized > 0) {
    // Same $1k basis as funding/rewards, re-expressed from the already-computed
    // annualized rate (fee-adjusted, executable) — a unit conversion, not a new
    // number. Display stays %/yr (existing convention for this row); this is
    // sort-only.
    const day1k = LANDING_CAPITAL_BASIS * (basis.netAnnualized / 100) / 365;
    rows.push({
      key: 'carry', icon: '◉', tileColor: 'gold',
      name: (
        <>
          {basis.asset} carry{' '}
          <span className="text-muted font-normal text-[11px] ml-0.5">
            — gap between spot and futures price
          </span>
        </>
      ),
      sub: (
        <>
          <PlatformLogo platform={basis.exchange} size={12} className="mr-1" />
          {basis.exchange} · {basis.contract}
        </>
      ),
      chip: 'cashable', valueTone: 'up',
      value: `+${basis.netAnnualized}%/yr`,
      unit:  basis.coinMargined ? 'basis · coin-margined' : 'executable basis',
      dayUsd1k: day1k, fallbackScore: day1k,
    });
  }

  if (prediction && prediction.cashable > 0) {
    rows.push({
      key: 'prediction', icon: '◎', tileColor: 'mint',
      name: 'Prediction arb',
      sub:  `${prediction.pairsChecked} pairs checked`,
      chip: 'cashable', valueTone: 'up',
      value: String(prediction.cashable),
      unit:  'cashable right now',
      // A count of opportunities, not a dollar amount — no $/day exists here either.
      dayUsd1k: null, fallbackScore: prediction.cashable,
    });
  }

  // Net $/day (per $1k) is the primary, comparable metric — rows with a
  // genuine one rank first, highest first. Rows with no real day-rate
  // (one-off event arbs, opportunity counts) rank after, by their own
  // native metric. No cap: every row that reached this point already
  // passed its own honest gate above, so all of them render.
  rows.sort((a, b) => {
    if (a.dayUsd1k !== null && b.dayUsd1k !== null) return b.dayUsd1k - a.dayUsd1k;
    if (a.dayUsd1k !== null) return -1;
    if (b.dayUsd1k !== null) return 1;
    return b.fallbackScore - a.fallbackScore;
  });
  return rows;
}

// ── One opportunity face (server-rendered; the cycling card toggles between
// these). Every field here is buildLiveRows() output — same props, untouched. ──
function CardFace({ row }: { row: LiveRow }) {
  const c = tierColor(row.chip);
  const label = TIER_LABEL[row.chip] ?? String(row.chip).toUpperCase();
  return (
    <div className={skin.cardFace}>
      <div className={skin.cardTopRow}>
        <span className={skin.chip} style={{ background: `${c}1f`, color: c }}>
          <span className={skin.chipDot} style={{ background: c }} />
          {label}
        </span>
      </div>
      <div className={skin.cardName}>{row.name}</div>
      {row.sub && <div className={skin.cardVenues}>{row.sub}</div>}
      <div className={skin.cardValue} style={{ color: c, textShadow: `0 0 24px ${c}66` }}>
        {row.value}
      </div>
      {row.unit && <div className={skin.cardUnit}>{row.unit}</div>}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function LandingPage() {
  const stats = readLandingStats();
  const liveRows = buildLiveRows(stats);
  // The one number that must be live: how many opportunities survived fee
  // adjustment tonight. Drives the copy, the field glow count, and the card.
  const count = liveRows.length;
  const tiers = liveRows.map(r => r.chip);

  return (
    <div className={`${instrument.variable} ${manrope.variable} ${plexMono.variable} ${skin.root}`}>

      {/* ── Nav ──────────────────────────────────────────────────────────── */}
      <header className={skin.nav}>
        <div className={skin.navRow}>
          <Link href="/" className={skin.brand} aria-label="Edgeradar home">
            <RadarMark size={22} />
            <span className={skin.brandName}>Edgeradar</span>
          </Link>
          <span className={skin.navSpacer} />
          <Link href="/auth/login" className={`${skin.navGhost} ${skin.hideSm}`}>Sign in</Link>
          <Link href="/auth/register" className={skin.btnFill} style={{ height: 38, padding: '0 18px' }}>
            Start free
          </Link>
        </div>
      </header>

      <main>

        {/* ── 1. HERO — the live field ──────────────────────────────────────── */}
        <section className={skin.hero} aria-labelledby="hero-heading">
          <HeroField count={count} tiers={tiers} />
          <div className={skin.vignette} aria-hidden />

          <div className={`${skin.heroInner} ${skin.rise}`}>

            {/* Copy */}
            <div className={skin.copy}>
              <span className={skin.eyebrow}>
                <span className={skin.eyebrowDot} aria-hidden />Scanning · Live
              </span>

              <h1 id="hero-heading" className={skin.h1}>
                {SCANNED_SCOPE} markets.<br />
                <span className={skin.dim}>Almost all of them</span><br />
                <span className={skin.it}>are worth nothing.</span>
              </h1>

              <p className={skin.sub}>
                {count > 0 ? (
                  <>
                    We measure every one, subtract every fee, and light up only the handful
                    that survive. Tonight that&apos;s <span className={skin.count}>{numberWord(count)}</span>.
                  </>
                ) : (
                  <>
                    We measure every one, subtract every fee, and light up only the handful
                    that survive. Tonight <span className={skin.count}>nothing</span> does — and
                    we show you exactly that.
                  </>
                )}
              </p>

              <div className={skin.ctaRow}>
                <Link href="/auth/register" className={skin.btnFill}>Start free</Link>
                <a href="#tonight" className={skin.btnGlass}>
                  {count > 0 ? `See tonight's ${numberWord(count)}` : 'See the empty field'}
                </a>
              </div>

              <div className={skin.tierRow}>
                <span className={skin.tier}>
                  <span className={skin.tierDot} style={{ background: '#2DD4A0' }} aria-hidden />
                  <span className={skin.tierName}>Cashable</span>
                  <span className={skin.tierSub}>locked profit</span>
                </span>
                <span className={skin.tier}>
                  <span className={skin.tierDot} style={{ background: '#F0A93B' }} aria-hidden />
                  <span className={skin.tierName}>Arb soft</span>
                  <span className={skin.tierSub}>real, fragile</span>
                </span>
                <span className={skin.tier}>
                  <span className={skin.tierDot} style={{ background: '#8B93F8' }} aria-hidden />
                  <span className={skin.tierName}>Signal</span>
                  <span className={skin.tierSub}>value, not locked</span>
                </span>
              </div>
            </div>

            {/* Live card — cycles the real opportunities from buildLiveRows() */}
            <CyclingCard
              tiers={tiers}
              caption="Every figure fee-adjusted and capacity-checked. We never touch your funds."
            >
              {liveRows.map(row => <CardFace key={row.key} row={row} />)}
            </CyclingCard>

          </div>
        </section>

        {/* ── 2. THE HONEST CUT — illustrative spike vs fee-adjusted ─────────── */}
        <section className={skin.cut} aria-label="How a raw spike looks versus fee-adjusted">
          <div className={skin.cutInner}>
            <span className={skin.illTag}>▚ Illustrative — how a spike looks raw vs fee-adjusted, not a live quote</span>
            <div className={skin.cutGrid}>

              <div className={skin.dead}>
                <div className={skin.cutLabel}>What a bot marketplace shows you</div>
                <div className={`${skin.cutBig} ${skin.cutBigDead}`}>1,914%</div>
                <div className={skin.cutRows}>
                  <div className={skin.cutRow}><span className={skin.cutKey}>7-day APR</span><span className={`${skin.cutVal} ${skin.cutValDead}`}>1,596%</span></div>
                  <div className={skin.cutRow}><span className={skin.cutKey}>30-day APR</span><span className={`${skin.cutVal} ${skin.cutValDead}`}>669%</span></div>
                  <div className={skin.cutRow}><span className={skin.cutKey}>Next funding</span><span className={`${skin.cutVal} ${skin.cutValDead}`}>−0.024% flipped</span></div>
                  <div className={skin.cutRow}><span className={skin.cutKey}>Depth at $10k</span><span className={`${skin.cutVal} ${skin.cutValDead}`}>not there</span></div>
                </div>
                <p className={skin.cutFoot}>The decay is the tell. It&apos;s a spike, annualised.</p>
              </div>

              <div className={skin.cutDivider} aria-hidden />

              <div className={skin.alive}>
                <div className={skin.cutLabel}>What Edgeradar shows you</div>
                <div className={`${skin.cutBig} ${skin.cutBigAlive}`}>+9.1%</div>
                <div className={skin.cutRows}>
                  <div className={skin.cutRow}><span className={skin.cutKey}>Funding</span><span className={skin.cutVal}>trailing settled</span></div>
                  <div className={skin.cutRow}><span className={skin.cutKey}>Fees</span><span className={skin.cutVal}>round-trip, subtracted</span></div>
                  <div className={skin.cutRow}><span className={skin.cutKey}>Capacity</span><span className={skin.cutVal}>real order-book depth</span></div>
                  <div className={skin.cutRow}><span className={skin.cutKey}>Over 200%/yr</span><span className={skin.cutVal}>capped, flagged</span></div>
                </div>
                <p className={`${skin.cutFoot} ${skin.cutFootAlive}`}>Boring. Executable. Yours.</p>
              </div>

            </div>
          </div>
        </section>

        {/* ── 3. CTA ────────────────────────────────────────────────────────── */}
        <section className={skin.ctaSection} aria-labelledby="cta-heading">
          <h2 id="cta-heading" className={skin.ctaTitle}>Put every edge on your radar.</h2>
          <Link href="/auth/register" className={skin.btnFill}>Start free</Link>
        </section>

      </main>

      {/* ── FOOTER ────────────────────────────────────────────────────────── */}
      <footer className={skin.footer}>
        <div className={skin.footRow}>
          <Link href="/" className={skin.brand} aria-label="Edgeradar home">
            <RadarMark size={16} />
            <span className={skin.brandName} style={{ fontSize: 16 }}>Edgeradar</span>
          </Link>
          <p className={skin.footText}>The honest edge radar · prediction markets &amp; crypto · not financial advice</p>
        </div>
      </footer>

    </div>
  );
}
