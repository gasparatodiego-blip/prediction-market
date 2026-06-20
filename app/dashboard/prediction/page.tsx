'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Leg {
  platform:    string;
  probability: number;   // 0–100 (cents equivalent)
  url:         string;
  fee:         number;   // 0–1 fraction
  expiresAt:   number | null;
  yesBid?:     number | null;
  yesAsk?:     number | null;
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
  resolutionDate?:  string | null;
  confirmReason?:   string | null;
  lockupFlag?:      string | null;
}

interface Stats {
  validCount:               number;
  cashableCount:            number;
  signalCount:              number;
  confirmedCashable:        number;
  totalCashableCandidates:  number;
  pendingVerification:      number;
  bestRoi:                  number | null;
  marketsTracked:           number;
  platforms:                number;
  updatedAt:                number | null;
  pipelineAge:              number | null;
}

interface Freshness {
  updatedAt:  number | null;
  ageMinutes: number | null;
  isOverdue:  boolean;
  nextRunAt:  number | null;
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

// ── Opportunity row ───────────────────────────────────────────────────────────

function OppRow({ opp }: { opp: Opportunity }) {
  const isCashable        = opp.type === 'cashable';
  const noPriceHighMarket = 100 - opp.highMarket.probability;
  const expiry            = opp.lowMarket.expiresAt ?? opp.highMarket.expiresAt ?? null;

  return (
    <Link
      href={`/dashboard/prediction/${encodeURIComponent(opp.id)}`}
      className="block border border-border mb-1.5 last:mb-0 hover:border-accent/40 transition-colors duration-100"
    >
      <div className="px-4 py-3">
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

          {/* Trade legs */}
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

          {/* Arrow */}
          <div className="shrink-0 self-center text-text-muted">
            <ChevronRight size={13} />
          </div>

        </div>
      </div>
    </Link>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PredictionPage() {
  const [data,      setData]      = useState<ApiResponse | null>(null);
  const [loading,   setLoading]   = useState(true);
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
            CROSS-PLATFORM · IDF PAIR + AI-CONFIRMED · FEE-ADJUSTED NET ROI
          </p>
        </div>
        {fetchedAt && (
          <span className="font-mono text-[10px] text-text-muted">
            LAST FETCH {fetchedAt.toLocaleTimeString('en-GB')}
          </span>
        )}
      </div>

      {/* Snapshot freshness line — warning only if a scheduled run was genuinely missed */}
      {!loading && (
        <div className={`mb-4 px-3 py-2 border font-mono text-[11px] uppercase tracking-widest flex items-center gap-2 ${
          freshness?.isOverdue
            ? 'border-warning/30 bg-warning/5 text-warning/80'
            : 'border-border bg-bg-panel text-text-muted'
        }`}>
          {freshness?.isOverdue ? (
            <>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning/60 shrink-0" />
              LAST SNAPSHOT {freshness.label} — UPDATE MAY BE DELAYED
            </>
          ) : freshness?.updatedAt ? (
            <>
              SNAPSHOT FROM {new Date(freshness.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {freshness.nextRunAt != null && (
                <> · NEXT UPDATE {new Date(freshness.nextRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</>
              )}
              {' '}· 8H CADENCE
            </>
          ) : (
            'NO SNAPSHOT YET — MATCHER HAS NOT RUN'
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
              label="OPPORTUNITIES"
              value={`${stats?.cashableCount ?? 0} CASHABLE`}
              sub={`${stats?.signalCount ?? 0} SIGNAL · ${data?.rejected ?? 0} REJECTED`}
            />
            <StatPanel
              label="MARKETS TRACKED"
              value={stats?.marketsTracked ? String(stats.marketsTracked) : '—'}
              sub="ACROSS 4 PLATFORMS"
            />
            <StatPanel
              label="CONFIRMED CASHABLE"
              value={String(stats?.confirmedCashable ?? stats?.cashableCount ?? 0)}
              sub={
                (stats?.totalCashableCandidates ?? 0) > (stats?.confirmedCashable ?? 0)
                  ? `${(stats?.totalCashableCandidates ?? 0).toLocaleString()} CANDIDATES · ${(stats?.pendingVerification ?? 0).toLocaleString()} PENDING AI VERIFICATION`
                  : 'AI-VERIFIED · SIGNAL: ' + (stats?.signalCount ?? 0)
              }
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
              : freshness?.updatedAt
                ? 'LAST SNAPSHOT FOUND NO EXPLOITABLE SPREAD ABOVE THRESHOLD'
                : 'NO SNAPSHOT YET — MATCHER HAS NOT RUN'}
          </div>
        </div>
      ) : (
        <>
          <div className="font-mono text-[10px] text-text-muted uppercase tracking-widest mb-3">
            {stats?.cashableCount ?? opps.filter(o => o.type === 'cashable').length} CASHABLE
            {' · '}{stats?.signalCount ?? opps.filter(o => o.type === 'signal').length} SIGNAL
            {' · '}{data!.rejected} REJECTED · SORTED BY NET ROI DESC
          </div>
          {opps.map(opp => (
            <OppRow key={opp.id} opp={opp} />
          ))}
        </>
      )}

    </div>
  );
}
