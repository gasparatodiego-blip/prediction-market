import fs from 'fs';
import Link from 'next/link';
import EdgeradarNav from '@/app/components/EdgeradarNav';
import Pill         from '@/app/components/ui/Pill';
import Eyebrow      from '@/app/components/ui/Eyebrow';
import SectionHeading from '@/app/components/ui/SectionHeading';
import EdgeChip     from '@/app/components/ui/EdgeChip';
import RadarMark    from '@/app/components/ui/RadarMark';
import RadarScope   from '@/app/components/ui/RadarScope';
import BlipRow      from '@/app/components/ui/BlipRow';
import StatCard     from '@/app/components/ui/StatCard';

export const dynamic = 'force-dynamic';

// ── Button-link class strings (same tokens as Button component) ────────────
const BTN_BASE =
  'inline-flex items-center justify-center font-body font-medium rounded-button ' +
  'transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-mint/50 select-none';
const BTN_PRIMARY_LG = 'bg-mint-deep text-white shadow-card hover:bg-mint px-6 py-3 text-base gap-2';
const BTN_GHOST_LG   = 'border border-line text-ink-2 hover:border-mint hover:text-mint-deep px-6 py-3 text-base gap-2';
const BTN_PRIMARY_MD = 'bg-mint-deep text-white shadow-card hover:bg-mint px-4 py-2 text-sm gap-1.5';

// ── Six ways data ──────────────────────────────────────────────────────────
const SIX_WAYS = [
  {
    chip:  'cashable' as const,
    title: 'Prediction arbitrage',
    desc:  'Same-outcome contracts priced differently on Kalshi and Polymarket. Both legs AI-verified, capacity-confirmed. A green badge means you can actually fill it.',
  },
  {
    chip:  'speculative' as const,
    title: 'Funding spreads',
    desc:  "Earn perpetual funding by holding long spot and short perp — or the reverse. Rates reset every 8 hours; no lockup, but no guarantee of tomorrow's rate.",
  },
  {
    chip:  'speculative' as const,
    title: 'Cash & carry',
    desc:  'Lock in the basis between spot and a dated futures contract. Yield is fixed at expiry — most contracts are coin-margined, so the USD return drifts with spot price.',
  },
  {
    chip:  'signal' as const,
    title: 'Liquidity rewards',
    desc:  "Provide liquidity to prediction market protocols and earn reward tokens. Program rates aren't in public APIs yet; we estimate from docs and flag anything we can't confirm.",
  },
  {
    chip:  'signal' as const,
    title: 'Top traders',
    desc:  "Every public Polymarket wallet ranked by true win rate, not just P&L. See who's actually skilled versus who rode a lucky streak. Worth watching — not a copy-trade signal.",
  },
  {
    chip:  'paper' as const,
    title: 'Sports edges',
    desc:  'Prediction market mispricing on NFL, NBA, and soccer outcomes. Midpoint prices only — no live CLOB. Verify before you act.',
  },
] as const;

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
interface FundingStat  { perDay1k: number; symbol: string; exchange: string; annPct: number }
interface PredStat     { cashable: number; pairsChecked: number }
interface BasisStat    { netAnnualized: number; asset: string; exchange: string; contract: string; coinMargined: boolean }

