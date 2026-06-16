'use client';

import { useState, useEffect, useCallback } from 'react';
import { ExternalLink, ChevronDown, ChevronUp } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Leg {
  platform:    string;
  probability: number;   // 0–100 (cents equivalent)
  url:         string;
  fee:         number;   // 0–1 fraction
  expiresAt:   number | null;
}

interface Opportunity {
  id:               string;
  question:         string;
  lowMarket:        Leg;
  highMarket:       Leg;
  spread:           number;
  roi:              number;
  earnPer100:       number;
  confidence:       number;
  category:         string;
  type:             'cashable' | 'signal';
  annualizedROI?:   number | null;
  daysToResolution?: number | null;
}

interface Stats {
  validCount:     number;
  cashableCount:  number;
  signalCount:    number;
  bestRoi:        number | null;
  marketsTracked: number;
  platforms:      number;
  updatedAt:      number | null;
  pipelineAge:    number | null;
}

interface Freshness {
  updatedAt:  number | null;
  ageMinutes: number | null;
  isFresh:    boolean;
  label:      string | null;
}

interface ApiResponse {
  valid:     Opportunity[];
  rejected:  number;
  stats:     Stats;
  freshness: Freshness;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function platformLabel(p: string): string {
  const MAP: Record<string, string> = {
    kalshi: 'KALSHI', polymarket: 'POLYMARKET',
    predictit: 'PREDICTIT', manifold: 'MANIFOLD', oddsapi: 'ODDS API',
  };
  return MAP[p?.toLowerCase()] ?? p.toUpperCase();
}

// ── Countdown hook ────────────────────────────────────────────────────────────

function Countdown({ expiresAt }: { expiresAt: number | null }) {
  const [text, setText] = useState<string>('');

  useEffect(() => {
    if (!expiresAt) { setText(''); return; }
    const update = () => {
      const ms = expiresAt - Date.now();
      if (ms <= 0) { setText('EXPIRED'); return; }
      const d = Math.floor(ms / 86_400_000);
      const h = Math.floor((ms % 86_400_000) / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      const s = Math.floor((ms % 60_000) / 1_000);
      const p = (n: number) => String(n).padStart(2, '0');
      setText(`${p(d)}:${p(h)}:${p(m)}:${p(s)}`);
    };
    update();
    const t = setInterval(update, 1_000);
    return () => clearInterval(t);
  }, [expiresAt]);

  if (!expiresAt) return <span className="text-text-muted font-mono text-[10px]">NO EXPIRY DATA</span>;
  return <span className="font-mono text-[10px] tabular-nums text-text-secondary">{text}</span>;
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Skeleton({ h }: { h: string }) {
  return <div className={`${h} bg-bg-elevated animate-pulse border border-border`} />;
}

// ── Stat panel ────────────────────────────────────────────────────────────────

function StatPanel({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-bg-panel border border-border px-4 py-3 min-w-0">
      <div className="font-mono text-[10px] text-text-muted uppercase tracking-widest mb-1 truncate">{label}</div>
      <div className="font-mono text-base text-text-primary tabular-nums">{value}</div>
      {sub && <div className="font-mono text-[10px] text-text-muted mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

// ── Profit calculator ─────────────────────────────────────────────────────────

function Calculator({ opp }: { opp: Opportunity }) {
  const [stake, setStake] = useState(100);

  if (opp.type === 'signal') {
    return (
      <div className="px-4 py-3 bg-bg-base border-t border-border">
        <span className="font-mono text-[11px] text-warning uppercase tracking-widest">
          MANIFOLD USES PLAY MONEY (MANA) · INFORMATIONAL ONLY · NO EUR CALCULATION AVAILABLE
        </span>
      </div>
    );
  }

  const totalFeeRate = opp.lowMarket.fee + opp.highMarket.fee;
  const roiGross     = totalFeeRate < 1 ? opp.roi / (1 - totalFeeRate) : opp.roi;
  const grossProfit  = stake * roiGross / 100;
  const feeA         = grossProfit * opp.lowMarket.fee;
  const feeB         = grossProfit * opp.highMarket.fee;
  const netProfit    = stake * opp.roi / 100;

  return (
    <div className="px-4 py-4 bg-bg-base border-t border-border">
      <div className="font-mono text-[10px] text-text-muted uppercase tracking-widest mb-3">PROFIT CALCULATOR</div>
      <div className="flex flex-wrap gap-6 items-end">

        <div>
          <label className="block font-mono text-[10px] text-text-muted uppercase tracking-widest mb-1">
            STAKE (EUR)
          </label>
          <input
            type="number"
            min={1}
            value={stake}
            onChange={e => setStake(Math.max(1, Number(e.target.value) || 1))}
            className="w-28 bg-bg-elevated border border-border font-mono text-sm text-text-primary px-2 py-1.5 focus:outline-none focus:border-accent"
          />
        </div>

        <div>
          <div className="font-mono text-[10px] text-text-muted uppercase tracking-widest mb-1">GROSS EDGE</div>
          <div className="font-mono text-sm text-text-primary">€{grossProfit.toFixed(2)}</div>
        </div>

        <div>
          <div className="font-mono text-[10px] text-text-muted uppercase tracking-widest mb-1">
            {platformLabel(opp.lowMarket.platform)} FEE ({(opp.lowMarket.fee * 100).toFixed(0)}%)
          </div>
          <div className="font-mono text-sm text-negative">-€{feeA.toFixed(2)}</div>
        </div>

        <div>
          <div className="font-mono text-[10px] text-text-muted uppercase tracking-widest mb-1">
            {platformLabel(opp.highMarket.platform)} FEE ({(opp.highMarket.fee * 100).toFixed(0)}%)
          </div>
          <div className="font-mono text-sm text-negative">-€{feeB.toFixed(2)}</div>
        </div>

        <div>
          <div className="font-mono text-[10px] text-text-muted uppercase tracking-widest mb-1">NET PROFIT</div>
          <div className="font-mono text-sm font-semibold text-positive">
            €{netProfit.toFixed(2)}&nbsp;
            <span className="text-[11px] text-positive/80">({opp.roi.toFixed(2)}% ROI)</span>
          </div>
        </div>

      </div>
    </div>
  );
}

// ── Opportunity row ───────────────────────────────────────────────────────────

function OppRow({
  opp,
  isExpanded,
  onToggle,
}: {
  opp:        Opportunity;
  isExpanded: boolean;
  onToggle:   () => void;
}) {
  const isCashable         = opp.type === 'cashable';
  const noPriceHighMarket  = 100 - opp.highMarket.probability;
  const expiry             = opp.lowMarket.expiresAt ?? opp.highMarket.expiresAt ?? null;

  return (
    <div className="border border-border mb-1.5 last:mb-0">

      {/* Clickable summary row */}
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 hover:bg-bg-elevated transition-colors duration-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        aria-expanded={isExpanded}
      >
        <div className="flex flex-wrap gap-x-4 gap-y-2 items-start">

          {/* Type chip */}
          <div className="shrink-0 mt-0.5">
            {isCashable ? (
              <span className="font-mono text-[10px] uppercase tracking-widest px-1.5 py-0.5 bg-positive/10 text-positive border border-positive/25">
                CASHABLE
              </span>
            ) : (
              <span className="font-mono text-[10px] uppercase tracking-widest px-1.5 py-0.5 bg-warning/10 text-warning border border-warning/25">
                SIGNAL · PLAY MONEY
              </span>
            )}
          </div>

          {/* Question + category */}
          <div className="flex-1 min-w-[180px]">
            <div className="font-mono text-[12px] text-text-primary leading-snug line-clamp-2">{opp.question}</div>
            <div className="font-mono text-[10px] text-text-muted mt-0.5 uppercase tracking-widest">{opp.category}</div>
          </div>

          {/* Trade legs + caveat hint */}
          <div className="shrink-0 space-y-1">
            <div className="font-mono text-[11px]">
              <span className="text-positive">BUY YES @ {opp.lowMarket.probability}¢</span>
              <span className="text-border mx-1.5">·</span>
              <span className="text-text-secondary">{platformLabel(opp.lowMarket.platform)}</span>
              <span className="text-text-muted ml-2 text-[10px]">FEE {(opp.lowMarket.fee * 100).toFixed(0)}%</span>
            </div>
            <div className="font-mono text-[11px]">
              <span className="text-accent">BUY NO  @ {noPriceHighMarket}¢</span>
              <span className="text-border mx-1.5">·</span>
              <span className="text-text-secondary">{platformLabel(opp.highMarket.platform)}</span>
              <span className="text-text-muted ml-2 text-[10px]">FEE {(opp.highMarket.fee * 100).toFixed(0)}%</span>
            </div>
            {isCashable && (
              <div className="font-mono text-[9px] text-warning/50 leading-snug">
                ⚠ verify resolution criteria · fill not guaranteed
              </div>
            )}
          </div>

          {/* ROI + annualized */}
          <div className="shrink-0 text-right">
            <div className="font-mono text-[13px] font-semibold text-positive tabular-nums">
              +{opp.roi.toFixed(1)}% NET ROI
            </div>
            {opp.annualizedROI != null && (
              <div className="font-mono text-[10px] text-positive/60 tabular-nums">
                {opp.annualizedROI.toFixed(1)}% ANN
                {opp.daysToResolution != null ? ` · ${opp.daysToResolution}d` : ''}
              </div>
            )}
            <div className="font-mono text-[10px] text-text-muted tabular-nums">
              {opp.spread.toFixed(1)}pp SPREAD · CONF {Math.round(opp.confidence * 100)}%
            </div>
          </div>

          {/* Expiry */}
          <div className="shrink-0 text-right min-w-[90px]">
            <div className="font-mono text-[10px] text-text-muted uppercase tracking-widest mb-0.5">EXPIRES</div>
            <Countdown expiresAt={expiry} />
          </div>

          {/* Chevron */}
          <div className="shrink-0 self-center text-text-muted">
            {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </div>

        </div>
      </button>

      {/* Expanded panel */}
      {isExpanded && (
        <div>
          {/* Resolution caveat — cashable only */}
          {isCashable && (
            <div className="px-4 py-2.5 border-t border-warning/30 bg-warning/[0.04]">
              <span className="font-mono text-[9px] text-warning/70 leading-relaxed">
                ⚠ LOCKED ONLY IF BOTH PLATFORMS RESOLVE IDENTICALLY — VERIFY RESOLUTION CRITERIA
                BEFORE ACTING. LIQUIDITY AND FILL AT STATED PRICE NOT GUARANTEED.
              </span>
            </div>
          )}

          {/* Deep links */}
          <div className="px-4 py-2.5 border-t border-border bg-bg-elevated flex flex-wrap items-center gap-4">
            <a
              href={opp.lowMarket.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-mono text-[11px] text-accent hover:text-accent-bright transition-colors duration-100 uppercase tracking-widest"
            >
              <ExternalLink size={11} strokeWidth={1.5} />
              OPEN ON {platformLabel(opp.lowMarket.platform)} →
            </a>
            <span className="text-border text-xs" aria-hidden>|</span>
            <a
              href={opp.highMarket.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-mono text-[11px] text-accent hover:text-accent-bright transition-colors duration-100 uppercase tracking-widest"
            >
              <ExternalLink size={11} strokeWidth={1.5} />
              OPEN ON {platformLabel(opp.highMarket.platform)} →
            </a>
          </div>

          {/* Profit calculator */}
          <Calculator opp={opp} />
        </div>
      )}

    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PredictionPage() {
  const [data,      setData]      = useState<ApiResponse | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [expanded,  setExpanded]  = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);

  const loadData = useCallback(async () => {
    try {
      const res  = await fetch('/api/prediction');
      const json: ApiResponse = await res.json();
      setData(json);
      setFetchedAt(new Date());
    } catch {
      // keep previous data on transient error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const t = setInterval(loadData, 30_000);
    return () => clearInterval(t);
  }, [loadData]);

  const stats     = data?.stats;
  const opps      = data?.valid ?? [];
  const freshness = data?.freshness ?? null;

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-6">

      {/* Page header */}
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-5">
        <div>
          <h1 className="font-mono text-sm uppercase tracking-widest text-text-primary">
            PREDICTION MARKET ARBITRAGE
          </h1>
          <p className="font-mono text-[10px] text-text-muted mt-0.5">
            CROSS-PLATFORM · AI-MATCHED · FEE-ADJUSTED NET ROI
          </p>
        </div>
        {fetchedAt && (
          <span className="font-mono text-[10px] text-text-muted">
            LAST FETCH {fetchedAt.toLocaleTimeString('en-GB')}
          </span>
        )}
      </div>

      {/* Freshness banner — always visible once loaded */}
      {!loading && (
        <div className={`mb-4 px-3 py-2 border font-mono text-[11px] uppercase tracking-widest flex items-center gap-2 ${
          freshness?.isFresh
            ? 'border-positive/30 bg-positive/5 text-positive/80'
            : 'border-warning/30 bg-warning/5 text-warning/80'
        }`}>
          {freshness?.isFresh ? (
            <>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-positive animate-pulse shrink-0" />
              LIVE — MATCHER DATA FRESH ({freshness.ageMinutes}m OLD)
            </>
          ) : freshness?.updatedAt ? (
            <>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning/60 shrink-0" />
              NOT LIVE RIGHT NOW — MATCHER LAST RAN {freshness.label}
            </>
          ) : (
            'MATCHER NOT RUN YET — NO LIVE DATA'
          )}
        </div>
      )}

      {/* Stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-5">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} h="h-16" />)
        ) : (
          <>
            <StatPanel
              label="VALID OPPORTUNITIES"
              value={String(stats?.validCount ?? 0)}
              sub={`${data?.rejected ?? 0} REJECTED BY VALIDATION`}
            />
            <StatPanel
              label="MARKETS TRACKED"
              value={stats?.marketsTracked ? String(stats.marketsTracked) : '—'}
              sub="ACROSS 4 PLATFORMS"
            />
            <StatPanel
              label="CASHABLE / SIGNAL"
              value={`${stats?.cashableCount ?? 0} / ${stats?.signalCount ?? 0}`}
              sub="REAL MONEY / PLAY MONEY"
            />
            <StatPanel
              label="BEST NET ROI"
              value={stats?.bestRoi != null ? `+${stats.bestRoi.toFixed(1)}%` : '—'}
              sub="CASHABLE ONLY · FEES DEDUCTED"
            />
          </>
        )}
      </div>

      {/* Opportunity list */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} h="h-[88px]" />)}
        </div>
      ) : opps.length === 0 ? (
        <div className="border border-border px-6 py-16 text-center">
          <div className="font-mono text-sm text-text-secondary uppercase tracking-widest mb-2">
            NO VALID PREDICTION ARB FOUND
          </div>
          <div className="font-mono text-[10px] text-text-muted">
            {(data?.rejected ?? 0) > 0
              ? `${data!.rejected} ENTR${data!.rejected === 1 ? 'Y' : 'IES'} FAILED VALIDATION (ROI > 50%, NULL PRICES, MISSING URLS)`
              : freshness?.isFresh
                ? 'MATCHER RAN RECENTLY BUT FOUND NO EXPLOITABLE SPREAD'
                : freshness?.updatedAt
                  ? `LAST MATCHER RUN: ${freshness.label} — RUN MATCHER TO REFRESH DATA`
                  : 'MATCHER HAS NOT BEEN RUN YET — NO DATA AVAILABLE'}
          </div>
        </div>
      ) : (
        <>
          <div className="font-mono text-[10px] text-text-muted uppercase tracking-widest mb-3">
            {opps.length} VALID · {data!.rejected} REJECTED · CASHABLE FIRST · SORTED BY NET ROI DESC
          </div>
          {opps.map(opp => (
            <OppRow
              key={opp.id}
              opp={opp}
              isExpanded={expanded === opp.id}
              onToggle={() => setExpanded(prev => prev === opp.id ? null : opp.id)}
            />
          ))}
        </>
      )}

    </div>
  );
}
