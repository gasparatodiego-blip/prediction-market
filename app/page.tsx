import fs from 'fs';
import type { ReactNode } from 'react';
import Link from 'next/link';
import PlatformLogo from '@/components/PlatformLogo';
import EdgeradarNav from '@/app/components/EdgeradarNav';
import Pill         from '@/app/components/ui/Pill';
import Eyebrow      from '@/app/components/ui/Eyebrow';
import SectionHeading from '@/app/components/ui/SectionHeading';
import { type EdgeChipVariant } from '@/app/components/ui/EdgeChip';
import RadarMark    from '@/app/components/ui/RadarMark';
import RadarScope   from '@/app/components/ui/RadarScope';
import BlipRow      from '@/app/components/ui/BlipRow';
import AnimatedStrategies from '@/app/components/landing/AnimatedStrategies';
import { getCryptoSpreadsData, calcSpreadSizing } from '@/lib/spread-compute';
import { scaleToCapitalBasis, LANDING_CAPITAL_BASIS } from '@/lib/honest-display';
import { isSaneKalshiMarket, isSanePolymarketLevel } from '@/lib/reward-gating';

export const dynamic = 'force-dynamic';

// ── Button-link class strings (same tokens as Button component) ────────────
const BTN_BASE =
  'inline-flex items-center justify-center font-body font-medium rounded-button ' +
  'transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-mint/50 select-none';
const BTN_PRIMARY_LG = 'bg-mint-deep text-white shadow-card hover:bg-mint px-6 py-3 text-base gap-2';
const BTN_GHOST_LG   = 'border border-line text-ink-2 hover:border-mint hover:text-mint-deep px-6 py-3 text-base gap-2';
const BTN_PRIMARY_MD = 'bg-mint-deep text-white shadow-card hover:bg-mint px-4 py-2 text-sm gap-1.5';

// ── Honest engine data ─────────────────────────────────────────────────────
const HONEST_ENGINE = [
  {
    title: 'Executable prices only',
    desc:  "Every spread uses live bid/ask from real CLOBs. No midpoints, no indicative quotes. If an executable price isn't available, the opportunity disappears.",
  },
  {
    title: 'Fees already subtracted',
    desc:  "All numbers are net of trading, withdrawal, and protocol fees. The headline figure is what you'd actually pocket — not what the model thinks you could earn.",
  },
  {
    title: 'Zero means zero',
    desc:  "When nothing is confirmed cashable, we show zero and say so. We don't fill the screen with speculative signals just to look busy.",
  },
] as const;

// ── Server-side stats ──────────────────────────────────────────────────────
interface FundingStat  { dayUsd1k: number; coin: string; shortExchange: string; longExchange: string; netApy30d: number }
interface PredStat     { cashable: number; pairsChecked: number }
interface BasisStat    { netAnnualized: number; asset: string; exchange: string; contract: string; coinMargined: boolean }
interface SportsStat   { netMargin: number; homeTeam: string; awayTeam: string; sport: string }
interface RewardsStat  { grossRewardDayRaw: number; dayYieldPct: number; capital: number; platform: string }