function readLandingStats(): { funding: FundingStat | null; prediction: PredStat | null; basis: BasisStat | null } {
  let funding: FundingStat | null    = null;
  let prediction: PredStat | null    = null;
  let basis: BasisStat | null        = null;

  try {
    const raw  = JSON.parse(fs.readFileSync('/tmp/arbitrage-opportunities.json', 'utf8'));
    const s    = raw?.stats ?? {};
    const cash = s.confirmedCashable ?? 0;
    const tot  = cash + (s.rejectedNotSameEvent ?? 0) + (s.pendingVerification ?? 0);
    prediction = { cashable: cash, pairsChecked: tot };
  } catch { /* file absent or stale — show zero state */ }

  try {
    const raw     = JSON.parse(fs.readFileSync('/tmp/exchange-prices.json', 'utf8'));
    const futures = (raw?.futures ?? {}) as Record<string, Record<string, { fundingRate?: number; fundingIntervalHours?: number }>>;
    const majorExchanges = ['binance', 'bybit', 'okx'];
    let best: FundingStat | null = null;
    for (const exc of majorExchanges) {
      const markets = futures[exc] ?? {};
      for (const sym of ['ETH', 'BTC', 'SOL']) {
        const info = markets[sym];
        if (!info || typeof info.fundingRate !== 'number') continue;
        const hrs     = info.fundingIntervalHours ?? 8;
        const perDay  = Math.abs(info.fundingRate) * (24 / hrs) * 1000;
        const annPct  = Math.abs(info.fundingRate) * (24 / hrs) * 365 * 100;
        if (!best || perDay > best.perDay1k) {
          best = { perDay1k: Math.round(perDay), symbol: sym, exchange: exc, annPct: Math.round(annPct) };
        }
      }
    }
    funding = best;
  } catch { /* file absent — show empty state */ }

  try {
    const raw  = JSON.parse(fs.readFileSync('/tmp/basis-opportunities.json', 'utf8'));
    const opps = (raw?.opportunities ?? []) as Array<{
      asset: string; exchange: string; contract: string;
      netAnnualizedExecutable?: number; netAnnualized?: number; coinMargined?: boolean;
    }>;
    const sorted = [...opps].sort((a, b) => (b.netAnnualizedExecutable ?? b.netAnnualized ?? 0) - (a.netAnnualizedExecutable ?? a.netAnnualized ?? 0));
    if (sorted.length > 0) {
      const top = sorted[0];
      basis = {
        netAnnualized: Math.round((top.netAnnualizedExecutable ?? top.netAnnualized ?? 0) * 1000) / 10,
        asset:         top.asset,
        exchange:      top.exchange,
        contract:      top.contract,
        coinMargined:  top.coinMargined ?? false,
      };
    }
  } catch { /* file absent — show empty state */ }

  return { funding, prediction, basis };
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function LandingPage() {
  const { funding, prediction, basis } = readLandingStats();

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
              <Pill>Prediction markets + crypto, on one radar</Pill>

              <SectionHeading
                id="hero-heading"
                as="h1"
                className="text-4xl sm:text-5xl leading-[1.1]"
              >
                Every edge on your radar —{' '}
                <span className="text-mint-deep bg-mint-tint px-1.5 rounded">honestly.</span>
              </SectionHeading>

              <p className="font-body text-base text-ink-2 leading-relaxed max-w-[46ch]">
                Arbitrage is just the start. Edgeradar tracks funding spreads, carry, liquidity
                rewards and the traders actually worth following — all fee-adjusted, all
                executable, and zero when there's nothing real.
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
                {['Arbitrage', 'Funding', 'Carry', 'Liquidity rewards', 'Top traders', 'Sports'].map(cap => (
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
                  <span className="font-body font-semibold text-sm text-ink">Scanning 11 markets</span>
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

                {/* Blip rows */}
                <div className="divide-y divide-line">
                  <BlipRow
                    icon="Ξ"
                    tileColor="mint"
                    name="ETH funding"
                    chip="cashable"
                    value="+$42"
                    unit="net / day"
                    valueTone="up"
                  />
                  <BlipRow
                    icon="↗"
                    tileColor="violet"
                    name="Top trader to watch"
                    chip="signal"
                    value="68%"
                    unit="true win rate"
                  />
                  <BlipRow
                    icon="◎"
                    tileColor="mint"
                    name="Prediction markets"
                    sub="No fake fills"
                    chip="paper"
                    value="0"
                    unit="cashable now"
                  />
                </div>

              </div>
            </div>

          </div>
        </section>

        {/* ── 2. SIX WAYS ───────────────────────────────────────────────────── */}
        <section
          id="what-it-finds"
          className="border-t border-line bg-bg-soft/50"
          aria-labelledby="six-ways-heading"
        >
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-20">
            <div className="mb-10">
              <Eyebrow className="mb-2">More than arbitrage</Eyebrow>
              <SectionHeading id="six-ways-heading" className="text-2xl sm:text-3xl">
                Six ways to find your edge
              </SectionHeading>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {SIX_WAYS.map(card => (
                <div
                  key={card.title}
                  className="bg-surface rounded-card shadow-card border border-line p-5 flex flex-col gap-3"
                >
                  <EdgeChip variant={card.chip} />
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

        {/* ── 4. TODAY SNAPSHOT ─────────────────────────────────────────────── */}
        <section
          id="today"
          className="border-t border-line bg-bg-soft/50"
          aria-labelledby="today-heading"
        >
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-20">
            <div className="mb-10">
              <Eyebrow className="mb-2">Today</Eyebrow>
              <SectionHeading id="today-heading" className="text-2xl sm:text-3xl">
                What's live right now
              </SectionHeading>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

              {/* Funding rate stat */}
              <StatCard
                label="Top funding rate"
                value={funding ? `$${funding.perDay1k}` : '—'}
                note={
                  funding
                    ? `net / day per $1k notional · ${funding.symbol} · ${funding.exchange}`
                    : 'No live funding data right now'
                }
                demoted={funding ? `est. ${funding.annPct}%/yr — rate variable` : undefined}
              />

              {/* Prediction cashable */}
              <StatCard
                label="Prediction cashable"
                value={prediction ? String(prediction.cashable) : '0'}
                note={
                  prediction && prediction.cashable > 0
                    ? `confirmed cashable pair${prediction.cashable !== 1 ? 's' : ''}`
                    : 'No confirmed arb right now'
                }
                demoted={prediction ? `${prediction.pairsChecked} pairs checked` : undefined}
              />

              {/* Carry basis */}
              <StatCard
                label="Best carry basis"
                value={basis ? `${basis.netAnnualized}%/yr` : '—'}
                note={
                  basis
                    ? `executable basis · ${basis.asset} · ${basis.exchange}`
                    : 'No carry data available'
                }
                demoted={
                  basis
                    ? basis.coinMargined
                      ? 'coin-margined — USD return not locked'
                      : 'indicative — verify before trading'
                    : undefined
                }
              />

            </div>
          </div>
        </section>

        {/* ── 5. FINAL CTA ──────────────────────────────────────────────────── */}
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
