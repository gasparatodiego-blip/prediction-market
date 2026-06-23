'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, TrendingDown } from 'lucide-react';

interface Contract {
  asset:                   string;
  exchange:                string;
  venueKey:                string;
  contract:                string;
  expiry:                  string;
  daysToExpiry:            number;
  // Book-mid prices (indicative basis uses these)
  spot:                    number;
  future:                  number;  // futureMidBook = (futureBid + futureAsk) / 2
  futureLast:              number | null;  // last trade or mark price — display only
  // Executable leg prices
  spotBid:                 number | null;
  spotAsk:                 number | null;
  futureBid:               number | null;
  futureAsk:               number | null;
  // Basis values
  indicativeBasisPct:      number;
  executableBasisPct:      number;
  basis:                   number;  // backward-compat alias = indicativeBasisPct
  // Annualized returns
  grossAnnualized:         number;
  grossAnnualizedExec:     number;
  fee:                     number;
  netAnnualizedIndicative: number;
  netAnnualizedExecutable: number;
  netAnnualized:           number;  // headline = netAnnualizedExecutable
  // Market quality
  vol24Usd:                number;
  oiUsd:                   number | null;
  capacityUsd:             number;
  tier:                    string;
  thinFlag:                boolean;
  coinMargined:            boolean;
  coinMarginedNote:        string | null;
  bidSpreadPct:            number | null;
  verdict:                 string;
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
  indicativeBasisPct:  number;
  executableBasisPct:  number;
  basis:               number;  // backward-compat alias
  annualized:          number;
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

function fmtK(n: number | null) {
  if (n == null) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}
function fmtAge(iso: string | null) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.round(s)}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

// ── Contango row ───────────────────────────────────────────────────────────────

