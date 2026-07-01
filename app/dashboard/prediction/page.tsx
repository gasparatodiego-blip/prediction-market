'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import Eyebrow from '@/app/components/ui/Eyebrow';
import SectionHeading from '@/app/components/ui/SectionHeading';
import StatCard from '@/app/components/ui/StatCard';
import BlipRow from '@/app/components/ui/BlipRow';
import EdgeChip, { type EdgeChipVariant } from '@/app/components/ui/EdgeChip';
import PlatformLogo from '@/components/PlatformLogo';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Leg {
  platform:    string;
  probability: number;
  url:         string;
  urlVerified: boolean;
  fee:         number;
  expiresAt:   number | null;
  yesBid?:     number | null;
  yesAsk?:     number | null;
}

interface Opportunity {
  id:                  string;
  question:            string;
  lowMarket:           Leg;
  highMarket:          Leg;
  spread:              number;
  roi:                 number;
  earnPer100:          number | null;
  confidence:          number;
  category:            string;
  type:                'cashable' | 'signal';
  annualizedROI?:      number | null;
  daysToResolution?:   number | null;
  resolutionDate?:     string | null;
  confirmReason?:      string | null;
  lockupFlag?:         string | null;
  capacityUsd?:        number | null;
  nonCashableReason?:  string | null;
  confidenceNote?:     string | null;
  capacityNote?:       string | null;
}

interface Stats {
  validCount:               number;
  cashableCount:            number;
  signalCount:              number;
  confirmedCashable:        number;
  totalCashableCandidates:  number;
  evaporated?:              number;
  inactive?:                number;
  pendingVerification:      number;
  bestRoi:                  number | null;
  marketsTracked:           number;
  platforms:                number;
  updatedAt:                number | null;
  pipelineAge:              number | null;
}

interface Freshness {
  pricesAt:        number | null;
  discoveryAt:     number | null;
  nextDiscoveryAt: number | null;
  repriceStale:    boolean;
  discoveryStale:  boolean;
  repriceAgeMin:   number | null;
  discoveryAgeMin: number | null;
  repriceLabel:    string | null;
  discoveryLabel:  string | null;
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
    kalshi: 'Kalshi', polymarket: 'Polymarket',
    predictit: 'PredictIt', manifold: 'Manifold', oddsapi: 'Odds API',
  };
  return MAP[p?.toLowerCase()] ?? p;
}

function categoryIcon(cat: string): string {
  const c = cat?.toLowerCase() ?? '';
  if (c.includes('politic') || c.includes('election')) return '🗳';
  if (c.includes('sport')   || c.includes('nfl') || c.includes('nba')) return '⚽';
  if (c.includes('crypto')  || c.includes('bitcoin') || c.includes('btc')) return '₿';
  if (c.includes('finance') || c.includes('econ')) return '📈';
  if (c.includes('weather')) return '🌤';
  return '🔍';
}

function chipVariant(opp: Opportunity): EdgeChipVariant {
  if (opp.type === 'cashable') return 'cashable';
  const reason = opp.nonCashableReason;
  if (reason === 'stage_mismatch') return 'trap';
  if (reason === 'play_money')     return 'paper';
  return 'signal';
}

function reasonNote(opp: Opportunity): string | null {
  if (opp.type === 'cashable') return null;
  const reason = opp.nonCashableReason;
  if (reason === 'play_money')     return 'mid-price or play money — signal only';
  if (reason === 'stage_mismatch') return 'resolution criteria differ';
  if (reason === 'low_confidence') return opp.confidenceNote
    ? `confidence ${opp.confidenceNote}`
    : 'confidence below threshold';
  if (reason === 'small_capacity') return opp.capacityNote
    ? `capacity ${opp.capacityNote}`
    : 'capacity below minimum';
  return 'spread collapses at executable depth';
}

function nextCheckMin(freshness: Freshness | null): number {
  if (!freshness?.nextDiscoveryAt) return 180;
  return Math.max(1, Math.round((freshness.nextDiscoveryAt - Date.now()) / 60_000));
}

