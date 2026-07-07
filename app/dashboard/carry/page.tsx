'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { RefreshCw, TrendingDown } from 'lucide-react';
import Eyebrow from '@/app/components/ui/Eyebrow';
import SectionHeading from '@/app/components/ui/SectionHeading';
import StatCard from '@/app/components/ui/StatCard';
import BlipRow from '@/app/components/ui/BlipRow';
import EdgeChip, { type EdgeChipVariant } from '@/app/components/ui/EdgeChip';
import PlatformLogo from '@/components/PlatformLogo';
import { Redacted } from '@/app/components/ui/Redacted';
import { PlatformLink } from '@/app/components/ui/PlatformLink';
import { VerifyBadge } from '@/app/components/ui/VerifyBadge';
import { venueFutureUrl } from '@/lib/platform-links';

// ── Types ─────────────────────────────────────────────────────────────────────
// Derived basis/annualized/capacity fields are null on free tier (server-side
// redaction, lib/paid-gating.ts). Raw spot/future/bid/ask prices, volume, and
// descriptive fields stay real for everyone — see REDACTION_MAP.carry.

interface Contract {
  asset:                   string;
  exchange:                string;
  venueKey:                string;
  contract:                string;
  expiry:                  string;
  daysToExpiry:            number;
  spot:                    number;
  future:                  number;
  futureLast:              number | null;
  spotBid:                 number | null;
  spotAsk:                 number | null;
  futureBid:               number | null;
  futureAsk:               number | null;
  indicativeBasisPct:      number | null;
  executableBasisPct:      number | null;
  basis:                   number | null;
  grossAnnualized:         number | null;
  grossAnnualizedExec:     number | null;
  fee:                     number;
  netAnnualizedIndicative: number | null;
  netAnnualizedExecutable: number | null;
  netAnnualized:           number | null;
  vol24Usd:                number;
  oiUsd:                   number | null;
  capacityUsd:             number | null;
  tier:                    string;
  thinFlag:                boolean;
  coinMargined:            boolean;
  coinMarginedNote:        string | null;
  bidSpreadPct:            number | null;
  // prose headline embeds the exact netAnnualizedExecutable % — redacted
  // together with the numeric fields (server-side, lib/paid-gating.ts)
  verdict:                 string | null;
}

interface BackwardContract {
  asset:               string;
  exchange:            string;
  contract:            string;
  expiry:              string;
  daysToExpiry:        number;
  spot:                number;
  future:              number;
  spotAsk:             number | null;
  futureBid:           number | null;
  indicativeBasisPct:  number | null;
  executableBasisPct:  number | null;
  basis:               number | null;
  annualized:          number | null;
  vol24Usd:            number;
  signal:              string;
}

interface Summary {
  count:             number;
  bestNetAnnualized: number | null;
  bestContract:      string | null;
  bestExchange:      string | null;
  bestAsset:         string | null;
}