interface LiveRow {
  key:        string;
  icon:       string;
  tileColor:  'mint' | 'violet' | 'gold';
  name:       ReactNode;
  sub?:       ReactNode;
  chip:       EdgeChipVariant;
  value:      string;
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
    // Same pipeline the funding-arb dashboard uses (lib/spread-compute.ts) — no
    // parallel fundingRate math here. Only a spread that's verified + liquid
    // (the dashboard's own 'cashable' condition) is eligible for the landing.
    const { spreads } = getCryptoSpreadsData();
    const sane = spreads.find(s => !s.oneLegUnverified && !s.thinFlag && !s.depthThin);
    // This reads getCryptoSpreadsData() directly (not through the paid-gated
    // /api/crypto route), so sane.netApy30d is never redacted here — the null
    // check is just type hygiene after widening SpreadItem for the dashboard.
    const sizing = sane ? calcSpreadSizing(sane, 1000, 1) : null;
    if (sane && sizing && sane.netApy30d != null) {
      funding = {
        dayUsd1k:      Math.round(sizing.dayUsd * 100) / 100,
        coin:          sane.coin,
        shortExchange: sane.shortExchange,
        longExchange:  sane.longExchange,
        netApy30d:     sane.netApy30d,
      };
    }
  } catch { /* file absent */ }

  try {
    const raw  = JSON.parse(fs.readFileSync('/tmp/basis-opportunities.json', 'utf8'));
    const opps = (raw?.opportunities ?? []) as Array<{
      asset: string; exchange: string; contract: string;
      netAnnualizedExecutable?: number; netAnnualized?: number; coinMargined?: boolean;
    }>;
    const sorted = [...opps]
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
    // Capital tiers as actually keyed in the agent output (matches the
    // liquidity-rewards dashboard's CAPITAL_OPTIONS). A market only qualifies
    // at a tier if it passes the SAME sane-market gate the dashboard uses —
    // TRAP / SHORT_BURST / THIN_CAP / BELOW_FLOOR / ONE_SIDED / WARN all disqualify.
    const CAPITAL_TIERS = ['500', '5000', '50000'];
    let bestReward: RewardsStat | null = null;

    // Polymarket
    const polyRaw  = JSON.parse(fs.readFileSync('/root/prediction-market/data/liquidity-rewards.json', 'utf8'));
    const polyMkts = (polyRaw?.markets ?? []) as Array<{
      levels: Record<string, { grossRewardDay?: number; dayYieldPct?: number; flags?: string[] }>;
    }>;
    for (const m of polyMkts) {
      for (const capStr of CAPITAL_TIERS) {
        const lv = m.levels?.[capStr];
        if (!lv || !lv.grossRewardDay) continue;
        if (!isSanePolymarketLevel({ flags: lv.flags ?? [] })) continue;
        const score = (lv.dayYieldPct ?? 0) * 365;
        if (!bestReward || score > bestReward.dayYieldPct * 365) {
          bestReward = { grossRewardDayRaw: lv.grossRewardDay, dayYieldPct: lv.dayYieldPct ?? 0, capital: +capStr, platform: 'Polymarket' };
        }
        break;
      }
    }

    // Kalshi
    const kalshiRaw  = JSON.parse(fs.readFileSync('/root/prediction-market/data/kalshi-rewards.json', 'utf8'));
    const kalshiMkts = (kalshiRaw?.markets ?? []) as Array<{
      flags: { TRAP: boolean; SHORT_BURST: boolean; BELOW_FLOOR: boolean; THIN_CAP: boolean; ONE_SIDED: boolean };
      last_price: number;
      levels: Record<string, { aboveMin?: boolean; grossRewardDay?: number; dayYieldPct?: number }>;
    }>;
    for (const m of kalshiMkts) {
      for (const capStr of CAPITAL_TIERS) {
        const lv = m.levels?.[capStr];
        if (!lv || !lv.grossRewardDay) continue;
        if (!isSaneKalshiMarket(m, capStr)) continue;
        const score = (lv.dayYieldPct ?? 0) * 365;
        if (!bestReward || score > bestReward.dayYieldPct * 365) {
          bestReward = { grossRewardDayRaw: lv.grossRewardDay, dayYieldPct: lv.dayYieldPct ?? 0, capital: +capStr, platform: 'Kalshi' };
        }
        break;
      }
    }

    rewards = bestReward;
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

  if (rewards && rewards.grossRewardDayRaw > 0) {
    // Same sane-market gate as the liquidity-rewards dashboard already excluded
    // TRAP/burst/thin markets above, so this is a real, gated estimate — an
    // explicit product call from Diego marks it cashable on the landing row
    // even though the dashboard itself keeps the OBSERVED-model caveat.
    const day1k = scaleToCapitalBasis(rewards.grossRewardDayRaw, rewards.capital, LANDING_CAPITAL_BASIS);
    rows.push({
      key: 'rewards', icon: '◈', tileColor: 'violet',
      name: (
        <>
          <PlatformLogo platform={rewards.platform} size={14} className="mr-1.5" />
          {rewards.platform} maker rewards{' '}
          <span className="text-muted font-normal text-[11px] ml-0.5">
            — paid for providing liquidity
          </span>
        </>
      ),
      chip: 'cashable', valueTone: 'up',
      value: `+$${day1k.toFixed(2)}`,
      unit:  'net/day per $1k',
      dayUsd1k: day1k, fallbackScore: day1k,
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

// ── Page ───────────────────────────────────────────────────────────────────
export default function LandingPage() {
  const stats = readLandingStats();
  const liveRows = buildLiveRows(stats);

  return (
    <div className="min-h-screen">
      <EdgeradarNav />

      <main>

        {/* ── 1. HERO ───────────────────────────────────────────────────────── */}
        <section
          className="max-w-6xl mx-auto px-4 sm:px-6 pt-16 pb-20 sm:pt-24 sm:pb-28"
          aria-labelledby="hero-heading"
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center">

            {/* Left col */}
            <div className="space-y-6 lg:max-w-xl">
              <SectionHeading
                id="hero-heading"
                as="h1"
                className="text-4xl sm:text-5xl leading-[1.1]"
              >
                Every edge on your radar —{' '}
                <span className="text-mint-deep bg-mint-tint px-1.5 rounded">honestly.</span>
              </SectionHeading>

              <p className="font-body text-base text-ink-2 leading-relaxed max-w-[46ch]">
                Edgeradar scans prediction markets, crypto exchanges and sportsbooks for real,
                fee-adjusted edges — and shows you only the ones you can actually act on. It
                tracks funding spreads, carry, liquidity rewards and the traders actually worth
                following, and shows zero when there's nothing real.
              </p>

              <div className="flex flex-wrap gap-3 pt-1">
                <Link
                  href="/auth/register"
                  className={`${BTN_BASE} ${BTN_PRIMARY_LG}`}
                >
                  Start free
                </Link>
                <a
                  href="#what-it-finds"
                  className={`${BTN_BASE} ${BTN_GHOST_LG}`}
                >
                  See what it finds
                </a>
              </div>

              {/* Capability strip */}
              <div className="flex flex-wrap gap-2 pt-1" role="list" aria-label="Edge types covered">
                {['Arbitrage', 'Funding', 'Cash & carry', 'Liquidity rewards', 'Top traders', 'Sports'].map(cap => (
                  <span key={cap} role="listitem">
                    <Pill>{cap}</Pill>
                  </span>
                ))}
              </div>
            </div>

            {/* Right col — live demo card */}
            <div className="w-full max-w-sm mx-auto lg:max-w-none">
              <div className="bg-surface rounded-panel shadow-card border border-line overflow-hidden">

                {/* Card header */}
                <div className="px-4 py-3 border-b border-line flex items-center gap-2">
                  <RadarMark size={18} />
                  <span className="font-body font-semibold text-sm text-ink">Here&apos;s what&apos;s live inside</span>
                </div>

                {/* Radar visual */}
                <div className="flex justify-center items-center py-8 bg-bg-soft/40">
                  <RadarScope
                    size={170}
                    blips={[
                      { top: '32%', left: '68%', color: 'mint'   },
                      { top: '62%', left: '28%', color: 'violet' },
                      { top: '72%', left: '62%', color: 'gold'   },
                    ]}
                  />
                </div>

                {/* Blip rows — real opportunities only */}
                <div className="divide-y divide-line">
                  {liveRows.length > 0 ? (
                    liveRows.map(row => (
                      <BlipRow
                        key={row.key}
                        icon={row.icon}
                        tileColor={row.tileColor}
                        name={row.name}
                        sub={row.sub}
                        chip={row.chip}
                        value={row.value}
                        unit={row.unit}
                        valueTone={row.valueTone}
                      />
                    ))
                  ) : (
                    <BlipRow
                      icon="◎"
                      tileColor="mint"
                      name="Scanning markets"
                      sub="checking all sources now"
                      chip="signal"
                      value="—"
                      unit="no edge confirmed yet"
                    />
                  )}
                </div>

              </div>
            </div>

          </div>
        </section>

        {/* ── 2. SIX WAYS — ANIMATED STRATEGIES ────────────────────────────── */}
        <AnimatedStrategies />

        {/* ── 3. HONEST ENGINE ─────────────────────────────────────────────── */}
        <section
          id="why-honest"
          className="border-t border-line"
          aria-labelledby="honest-heading"
        >
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-20">
            <div className="mb-10">
              <Eyebrow className="mb-2">The honest engine</Eyebrow>
              <SectionHeading id="honest-heading" className="text-2xl sm:text-3xl">
                You see what we see — nothing more
              </SectionHeading>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {HONEST_ENGINE.map(card => (
                <div
                  key={card.title}
                  className="bg-surface rounded-card shadow-card border border-line p-6 flex flex-col gap-4"
                >
                  <div
                    className="w-8 h-8 rounded-[10px] bg-mint-tint flex items-center justify-center flex-shrink-0"
                    aria-hidden
                  >
                    <span className="text-mint-deep font-body font-bold text-sm">✓</span>
                  </div>
                  <div>
                    <h3 className="font-display font-semibold text-[15px] text-ink mb-1.5 leading-snug">
                      {card.title}
                    </h3>
                    <p className="font-body text-[13px] text-ink-2 leading-relaxed">
                      {card.desc}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── 4. FINAL CTA ──────────────────────────────────────────────────── */}
        <section className="border-t border-line" aria-labelledby="cta-heading">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-20 sm:py-28 text-center">
            <SectionHeading
              id="cta-heading"
              centered
              className="text-2xl sm:text-3xl mb-8"
            >
              Put every edge on your radar.
            </SectionHeading>
            <Link
              href="/auth/register"
              className={`${BTN_BASE} ${BTN_PRIMARY_MD} !px-8 !py-3.5 !text-base`}
            >
              Start free
            </Link>
          </div>
        </section>

      </main>

      {/* ── FOOTER ────────────────────────────────────────────────────────── */}
      <footer className="border-t border-line">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <RadarMark size={16} />
            <span className="font-display font-bold text-ink text-[15px]">Edgeradar</span>
          </div>
          <p className="font-body text-[12px] text-muted text-center sm:text-right">
            Edgeradar — the honest edge radar · prediction markets &amp; crypto
          </p>
        </div>
      </footer>

    </div>
  );
}