// ── Countdown ─────────────────────────────────────────────────────────────────

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

  if (!expiresAt) return <span className="font-body text-[11px] text-muted">no expiry</span>;
  return <span className="font-body text-[11px] tabular-nums text-ink-2">{text}</span>;
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

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
    <div className="rounded-card shadow-card bg-surface px-4 py-3 animate-pulse flex items-center gap-3">
      <div className="w-10 h-10 bg-bg-soft rounded-[11px] flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="h-3 bg-bg-soft rounded w-3/4" />
        <div className="h-2.5 bg-bg-soft rounded w-1/2" />
      </div>
      <div className="w-12 h-5 bg-bg-soft rounded" />
    </div>
  );
}

// ── Opportunity row ───────────────────────────────────────────────────────────

function OppRow({ opp }: { opp: Opportunity }) {
  const variant  = chipVariant(opp);
  const note     = reasonNote(opp);
  const expiry   = opp.lowMarket.expiresAt ?? opp.highMarket.expiresAt ?? null;
  const conf     = Math.round(opp.confidence * 100);
  const noPriceHigh = 100 - opp.highMarket.probability;

  const tileColor = variant === 'cashable' ? 'mint'
    : variant === 'speculative'            ? 'gold'
    : 'violet';

  const subTail = [`conf ${conf}%`];
  if (note) subTail.push(note);

  return (
    <Link
      href={`/dashboard/prediction/${encodeURIComponent(opp.id)}`}
      className="block rounded-card shadow-card bg-surface hover:shadow-[0_2px_8px_rgba(11,26,21,.09)] transition-shadow duration-150"
    >
      <BlipRow
        icon={categoryIcon(opp.category)}
        tileColor={tileColor}
        name={opp.question}
        sub={
          <>
            <PlatformLogo platform={opp.lowMarket.platform} size={11} className="mr-0.5" />
            {platformLabel(opp.lowMarket.platform)} ×{' '}
            <PlatformLogo platform={opp.highMarket.platform} size={11} className="mx-0.5" />
            {platformLabel(opp.highMarket.platform)} · {subTail.join(' · ')}
          </>
        }
        chip={variant}
        value={`${opp.spread.toFixed(1)}%`}
        unit={
          opp.earnPer100 != null && opp.type === 'cashable'
            ? `$${opp.earnPer100.toFixed(2)} per $100`
            : 'spread'
        }
        valueTone={opp.type === 'cashable' ? 'up' : 'neutral'}
      />
      {/* Expiry row — only shown when data exists */}
      {expiry && (
        <div className="px-4 pb-3 flex items-center gap-2">
          <span className="font-body text-[11px] text-muted uppercase tracking-wide">expires</span>
          <Countdown expiresAt={expiry} />
        </div>
      )}
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
  const isStale   = freshness?.repriceStale || freshness?.discoveryStale;

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-8">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <Eyebrow className="mb-1">Prediction Markets</Eyebrow>
          <SectionHeading as="h1" className="text-2xl">
            Cross-Platform Arbitrage
          </SectionHeading>
          <p className="font-body text-sm text-muted mt-1">
            Polymarket · Kalshi · PredictIt · Manifold — AI-confirmed pairs, fee-adjusted net ROI
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <a
            href="https://t.me/Gaspola_bot?start=pred_new"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-body text-sm px-4 py-2 rounded-button border border-line text-muted hover:border-mint/40 hover:text-ink-2 transition-colors duration-150 whitespace-nowrap"
          >
            Telegram alerts
          </a>
          {fetchedAt && !loading && (
            <span className="font-body text-[12px] text-muted">
              Updated {fetchedAt.toLocaleTimeString('en-GB')}
            </span>
          )}
        </div>
      </div>

      {/* ── Freshness bar ───────────────────────────────────────────────────── */}
      {!loading && (
        <div className={`mb-6 px-4 py-3 rounded-card border font-body text-[12px] ${
          isStale
            ? 'border-gold/30 bg-gold-tint text-gold'
            : 'border-line bg-surface text-muted'
        }`}>
          <div className="flex flex-wrap gap-x-5 gap-y-1 items-center">
            {/* Prices */}
            <span className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                freshness?.repriceStale ? 'bg-gold' : 'bg-mint'
              }`} />
              {freshness?.pricesAt
                ? <>Prices {new Date(freshness.pricesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · refresh ~15 min</>
                : freshness?.discoveryAt
                  ? 'Prices from discovery snapshot — re-pricer starting'
                  : 'No price data yet'}
              {freshness?.repriceStale && freshness.repriceLabel && (
                <span className="text-gold"> ({freshness.repriceLabel} — stalled?)</span>
              )}
            </span>

            <span className={isStale ? 'text-gold/40' : 'text-line'}>|</span>

            {/* Discovery */}
            <span className="flex items-center gap-1.5">
              {freshness?.discoveryStale && (
                <span className="w-1.5 h-1.5 rounded-full bg-gold flex-shrink-0" />
              )}
              {freshness?.discoveryAt ? (
                <>
                  Markets rescanned {new Date(freshness.discoveryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {freshness.nextDiscoveryAt != null && (
                    <> · next {new Date(freshness.nextDiscoveryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</>
                  )}{' '}· 3h cadence
                </>
              ) : 'Discovery not run yet'}
              {freshness?.discoveryStale && freshness.discoveryLabel && (
                <span className="text-gold"> ({freshness.discoveryLabel} — missed slot?)</span>
              )}
            </span>
          </div>
        </div>
      )}

      {/* ── Stats strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <CardSkeleton key={i} />)
        ) : (
          <>
            <StatCard
              label="Confirmed arb"
              value={`${stats?.cashableCount ?? 0}`}
              note={
                (stats?.cashableCount ?? 0) === 0
                  ? `Checking again in ${nextCheckMin(freshness)}m`
                  : `of ${stats?.totalCashableCandidates ?? stats?.cashableCount ?? 0} candidates assessed`
              }
            />
            <StatCard
              label="Markets tracked"
              value={stats?.marketsTracked ? String(stats.marketsTracked) : '—'}
              note="across 4 platforms"
            />
            <StatCard
              label="Signals watching"
              value={`${stats?.signalCount ?? 0}`}
              note="divergence detected, below threshold"
            />
            <StatCard
              label="Quarantined"
              value={`${data?.rejected ?? 0}`}
              note="excluded — ROI > 50%, bad URLs, or mismatch"
            />
          </>
        )}
      </div>

      {/* ── Opportunity list ─────────────────────────────────────────────────── */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => <RowSkeleton key={i} />)}
        </div>
      ) : opps.length === 0 ? (
        <div className="rounded-card shadow-card bg-surface px-6 py-16 text-center">
          <p className="font-display font-bold text-4xl text-ink mb-3">0</p>
          <p className="font-body text-base text-ink-2 mb-1">
            No confirmed arb right now — checking again in {nextCheckMin(freshness)}m
          </p>
          <p className="font-body text-sm text-muted">
            {(stats?.signalCount ?? 0) > 0
              ? `${stats!.signalCount} signal${stats!.signalCount !== 1 ? 's' : ''} detected below confidence threshold`
              : (data?.rejected ?? 0) > 0
                ? `${data!.rejected} entr${data!.rejected === 1 ? 'y' : 'ies'} quarantined — ROI > 50%, null prices, or resolution mismatch`
                : freshness?.discoveryAt
                  ? 'Last scan found no same-event divergence above threshold'
                  : 'Matcher has not run yet'}
          </p>
        </div>
      ) : (
        <>
          {/* Cashable arb section */}
          {opps.some(o => o.type === 'cashable') && (
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <EdgeChip variant="cashable" />
                <span className="font-body text-[12px] text-muted">
                  {opps.filter(o => o.type === 'cashable').length} confirmed executable — both legs verified, confidence ≥ 85%, capacity ≥ $50
                </span>
              </div>
              <div className="space-y-3">
                {opps.filter(o => o.type === 'cashable').map(opp => (
                  <OppRow key={opp.id} opp={opp} />
                ))}
              </div>
            </div>
          )}

          {/* Signal / paper section */}
          {opps.some(o => o.type === 'signal') && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <EdgeChip variant="signal" />
                <span className="font-body text-[12px] text-muted">
                  {opps.filter(o => o.type === 'signal').length} signal{opps.filter(o => o.type === 'signal').length !== 1 ? 's' : ''} — divergence detected, not yet executable
                </span>
              </div>
              <div className="space-y-3">
                {opps.filter(o => o.type === 'signal').map(opp => (
                  <OppRow key={opp.id} opp={opp} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

    </div>
  );
}