function ContangoRow({ c }: { c: Contract }) {
  const isClean = !c.coinMargined; // USDT-M or Deribit cash-settled

  return (
    <div className={`flex gap-0 rounded overflow-hidden border ${isClean ? 'border-emerald-900' : 'border-amber-900'}`}>
      {/* Left accent bar */}
      <div className={`w-1 shrink-0 ${isClean ? 'bg-emerald-500' : 'bg-amber-500'}`} />

      <div className="flex-1 p-4 bg-zinc-900/60">
        {/* Top row: asset + tags + hero % */}
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-bold text-zinc-100">{c.asset}</span>
            <span className="font-mono text-xs text-zinc-500">{c.exchange} · {c.contract} · {c.daysToExpiry}d</span>

            {/* CONTANGO tag */}
            <span className="text-xs font-mono px-1.5 py-0.5 rounded border border-zinc-700 bg-zinc-800 text-zinc-400 uppercase tracking-wide">
              CONTANGO
            </span>

            {/* CLEAN USD or COIN-MARGINED tag */}
            {isClean ? (
              <span className="text-xs font-mono px-1.5 py-0.5 rounded border border-emerald-800 bg-emerald-900/40 text-emerald-300 uppercase tracking-wide">
                CLEAN USD
              </span>
            ) : (
              <span className="text-xs font-mono px-1.5 py-0.5 rounded border border-amber-800 bg-amber-900/30 text-amber-300 uppercase tracking-wide">
                COIN-MARGINED
              </span>
            )}

            {/* Thin flag */}
            {c.thinFlag && (
              <span className="text-xs font-mono px-1.5 py-0.5 rounded border border-yellow-800 bg-yellow-900/30 text-yellow-400">
                THIN ⚠
              </span>
            )}
          </div>

          {/* Hero: net annualized % — executable (conservative) */}
          <div className="text-right shrink-0">
            <div className={`font-mono text-xl font-bold tabular-nums ${isClean ? 'text-emerald-300' : 'text-amber-300'}`}>
              +{(c.netAnnualizedExecutable * 100).toFixed(2)}%
            </div>
            <div className="font-mono text-xs text-zinc-500">net/yr (executable)</div>
            <div className="font-mono text-xs text-zinc-600 mt-0.5">
              indicative (mid): +{(c.netAnnualizedIndicative * 100).toFixed(2)}%
            </div>
          </div>
        </div>

        {/* Chips row: spot · future · basis · capacity */}
        <div className="flex flex-wrap gap-2 mt-3">
          {[
            { label: 'spot ask',   value: c.spotAsk != null ? `$${c.spotAsk.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${c.spot.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
            { label: 'future bid', value: c.futureBid != null ? `$${c.futureBid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${c.future.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
            { label: 'exec basis', value: `+${(c.executableBasisPct * 100).toFixed(2)}%` },
            { label: 'capacity',   value: fmtK(c.capacityUsd) },
            { label: 'vol 24h',    value: fmtK(c.vol24Usd) },
            { label: 'exp',        value: c.expiry },
          ].map(({ label, value }) => (
            <div key={label} className="flex items-center gap-1 text-xs font-mono px-2 py-1 rounded bg-zinc-800 border border-zinc-700">
              <span className="text-zinc-500">{label}</span>
              <span className="text-zinc-200">{value}</span>
            </div>
          ))}
        </div>

        {/* One-line verdict */}
        <p className={`mt-3 text-xs font-mono leading-relaxed ${isClean ? 'text-emerald-200/80' : 'text-amber-200/80'}`}>
          {c.verdict}
          {c.coinMarginedNote && ` ${c.coinMarginedNote}`}
        </p>
      </div>
    </div>
  );
}

// ── Backwardation card ─────────────────────────────────────────────────────────

function BackwardCard({ c }: { c: BackwardContract }) {
  return (
    <div className="rounded border border-dashed border-amber-800 p-4 bg-amber-950/20">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <TrendingDown className="w-4 h-4 text-amber-400 shrink-0" />
          <span className="font-mono text-sm font-semibold text-zinc-200">{c.asset}</span>
          <span className="font-mono text-xs text-zinc-500">{c.exchange} · {c.contract} · {c.daysToExpiry}d</span>
          <span className="text-xs font-mono px-1.5 py-0.5 rounded border border-amber-800 bg-amber-900/30 text-amber-300 uppercase tracking-wide">
            BACKWARDATION
          </span>
        </div>
        <div className="font-mono text-lg font-bold text-amber-300 tabular-nums shrink-0">
          {(c.annualized * 100).toFixed(2)}%<span className="text-xs font-normal text-zinc-500">/yr basis</span>
        </div>
      </div>
      <p className="text-xs font-mono text-zinc-400 leading-relaxed">{c.signal}</p>
      <div className="flex flex-wrap gap-3 mt-2 text-xs font-mono text-zinc-600">
        <span>spot <span className="text-zinc-400">${c.spot.toLocaleString()}</span></span>
        <span>future <span className="text-zinc-400">${c.future.toLocaleString()}</span></span>
        <span>vol <span className="text-zinc-400">{fmtK(c.vol24Usd)}</span></span>
        <span>exp <span className="text-zinc-400">{c.expiry}</span></span>
      </div>
    </div>
  );
}

// ── Honesty disclosure block ───────────────────────────────────────────────────

function HonestyBlock() {
  return (
    <div className="border border-zinc-800 rounded p-4 space-y-2">
      <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest mb-3">Honesty disclosures</p>
      {[
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
          body:  'Annualized basis of 1–4% reflects today\'s contango. Basis widens with volatility and fear — in calm markets it compresses toward funding rates. The number you see is today\'s snapshot, not a long-run yield.',
        },
        {
          label: 'Not financial advice.',
          body:  'Exchange / counterparty risk over the full hold period. Read-only scanner — no orders placed, no position held. Verify all numbers on-exchange before trading.',
        },
      ].map(({ label, body }) => (
        <div key={label} className="flex gap-2 text-xs font-mono leading-relaxed">
          <span className="shrink-0 text-zinc-500">—</span>
          <p className="text-zinc-500">
            <span className="text-zinc-300">{label}</span>{' '}{body}
          </p>
        </div>
      ))}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function CarryPage() {
  const [data, setData]     = useState<CarryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);

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

  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);

  const isRunning = data?.agentStatus === 'running';
  const statusColor = isRunning ? 'bg-emerald-500' : 'bg-zinc-600';
  const statusLabel = data?.agentStatus === 'running' ? 'LIVE'
                    : data?.agentStatus === 'stale'   ? 'STALE'
                    : 'OFFLINE';

  // Split opportunities into clean-USD first, then coin-margined
  const cleanOpps = data?.opportunities.filter(c => !c.coinMargined) ?? [];
  const coinOpps  = data?.opportunities.filter(c => c.coinMargined)  ?? [];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200">
      <div className="max-w-4xl mx-auto px-4 py-8">

        {/* Header */}
        <div className="flex items-center gap-3 mb-2">
          <Link href="/dashboard" className="text-zinc-600 hover:text-zinc-300 transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-mono text-lg font-semibold text-zinc-100">Cash &amp; Carry</h1>
              <span className={`flex items-center gap-1.5 text-xs font-mono px-2 py-0.5 rounded-full text-zinc-900 font-semibold ${statusColor}`}>
                <span className={`w-1.5 h-1.5 rounded-full bg-zinc-900/60 ${isRunning ? 'animate-pulse' : ''}`} />
                {statusLabel}
              </span>
              {data?.updatedAt && (
                <span className="text-xs font-mono text-zinc-600">{fmtAge(data.updatedAt)}</span>
              )}
            </div>
            <p className="text-xs font-mono text-zinc-600 mt-0.5">
              Spot + dated futures · BTC / ETH / BNB · Binance COIN-M + USDT-M · OKX · Deribit · refreshes every 5 min
            </p>
          </div>
          <button onClick={load} className="text-zinc-600 hover:text-zinc-300 transition-colors shrink-0">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Context lede */}
        <p className="text-xs font-mono text-zinc-500 leading-relaxed mb-6 mt-3">
          Buy spot on an exchange and simultaneously short a dated (quarterly / March / December) futures contract.
          At expiry the futures price converges to spot — you capture the basis gap locked in at entry.
          Return is <span className="text-zinc-300">deterministic</span> (known at entry) if held to expiry,
          unlike variable funding rates.
          7 filters applied: days to expiry, volume, net-of-fee basis, XPERP exclusion, backwardation signal,
          coin-margin label, capacity estimate.
        </p>

        {error && (
          <div className="mb-4 p-3 rounded border border-rose-800 bg-rose-900/20 text-rose-300 font-mono text-xs">{error}</div>
        )}

        {/* Best opportunity hero bar */}
        {isRunning && data && data.summary.bestNetAnnualized != null && (
          <div className="mb-6 p-4 rounded border border-emerald-900 bg-emerald-950/30 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold font-mono text-emerald-300 tabular-nums">
                  +{(data.summary.bestNetAnnualized * 100).toFixed(2)}%
                </span>
                <span className="text-sm font-mono text-zinc-400">/yr net locked basis</span>
              </div>
              <div className="text-xs font-mono text-zinc-500 mt-0.5">
                {data.summary.bestContract} · {data.summary.bestExchange} · {data.summary.count} contract{data.summary.count !== 1 ? 's' : ''} qualifying
              </div>
            </div>
            <div className="flex gap-4 text-xs font-mono text-zinc-600">
              {data.spot && Object.entries(data.spot).map(([a, p]) =>
                p != null ? (
                  <span key={a}>
                    <span className="text-zinc-400">{a}</span>{' '}
                    ${(p as number).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                  </span>
                ) : null
              )}
            </div>
          </div>
        )}

        {loading && !data && (
          <div className="py-16 text-center text-zinc-600 font-mono text-sm animate-pulse">scanning exchanges…</div>
        )}

        {data?.agentStatus === 'offline' && (
          <div className="py-12 text-center text-zinc-600 font-mono text-sm">
            agent19-basis offline —{' '}
            <code className="text-zinc-400">pm2 start agents/ecosystem.config.js --only agent19-basis</code>
          </div>
        )}

        {/* ── SECTION 1: Contango ─────────────────────────────────────────────── */}
        {data && data.opportunities.length > 0 && (
          <section className="mb-8">
            <p className="font-mono text-xs text-zinc-500 uppercase tracking-widest mb-3">
              Contango — standard cash &amp; carry ({data.opportunities.length})
            </p>

            {/* Clean-USD first */}
            {cleanOpps.length > 0 && (
              <div className="space-y-2 mb-4">
                <p className="text-xs font-mono text-zinc-700 mb-1">
                  ▸ Clean USD return (USDT-M / Deribit cash-settled)
                </p>
                {cleanOpps.map(c => <ContangoRow key={`${c.exchange}:${c.contract}`} c={c} />)}
              </div>
            )}

            {/* Coin-margined */}
            {coinOpps.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-mono text-zinc-700 mb-1">
                  ▸ Coin-margined (P&L settles in {coinOpps.map(c => c.asset).filter((v,i,a)=>a.indexOf(v)===i).join('/')})
                </p>
                {coinOpps.map(c => <ContangoRow key={`${c.exchange}:${c.contract}`} c={c} />)}
              </div>
            )}
          </section>
        )}

        {data && data.opportunities.length === 0 && isRunning && (
          <div className="py-8 text-center text-zinc-600 font-mono text-sm">
            No qualifying contango contracts right now — all filtered by the 7 criteria.
          </div>
        )}

        {/* ── SECTION 2: Backwardation ─────────────────────────────────────────── */}
        {data && data.backwardation.length > 0 && (
          <section className="mb-8">
            <p className="font-mono text-xs text-zinc-500 uppercase tracking-widest mb-2">
              Backwardation — not cash &amp; carry ({data.backwardation.length})
            </p>
            <p className="text-xs font-mono text-zinc-600 mb-3 leading-relaxed">
              Futures trade <em>below</em> spot — basis is negative. Standard cash &amp; carry loses money here.
              Typically driven by staking yield (SOL ~7%/yr) or strong spot demand. Reverse carry (short spot + long future)
              collects the basis but requires borrowing the coin.
            </p>
            <div className="space-y-2">
              {data.backwardation.map(c => <BackwardCard key={`${c.exchange}:${c.contract}`} c={c} />)}
            </div>
          </section>
        )}

        {/* ── Honesty block ───────────────────────────────────────────────────── */}
        <div className="mb-8">
          <HonestyBlock />
        </div>

        {/* ── Filters collapsible ─────────────────────────────────────────────── */}
        <details className="mb-6">
          <summary className="cursor-pointer font-mono text-xs text-zinc-600 uppercase tracking-widest hover:text-zinc-400 transition-colors">
            Engine filters &amp; methodology
          </summary>
          <div className="mt-3 text-xs font-mono text-zinc-500 leading-relaxed border-l-2 border-zinc-800 pl-4 space-y-1">
            <p>1. daysToExpiry ≥ 20 days (too-near-expiry excluded)</p>
            <p>2. vol24h ≥ $500k → DEEP/OK; ≥ $100k → THIN (flagged); &lt; $100k → excluded</p>
            <p>3. netAnnualized = (basis − fees) × 365/days &gt; 0 (after fees, positive carry only)</p>
            <p>4. OKX symbols with XPERP excluded (extended perpetuals to Apr 2031, not delivery futures)</p>
            <p>5. basis &lt; 0 → backwardation[], not opportunities[]</p>
            <p>6. COIN-M / OKX BTC-USD / ETH-USD labeled COIN-MARGINED; USD return drifts with spot</p>
            <p>7. capacity = min(vol×5%, OI×2%, $500k); BNB hard cap $50k</p>
            <p className="pt-2 text-zinc-600">Fees (round-trip taker): COIN-M 0.165% · USDT-M 0.140% · OKX 0.150% · Deribit 0.150%</p>
            <p className="text-zinc-600">Universe: BTC (COIN-M + USDT-M + OKX + Deribit) · ETH (same) · BNB (COIN-M only)</p>
            <p className="text-zinc-600">Excluded: SOL/XRP (no clean contract or decision-matrix rejected) · Bybit (dead ETH contract) · Hyperliquid/dYdX (perp DEX, no dated futures)</p>
          </div>
        </details>

      </div>
    </div>
  );
}
