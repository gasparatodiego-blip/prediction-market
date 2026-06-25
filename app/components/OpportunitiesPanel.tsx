'use client';

import { useEffect, useState, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Leg {
  platform: string;
  side: string;
  price: number;
  stake?: number;
  intervalHours?: number;
  isDex?: boolean;
  url: string | null;
}

interface Opp {
  type: 'CASHABLE' | 'SIGNAL' | 'SPORTS' | 'FUNDING';
  id: string;
  question: string;
  sport?: string;
  legs: Leg[];
  annualizedROI: number | null;
  netROI: number | null;
  spread: number | null;
  daysToResolution: number | null;
  resolutionDate: string | null;
  capacityUsd: number | null;
  lockupFlag: string | null;
  verdict: string;
  confidence: number;
  hasDexLeg?: boolean;
  breakevenDays?: number;
  note?: string;
  totalFeesPct?: number;
}

interface Summary {
  total: number;
  cashable: number;
  signal: number;
  sports: number;
  funding: number;
  bestAnnualized: number | null;
}

interface ApiResponse {
  ok: boolean;
  generatedAt: number | null;
  staleMinutes: number | null;
  summary: Summary;
  opportunities: Opp[];
}

// ── Display helpers ───────────────────────────────────────────────────────────

const BADGE_CLS: Record<string, string> = {
  CASHABLE: 'bg-positive/10 text-positive border-positive/25',
  SIGNAL:   'bg-warning/10 text-warning border-warning/25',
  SPORTS:   'bg-accent/10 text-accent-bright border-accent/25',
  FUNDING:  'bg-text-muted/10 text-text-secondary border-border',
};

const VERDICT_CLS: Record<string, string> = {
  'Actionable':                      'text-positive',
  'capital-lockup-skip':             'text-warning',
  'signal':                          'text-text-muted',
  'stale-check':                     'text-negative',
  'HARVEST · variable':              'text-accent',
  'SPIKE — predicted, unconfirmed':  'text-negative/60',
};

function fmtRoi(n: number | null, suffix = '%', places = 1): string {
  if (n === null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(places)}${suffix}`;
}

function fmtCap(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1000) return `~$${(n / 1000).toFixed(1)}k`;
  return `~$${Math.round(n)}`;
}

function fmtDays(days: number | null): string {
  if (days === null) return '—';
  if (days <= 0) return 'TODAY';
  if (days < 90) return `${days}d`;
  return `${Math.round(days / 30)}mo`;
}

function fuseColorCls(days: number | null): string {
  if (days === null) return 'bg-border';
  if (days < 7)  return 'bg-negative';
  if (days < 30) return 'bg-warning';
  return 'bg-positive';
}

function fusePct(days: number | null): number {
  if (days === null) return 0;
  return Math.min(100, Math.max(2, (days / 180) * 100));
}

function fmtLegPrice(leg: Leg, type: string): string {
  if (type === 'SPORTS')  return `${leg.price.toFixed(2)}×`;
  if (type === 'FUNDING') {
    const sign     = leg.price >= 0 ? '+' : '';
    const interval = leg.intervalHours === 1 ? '/hr' : '/8h';
    return `${sign}${leg.price.toFixed(4)}%${interval}`;
  }
  return `${Math.round(leg.price * 100)}¢`;
}

// ── Sizing helpers ────────────────────────────────────────────────────────────

type Leverage = 1 | 2 | 3 | 5;
const LEVERAGE_OPTIONS: Leverage[] = [1, 2, 3, 5];

function fmtUsd(n: number): string {
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  if (abs >= 100)    return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function calcFundingSizing(
  grossApy: number | null,
  netApy: number | null,
  totalFeesPct: number,
  capital: number,
  leverage: Leverage,
) {
  const N         = capital * leverage / 2;
  const gross     = grossApy ?? 0;
  const net       = netApy ?? 0;
  const feesUsd   = N * totalFeesPct / 100;
  const net30dUsd = N * gross / 100 * 30 / 365 - feesUsd;
  const netYrUsd  = N * net / 100;
  const roc       = capital > 0 ? netYrUsd / capital * 100 : 0;
  return { N, feesUsd, net30dUsd, netYrUsd, roc };
}

// ── Sizing control ────────────────────────────────────────────────────────────

function SizingControl({
  capital, setCapital, leverage, setLeverage,
}: {
  capital: number;
  setCapital: (n: number) => void;
  leverage: Leverage;
  setLeverage: (n: Leverage) => void;
}) {
  const N = capital * leverage / 2;
  return (
    <div className="px-3 py-2 border-b border-border flex flex-wrap items-center gap-x-4 gap-y-1.5 bg-bg-elevated/20">
      <span className="font-mono text-[9px] uppercase tracking-widest text-text-muted shrink-0">
        Capital
      </span>
      <div className="flex items-center gap-1">
        <span className="font-mono text-[10px] text-text-muted">$</span>
        <input
          type="number"
          min={0}
          step={100}
          value={capital}
          onChange={e => setCapital(Math.max(0, parseFloat(e.target.value) || 0))}
          className="w-[4.5rem] px-1.5 py-0.5 font-mono text-[11px] bg-bg-panel border border-border text-text-primary focus:border-accent/50 focus:outline-none tabular-nums"
        />
      </div>
      <div className="flex items-center gap-1">
        {LEVERAGE_OPTIONS.map(lev => (
          <button
            key={lev}
            onClick={() => setLeverage(lev)}
            className={`px-1.5 py-0.5 font-mono text-[10px] border transition-colors duration-100 ${
              leverage === lev
                ? 'bg-accent text-white border-accent'
                : 'border-border text-text-muted hover:border-text-secondary hover:text-text-primary'
            }`}
          >
            {lev}×
          </button>
        ))}
      </div>
      {capital > 0 && (
        <span className="font-mono text-[9px] text-text-muted">
          N/leg: <span className="text-text-secondary tabular-nums">{fmtUsd(N)}</span>
        </span>
      )}
      <span className="font-mono text-[9px] text-text-muted/40 ml-auto hidden sm:block">
        Projected at current rate · not locked
      </span>
    </div>
  );
}

// ── Sizing blocks ─────────────────────────────────────────────────────────────

function FundingSizingBlock({ opp, capital, leverage }: {
  opp: Opp; capital: number; leverage: Leverage;
}) {
  if (capital <= 0) return null;
  const totalFeesPct = opp.totalFeesPct ?? (opp.hasDexLeg ? 0.13 : 0.16);
  const s = calcFundingSizing(opp.annualizedROI, opp.netROI, totalFeesPct, capital, leverage);

  return (
    <div className="mt-1.5 pt-1.5 border-t border-border/30 space-y-0.5">
      <div className="flex flex-wrap gap-x-3 font-mono text-[10px]">
        <span className="text-text-muted">
          N/leg <span className="text-text-primary tabular-nums">{fmtUsd(s.N)}</span>
        </span>
        <span className="text-text-muted">
          Fees <span className="text-text-primary tabular-nums">{fmtUsd(s.feesUsd)}</span>
        </span>
        <span className="text-text-muted">
          Net 30d{' '}
          <span className={`tabular-nums ${s.net30dUsd >= 0 ? 'text-positive' : 'text-negative'}`}>
            {fmtUsd(s.net30dUsd)}
          </span>
        </span>
        <span className="text-text-muted">
          Net/yr{' '}
          <span className={`tabular-nums ${s.netYrUsd >= 0 ? 'text-positive' : 'text-negative'}`}>
            {fmtUsd(s.netYrUsd)}
          </span>
        </span>
        <span className="ml-auto text-text-muted">
          ROC{' '}
          <span className={`tabular-nums font-semibold ${s.roc >= 0 ? 'text-positive' : 'text-negative'}`}>
            {s.roc >= 0 ? '+' : ''}{s.roc.toFixed(1)}%/yr
          </span>
        </span>
      </div>
      {leverage === 1 ? (
        <div className="font-mono text-[9px] text-text-muted/60 leading-snug">
          APY on notional ({fmtUsd(s.N)}/leg) — at 1× you deploy ~{fmtUsd(s.N * 2)} total;
          return-on-capital ({s.roc.toFixed(1)}%) is ~half gross APY on notional.
        </div>
      ) : (
        <div className="font-mono text-[9px] text-warning/70 leading-snug">
          At {leverage}×: higher return-on-capital but LIQUIDATION risk if price moves against margin.
        </div>
      )}
      <div className="font-mono text-[9px] text-text-muted/40 leading-snug">
        Liquidity at this size NOT verified (no orderbook depth). $ figures project current rate — not locked.
      </div>
    </div>
  );
}

function CashableSizingBlock({ opp, capital }: { opp: Opp; capital: number }) {
  if (capital <= 0) return null;
  const maxCap = opp.capacityUsd;
  if (maxCap === null) {
    return (
      <div className="mt-1 pt-1 border-t border-border/30 font-mono text-[10px] text-text-muted">
        Size unknown — no depth data
      </div>
    );
  }
  const capped       = Math.min(capital, maxCap);
  const wasCapped    = capital > maxCap;
  const lockedProfit = capped * (opp.netROI ?? 0) / 100;

  return (
    <div className="mt-1 pt-1 border-t border-border/30 flex flex-wrap items-center gap-x-3 font-mono text-[10px]">
      {wasCapped && (
        <span className="text-warning">Capped at max {fmtCap(maxCap)} depth</span>
      )}
      <span className="text-text-muted">
        Deploy <span className="text-text-primary tabular-nums">{fmtUsd(capped)}</span>
      </span>
      <span className="text-text-muted">
        Locked profit <span className="text-positive tabular-nums">{fmtUsd(lockedProfit)}</span>
      </span>
      <span className="font-mono text-[9px] text-text-muted/40 w-full mt-0.5">
        One-time, not annualized · locked until resolution
      </span>
    </div>
  );
}

function SportsSizingBlock({ opp, capital }: { opp: Opp; capital: number }) {
  if (capital <= 0) return null;
  const lockedProfit       = capital * (opp.netROI ?? 0) / 100;
  const totalOriginalStake = opp.legs.reduce((s, l) => s + (l.stake ?? 0), 0);

  return (
    <div className="mt-1 pt-1 border-t border-border/30 flex flex-wrap items-center gap-x-3 font-mono text-[10px]">
      <span className="text-text-muted">
        Total stake <span className="text-text-primary tabular-nums">{fmtUsd(capital)}</span>
      </span>
      <span className="text-text-muted">
        Locked profit <span className="text-positive tabular-nums">{fmtUsd(lockedProfit)}</span>
      </span>
      {totalOriginalStake > 0 && opp.legs.map((leg, i) => {
        const scaled = leg.stake != null ? (leg.stake / totalOriginalStake) * capital : null;
        return scaled != null ? (
          <span key={i} className="text-text-muted/70">{leg.platform}: {fmtUsd(scaled)}</span>
        ) : null;
      })}
    </div>
  );
}

// ── Countdown ─────────────────────────────────────────────────────────────────

function Countdown({ resolutionDate }: { resolutionDate: string | null }) {
  const [text, setText] = useState('');

  useEffect(() => {
    if (!resolutionDate) { setText(''); return; }
    const target = new Date(resolutionDate + 'T23:59:59Z').getTime();
    const update = () => {
      const ms = target - Date.now();
      if (ms <= 0) { setText('RESOLVED'); return; }
      const d = Math.floor(ms / 86_400_000);
      const h = Math.floor((ms % 86_400_000) / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      const s = Math.floor((ms % 60_000) / 1_000);
      const p = (n: number) => String(n).padStart(2, '0');
      setText(d > 0 ? `${d}d ${p(h)}h ${p(m)}m` : `${p(h)}:${p(m)}:${p(s)}`);
    };
    update();
    const t = setInterval(update, 1_000);
    return () => clearInterval(t);
  }, [resolutionDate]);

  if (!text) return null;
  return (
    <span className="font-mono text-[10px] tabular-nums text-text-secondary">{text}</span>
  );
}

// ── Opportunity row ───────────────────────────────────────────────────────────

function OppRow({ opp, capital, leverage }: { opp: Opp; capital: number; leverage: Leverage }) {
  const verdictCls = VERDICT_CLS[opp.verdict] ?? 'text-text-muted';
  const badgeCls   = BADGE_CLS[opp.type] ?? BADGE_CLS.FUNDING;

  return (
    <div className="px-4 py-3 border-b border-border last:border-0 hover:bg-bg-elevated/50 transition-colors duration-100">

      {/* Line 1: type badge · question · annualized ROI */}
      <div className="flex items-start gap-2 mb-1.5">
        <span className={`shrink-0 mt-px font-mono text-[9px] uppercase tracking-widest px-1.5 py-[2px] border ${badgeCls}`}>
          {opp.type}
        </span>
        <span className="flex-1 font-mono text-[11px] text-text-primary leading-snug min-w-0 line-clamp-2">
          {opp.question}
          {opp.sport && (
            <span className="text-text-muted ml-1.5 text-[10px]">· {opp.sport}</span>
          )}
        </span>
        <div className="shrink-0 text-right ml-2">
          <div className="font-mono text-[14px] font-bold text-positive tabular-nums leading-none">
            {opp.annualizedROI !== null
              ? `${opp.annualizedROI >= 0 ? '+' : ''}${opp.annualizedROI.toFixed(1)}%/yr`
              : '—'}
          </div>
          {opp.type !== 'SIGNAL' && opp.netROI !== null && (
            <div className="font-mono text-[10px] text-text-muted tabular-nums mt-0.5">
              {opp.type === 'FUNDING' ? `net/yr ${fmtRoi(opp.netROI)}` : `net ${fmtRoi(opp.netROI)}`}
            </div>
          )}
        </div>
      </div>

      {/* Line 2: legs */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-1.5">
        {opp.legs.map((leg, i) => (
          <span key={i} className="inline-flex items-center gap-1 font-mono text-[10px]">
            {i > 0 && <span className="text-border mx-0.5">↔</span>}
            <span className="text-text-secondary">{leg.platform}</span>
            <span className="text-border">·</span>
            <span className={
              leg.side === 'YES' ? 'text-positive' :
              leg.side === 'NO'  ? 'text-accent-bright' :
              'text-text-secondary'
            }>
              {leg.side}
            </span>
            <span className="text-border">·</span>
            <span className="text-text-primary tabular-nums">{fmtLegPrice(leg, opp.type)}</span>
            {leg.stake != null && (
              <span className="text-text-muted">(${leg.stake.toFixed(0)})</span>
            )}
          </span>
        ))}
        {opp.type === 'SIGNAL' && opp.spread !== null && (
          <span className="font-mono text-[10px] text-text-muted ml-1">
            {opp.spread}pp spread
          </span>
        )}
      </div>

      {/* DEX bridge friction notice */}
      {opp.hasDexLeg && (
        <div className="font-mono text-[9px] text-warning/70 mb-1 leading-snug">
          DEX leg: ~10 min bridge + ~$1–5 one-time · HL funds hourly (rate can flip every 1h)
        </div>
      )}

      {/* Line 3: fuse bar · countdown · capacity · verdict */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <div className="w-16 h-[3px] bg-bg-elevated rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${fuseColorCls(opp.daysToResolution)}`}
              style={{ width: `${fusePct(opp.daysToResolution)}%` }}
            />
          </div>
          <span className="font-mono text-[10px] text-text-muted tabular-nums">
            {fmtDays(opp.daysToResolution)}
          </span>
        </div>

        <Countdown resolutionDate={opp.resolutionDate} />

        <span className="font-mono text-[10px] text-text-muted">
          max {fmtCap(opp.capacityUsd)}
        </span>

        <span className={`ml-auto font-mono text-[10px] uppercase tracking-widest ${verdictCls}`}>
          {opp.verdict}
        </span>
      </div>

      {/* Sizing blocks */}
      {opp.type === 'FUNDING'  && <FundingSizingBlock  opp={opp} capital={capital} leverage={leverage} />}
      {opp.type === 'CASHABLE' && <CashableSizingBlock opp={opp} capital={capital} />}
      {opp.type === 'SPORTS'   && <SportsSizingBlock   opp={opp} capital={capital} />}

    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

type Filter = 'ALL' | 'CASHABLE' | 'SIGNAL' | 'SPORTS' | 'FUNDING';

const FILTER_PILLS: { key: Filter; label: string }[] = [
  { key: 'ALL',      label: 'ALL'      },
  { key: 'CASHABLE', label: 'CASHABLE' },
  { key: 'SIGNAL',   label: 'SIGNAL'   },
  { key: 'SPORTS',   label: 'SPORTS'   },
  { key: 'FUNDING',  label: 'FUNDING'  },
];

export default function OpportunitiesPanel() {
  const [data,     setData]     = useState<ApiResponse | null>(null);
  const [filter,   setFilter]   = useState<Filter>('ALL');
  const [loading,  setLoading]  = useState(true);
  const [capital,  setCapital]  = useState(1000);
  const [leverage, setLeverage] = useState<Leverage>(1);

  const load = useCallback(async () => {
    try {
      const res  = await fetch('/api/unified-opportunities', { cache: 'no-store' });
      const json: ApiResponse = await res.json();
      setData(json);
    } catch {
      // keep stale data on transient fetch error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const opps = (data?.opportunities ?? []).filter(
    o => filter === 'ALL' || o.type === filter
  );

  const noData  = !loading && !data?.ok;
  const isStale = (data?.staleMinutes ?? 0) > 60;

  return (
    <div className="bg-bg-panel border border-border flex flex-col">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${noData ? 'bg-warning' : 'bg-positive animate-pulse-slow'}`}
            style={noData ? undefined : { boxShadow: '0 0 4px #22C55E' }}
          />
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
            Opportunities
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isStale && (
            <span className="font-mono text-[10px] text-warning">
              stale {data!.staleMinutes}m
            </span>
          )}
          {data?.generatedAt && (
            <span className="font-mono text-[10px] tabular-nums text-text-muted">
              {new Date(data.generatedAt).toLocaleTimeString('en-GB', { hour12: false })}
            </span>
          )}
        </div>
      </div>

      {/* Filter pills */}
      <div className="flex gap-1.5 px-3 py-2 border-b border-border flex-wrap">
        {FILTER_PILLS.map(({ key, label }) => {
          const count = key === 'ALL'
            ? (data?.summary?.total ?? 0)
            : (data?.summary?.[key.toLowerCase() as keyof Summary] as number | undefined ?? 0);
          return (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-2 py-0.5 font-mono text-[10px] border rounded-sm transition-colors duration-100 ${
                filter === key
                  ? 'bg-accent text-white border-accent'
                  : 'border-border text-text-muted hover:border-text-secondary hover:text-text-primary'
              }`}
            >
              {label}
              {count > 0 && (
                <span className="ml-1 opacity-60">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Sizing control */}
      <SizingControl
        capital={capital}
        setCapital={setCapital}
        leverage={leverage}
        setLeverage={setLeverage}
      />

      {/* Body */}
      {loading ? (
        <div className="py-10 text-center font-mono text-[10px] uppercase tracking-widest text-text-muted animate-pulse">
          Loading…
        </div>
      ) : noData ? (
        <div className="py-10 text-center space-y-1.5">
          <div className="font-mono text-[10px] uppercase tracking-widest text-warning">No data</div>
          <div className="font-mono text-[10px] text-text-muted">Run matcher-v2 to populate</div>
        </div>
      ) : opps.length === 0 ? (
        <div className="py-8 text-center font-mono text-[10px] uppercase tracking-widest text-text-muted">
          No {filter !== 'ALL' ? filter.toLowerCase() + ' ' : ''}opportunities
        </div>
      ) : (
        <div>
          {opps.map(opp => (
            <OppRow key={opp.id} opp={opp} capital={capital} leverage={leverage} />
          ))}
        </div>
      )}

      {/* Footer */}
      {!loading && !noData && (
        <div className="px-3 py-1.5 border-t border-border mt-auto flex items-center justify-between">
          <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-text-muted">
            Refresh 30s
          </span>
          {data?.summary?.bestAnnualized != null && (
            <span className="font-mono text-[9px] text-positive tabular-nums">
              Best {data.summary.bestAnnualized >= 0 ? '+' : ''}{data.summary.bestAnnualized.toFixed(1)}%/yr
            </span>
          )}
        </div>
      )}

    </div>
  );
}