interface CarryData {
  agentStatus:   'running' | 'stale' | 'offline';
  updatedAt:     string | null;
  opportunities: Contract[];
  backwardation: BackwardContract[];
  summary:       Summary;
  spot:          Record<string, number | null>;
  disclaimer:    string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const APY_CAP = 2.0; // 200%/yr cap

function capApy(n: number): { display: number; capped: boolean } {
  return n > APY_CAP
    ? { display: APY_CAP, capped: true }
    : { display: n,       capped: false };
}

function fmtAnnualized(n: number, prefix = '+'): string {
  const { display } = capApy(n);
  const sign = display >= 0 ? prefix : '';
  return `${sign}${(display * 100).toFixed(2)}%`;
}

function fmtK(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

function fmtPrice(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtAge(iso: string | null): string {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.round(s)}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

function coinEmoji(asset: string): string {
  if (asset === 'BTC') return '₿';
  if (asset === 'ETH') return 'Ξ';
  if (asset === 'BNB') return '◆';
  if (asset === 'SOL') return '◎';
  return '○';
}

function chipVariant(c: Contract): EdgeChipVariant {
  if (c.executableBasisPct == null) return 'signal'; // redacted — don't overclaim
  if (c.executableBasisPct <= 0) return 'signal';
  if (c.thinFlag || c.coinMargined) return 'speculative';
  return 'cashable';
}

// ── Skeletons ─────────────────────────────────────────────────────────────────

function CardSkeleton() {
  return (
    <div className="rounded-card shadow-card bg-surface px-5 py-5 animate-pulse">
      <div className="h-3 w-24 bg-bg-soft rounded mb-3" />
      <div className="h-8 w-16 bg-bg-soft rounded" />
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="rounded-card shadow-card bg-surface px-4 py-3 animate-pulse">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-bg-soft rounded-[11px] flex-shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="h-3 bg-bg-soft rounded w-2/3" />
          <div className="h-2.5 bg-bg-soft rounded w-1/2" />
        </div>
        <div className="w-14 h-5 bg-bg-soft rounded" />
      </div>
    </div>
  );
}

// ── Contango card ─────────────────────────────────────────────────────────────

function ContangoCard({ c }: { c: Contract }) {
  const variant    = chipVariant(c);
  const tileColor  = variant === 'cashable' ? 'mint' : 'gold';

  // Honest-engine: flag invariant violation (should not occur in production data)
  const invariantViolated = c.executableBasisPct != null && c.indicativeBasisPct != null
    && c.executableBasisPct > c.indicativeBasisPct + 0.0001;
  const isCapped = (c.netAnnualizedExecutable != null && capApy(c.netAnnualizedExecutable).capped)
    || (c.netAnnualizedIndicative != null && capApy(c.netAnnualizedIndicative).capped);

  const spotPx   = c.spotAsk  ?? c.spot;
  const futurePx = c.futureBid ?? c.future;

  const chips: { label: string; value: ReactNode }[] = [
    { label: 'spot ask',   value: fmtPrice(spotPx) },
    { label: 'future bid', value: fmtPrice(futurePx) },
    { label: 'exec basis', value: <Redacted value={c.executableBasisPct}>{v => `+${(v * 100).toFixed(2)}%`}</Redacted> },
    { label: 'capacity',   value: <Redacted value={c.capacityUsd}>{v => fmtK(v)}</Redacted> },
    { label: 'vol 24h',    value: fmtK(c.vol24Usd) },
    { label: 'exp',        value: c.expiry },
  ];

  return (
    <div className="rounded-card shadow-card bg-surface overflow-hidden">
      {/* Header row via BlipRow */}
      <BlipRow
        icon={coinEmoji(c.asset)}
        tileColor={tileColor}
        name={<>{c.asset} — <PlatformLogo platform={c.exchange} size={12} className="mx-1" />{c.exchange} · {c.contract} · {c.daysToExpiry}d{(() => { const u = venueFutureUrl(c.venueKey || c.exchange, c.contract); return u ? <PlatformLink href={u} label={c.exchange} compact className="ml-1.5 align-middle" /> : null; })()}</>}
        sub={<>spot ask {fmtPrice(spotPx)} · future bid {fmtPrice(futurePx)} · cap <Redacted value={c.capacityUsd}>{v => fmtK(v)}</Redacted></>}
        chip={variant}
        value={<Redacted value={c.netAnnualizedExecutable}>{v => fmtAnnualized(v)}</Redacted>}
        unit="net/yr executable"
        valueTone={variant === 'cashable' ? 'up' : 'neutral'}
      />

      {/* Detail panel */}
      <div className="px-4 pb-4 space-y-3">

        <VerifyBadge v={(c as any).__verify} />

        {/* Invariant violation flag */}
        {invariantViolated && (
          <div className="px-3 py-2 rounded-md bg-coral-tint border border-coral-ink/20 font-body text-[11px] text-coral-ink">
            Invariant flag: executable ({(c.executableBasisPct! * 100).toFixed(2)}%) exceeds indicative ({(c.indicativeBasisPct! * 100).toFixed(2)}%) — verify source data
          </div>
        )}

        {/* Indicative demoted row */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 items-center">
          <span className="font-body text-[12px] text-muted">
            Indicative mid:{' '}
            <span className="text-ink-2"><Redacted value={c.netAnnualizedIndicative}>{v => fmtAnnualized(v)}</Redacted>/yr</span>
            <span className="text-muted/60 ml-1 text-[11px]">(exec ≤ indicative ✓)</span>
          </span>
          {isCapped && (
            <span className="font-body text-[11px] text-gold">† run-rate, not guaranteed — capped at 200%/yr display</span>
          )}
        </div>

        {/* Detail chips */}
        <div className="flex flex-wrap gap-2">
          {chips.map(({ label, value }) => (
            <div
              key={label}
              className="flex items-center gap-1.5 font-body text-[11px] px-2.5 py-1 rounded-md bg-bg-soft border border-line"
            >
              <span className="text-muted">{label}</span>
              <span className="text-ink-2 font-medium">{value}</span>
            </div>
          ))}
        </div>

        {/* Verdict */}
        <p className="font-body text-[12px] text-muted leading-relaxed">
          <Redacted value={c.verdict}>{v => v}</Redacted>
        </p>

        {/* Coin-margined caveat — always shown when applicable */}
        {c.coinMargined && (
          <div className="px-3 py-2 rounded-md bg-gold-tint border border-gold/25 font-body text-[12px] text-gold">
            Coin-settled: USD return drifts with spot price — this is not a locked USD yield.
            {c.coinMarginedNote ? ` ${c.coinMarginedNote}` : ''}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Backwardation row ─────────────────────────────────────────────────────────

function BackwardRow({ c }: { c: BackwardContract }) {
  return (
    <div className="rounded-card shadow-card bg-surface overflow-hidden">
      <BlipRow
        icon={coinEmoji(c.asset)}
        tileColor="violet"
        name={<>{c.asset} — <PlatformLogo platform={c.exchange} size={12} className="mx-1" />{c.exchange} · {c.contract} · {c.daysToExpiry}d{(() => { const u = venueFutureUrl(c.exchange, c.contract); return u ? <PlatformLink href={u} label={c.exchange} compact className="ml-1.5 align-middle" /> : null; })()}</>}
        sub={`spot ${fmtPrice(c.spot)} · future ${fmtPrice(c.future)} · vol ${fmtK(c.vol24Usd)}`}
        chip="signal"
        value={<Redacted value={c.annualized}>{v => `${(v * 100).toFixed(2)}%`}</Redacted>}
        unit="backwardation basis"
        valueTone="neutral"
      />
      {c.signal && (
        <p className="px-4 pb-4 font-body text-[12px] text-muted leading-relaxed">{c.signal}</p>
      )}
    </div>
  );
}

// ── Honesty block ─────────────────────────────────────────────────────────────

const DISCLOSURES = [
  {
    label: 'Locked only at expiry.',
    body:  'The basis return is fixed at entry IF you hold the spot + futures position until contract expiry on the same exchange. Closing early re-buys the future at an unknown price — the locked return disappears.',
  },
  {
    label: 'USDT-M only = clean USD.',
    body:  'Only Binance USDT-M quarterly contracts (e.g. BTCUSDT_260925) settle in USDT — your USD P&L is fully locked. Binance COIN-M, OKX BTC-USD, and OKX ETH-USD settle in the coin: if BTC falls 10% your USD return shrinks by ~10% even though the basis held.',
  },
  {
    label: 'Capacity is an estimate.',
    body:  'Capacity = min(5% of 24h vol, 2% of OI, $500k). It represents a rough execution bound — actual fill at size may move the basis. BNB is hard-capped at $50k due to thinner markets.',
  },
  {
    label: 'Quiet markets, thin basis.',
    body:  "Annualized basis of 1–4% reflects today's contango. Basis widens with volatility and fear — in calm markets it compresses toward funding rates. The number you see is today's snapshot, not a long-run yield.",
  },
  {
    label: 'Not financial advice.',
    body:  'Exchange / counterparty risk over the full hold period. Read-only scanner — no orders placed, no position held. Verify all numbers on-exchange before trading.',
  },
];

function HonestyBlock() {
  return (
    <div className="rounded-card shadow-card bg-surface px-5 py-5">
      <p className="font-body text-[11px] uppercase tracking-wide text-muted mb-4">Honesty disclosures</p>
      <div className="space-y-3">
        {DISCLOSURES.map(({ label, body }) => (
          <div key={label} className="flex gap-3">
            <span className="shrink-0 text-muted font-body text-[12px] mt-0.5">—</span>
            <p className="font-body text-[12px] text-muted leading-relaxed">
              <span className="text-ink-2 font-medium">{label}</span>{' '}{body}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CarryPage() {
  const [data,    setData]    = useState<CarryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch('/api/carry');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const isRunning  = data?.agentStatus === 'running';
  const isStale    = data?.agentStatus === 'stale';
  const isOffline  = data?.agentStatus === 'offline';

  const cleanOpps  = data?.opportunities.filter(c => !c.coinMargined) ?? [];
  const coinOpps   = data?.opportunities.filter(c => c.coinMargined)  ?? [];

  // Best clean-USD executable return (for headline StatCard) — filter nulls
  // (redacted, free tier) before Math.max, which would otherwise coerce a
  // null to 0 and fabricate a "0%" best return if every row were redacted.
  const cleanExecVals = cleanOpps.map(c => c.netAnnualizedExecutable).filter((v): v is number => v != null);
  const bestClean  = cleanExecVals.length > 0 ? Math.max(...cleanExecVals) : null;
  const bestOverall = data?.summary.bestNetAnnualized ?? null;
  const bestDisplay = bestClean ?? bestOverall;

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-8">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <Eyebrow className="mb-1">Cash &amp; Carry</Eyebrow>
          <SectionHeading as="h1" className="text-2xl">
            Spot + Dated Futures Basis
          </SectionHeading>
          <p className="font-body text-sm text-muted mt-1">
            BTC · ETH · BNB — Binance COIN-M + USDT-M · OKX · Deribit · refreshes every 5 min
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data?.updatedAt && (
            <span className="font-body text-[12px] text-muted">
              {fmtAge(data.updatedAt)}
            </span>
          )}
          <button
            onClick={load}
            aria-label="Refresh"
            className="p-2 rounded-button border border-line text-muted hover:text-ink-2 hover:border-mint/40 transition-colors duration-150"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* ── Context lede ────────────────────────────────────────────────────── */}
      <p className="font-body text-sm text-muted leading-relaxed mb-6 max-w-3xl">
        Buy spot and simultaneously short a dated (quarterly / March / December) futures contract.
        At expiry the futures price converges to spot — you capture the basis locked in at entry.
        Return is <span className="text-ink-2 font-medium">deterministic</span> (known at entry) if held to expiry,
        unlike variable funding rates.
        7 filters applied: days to expiry, volume, net-of-fee basis, XPERP exclusion, backwardation signal,
        coin-margin label, capacity estimate.
      </p>

      {/* ── Agent status / error banners ────────────────────────────────────── */}
      {error && (
        <div className="mb-4 px-4 py-3 rounded-card border border-coral-ink/25 bg-coral-tint font-body text-sm text-coral-ink">
          {error}
        </div>
      )}
      {isStale && (
        <div className="mb-4 px-4 py-3 rounded-card border border-gold/25 bg-gold-tint font-body text-sm text-gold">
          Data is stale — agent19-basis may have missed a run. Last update: {fmtAge(data?.updatedAt ?? null)}
        </div>
      )}
      {isOffline && !loading && (
        <div className="mb-4 px-4 py-3 rounded-card border border-line bg-surface font-body text-sm text-muted">
          agent19-basis offline —{' '}
          <code className="text-ink-2 font-mono text-[12px]">pm2 start agents/ecosystem.config.js --only agent19-basis</code>
        </div>
      )}

      {/* ── Stats strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {loading && !data ? (
          Array.from({ length: 4 }).map((_, i) => <CardSkeleton key={i} />)
        ) : (
          <>
            <StatCard
              label="Best net/yr (executable)"
              value={bestDisplay != null ? fmtAnnualized(bestDisplay) : '—'}
              note={
                bestDisplay != null
                  ? `${data?.summary.bestAsset ?? ''} · ${data?.summary.bestExchange ?? ''}`
                  : 'no qualifying contracts'
              }
              demoted={bestDisplay != null && !cleanOpps.some(c => !c.coinMargined) ? 'coin-settled — USD return drifts' : undefined}
            />
            <StatCard
              label="Contracts qualifying"
              value={`${data?.opportunities.length ?? 0}`}
              note={`${cleanOpps.length} clean USD · ${coinOpps.length} coin-margined`}
            />
            <StatCard
              label="Backwardation"
              value={`${data?.backwardation.length ?? 0}`}
              note="futures below spot — carry inverted"
            />
            <StatCard
              label="Agent"
              value={isRunning ? 'Live' : isStale ? 'Stale' : 'Offline'}
              note={data?.updatedAt ? fmtAge(data.updatedAt) : 'no data'}
            />
          </>
        )}
      </div>

      {/* Spot prices strip */}
      {data?.spot && Object.keys(data.spot).length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 mb-6">
          {Object.entries(data.spot).map(([asset, price]) =>
            price != null ? (
              <span key={asset} className="font-body text-[12px] text-muted">
                {asset}{' '}
                <span className="text-ink-2 font-medium">
                  ${(price as number).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </span>
              </span>
            ) : null
          )}
        </div>
      )}

      {/* ── Loading ──────────────────────────────────────────────────────────── */}
      {loading && !data && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => <RowSkeleton key={i} />)}
        </div>
      )}

      {/* ── SECTION 1: Contango ─────────────────────────────────────────────── */}
      {data && data.opportunities.length > 0 && (
        <section className="mb-8">
          <div className="flex items-center gap-2 mb-4">
            <EdgeChip variant="cashable" />
            <span className="font-body text-[12px] text-muted">
              Contango — standard cash &amp; carry ({data.opportunities.length} contract{data.opportunities.length !== 1 ? 's' : ''})
            </span>
          </div>

          {/* Clean USD first */}
          {cleanOpps.length > 0 && (
            <div className="space-y-3 mb-5">
              <p className="font-body text-[11px] uppercase tracking-wide text-muted">
                Clean USD return — USDT-M / Deribit cash-settled
              </p>
              {cleanOpps.map(c => (
                <ContangoCard key={`${c.exchange}:${c.contract}`} c={c} />
              ))}
            </div>
          )}

          {/* Coin-margined */}
          {coinOpps.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <EdgeChip variant="speculative" />
                <p className="font-body text-[11px] text-muted">
                  Coin-margined — P&amp;L settles in{' '}
                  {coinOpps.map(c => c.asset).filter((v, i, a) => a.indexOf(v) === i).join('/')}
                  {' '}· USD return drifts with spot
                </p>
              </div>
              <div className="space-y-3">
                {coinOpps.map(c => (
                  <ContangoCard key={`${c.exchange}:${c.contract}`} c={c} />
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {data && data.opportunities.length === 0 && isRunning && (
        <div className="rounded-card shadow-card bg-surface px-6 py-12 text-center mb-8">
          <p className="font-display font-bold text-4xl text-ink mb-3">0</p>
          <p className="font-body text-base text-muted">
            No qualifying contango contracts right now — all filtered by the 7 criteria
          </p>
        </div>
      )}

      {/* ── SECTION 2: Backwardation ─────────────────────────────────────────── */}
      {data && data.backwardation.length > 0 && (
        <section className="mb-8">
          <div className="flex items-center gap-2 mb-3">
            <EdgeChip variant="signal" />
            <span className="font-body text-[12px] text-muted">
              Backwardation — futures below spot ({data.backwardation.length})
            </span>
          </div>
          <p className="font-body text-[12px] text-muted leading-relaxed mb-4">
            Futures trade below spot — basis is negative. Standard cash &amp; carry loses money here.
            Typically driven by staking yield (SOL ~7%/yr) or strong spot demand. Reverse carry (short spot + long future)
            collects the basis but requires borrowing the coin.
          </p>
          <div className="space-y-3">
            {data.backwardation.map(c => (
              <BackwardRow key={`${c.exchange}:${c.contract}`} c={c} />
            ))}
          </div>
        </section>
      )}

      {/* ── Honesty block ───────────────────────────────────────────────────── */}
      <div className="mb-8">
        <HonestyBlock />
      </div>

      {/* ── Methodology collapsible ─────────────────────────────────────────── */}
      <details className="mb-6 rounded-card shadow-card bg-surface px-5 py-4">
        <summary className="cursor-pointer font-body text-[12px] uppercase tracking-wide text-muted hover:text-ink-2 transition-colors select-none">
          Engine filters &amp; methodology
        </summary>
        <div className="mt-4 font-body text-[12px] text-muted leading-relaxed space-y-1.5 border-l-2 border-line pl-4">
          <p>1. daysToExpiry ≥ 20 days (too-near-expiry excluded)</p>
          <p>2. vol24h ≥ $500k → DEEP/OK; ≥ $100k → THIN (flagged); &lt; $100k → excluded</p>
          <p>3. netAnnualized = (basis − fees) × 365/days &gt; 0 (after fees, positive carry only)</p>
          <p>4. OKX symbols with XPERP excluded (extended perpetuals to Apr 2031, not delivery futures)</p>
          <p>5. basis &lt; 0 → backwardation[], not opportunities[]</p>
          <p>6. COIN-M / OKX BTC-USD / ETH-USD labeled COIN-MARGINED; USD return drifts with spot</p>
          <p>7. capacity = min(vol×5%, OI×2%, $500k); BNB hard cap $50k</p>
          <p className="pt-2 text-muted/70">Fees (round-trip taker): COIN-M 0.165% · USDT-M 0.140% · OKX 0.150% · Deribit 0.150%</p>
          <p className="text-muted/70">Universe: BTC (COIN-M + USDT-M + OKX + Deribit) · ETH (same) · BNB (COIN-M only)</p>
          <p className="text-muted/70">Excluded: SOL/XRP (no clean contract or decision-matrix rejected) · Bybit (dead ETH contract) · Hyperliquid/dYdX (perp DEX, no dated futures)</p>
        </div>
      </details>

    </div>
  );
}
