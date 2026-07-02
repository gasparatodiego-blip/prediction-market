'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Lock, ArrowLeft, ExternalLink, ShieldCheck } from 'lucide-react';
import PlatformLogo from '@/components/PlatformLogo';
import {
  PlatformComparatorTable,
  DeployCalculator,
  AutoExecutePanel,
  findValidMatch,
} from '../../_components/EventCard';
import { platformLabel, formatCents, formatResolutionDate } from '../../_components/format';
import type { ApiResponse, EventBucket, LockableEdge } from '../../_components/types';

// ── Step label — mirrors the numbered-step styling used on the pairwise
// opportunity detail page (app/dashboard/prediction/[id]/page.tsx) so both
// detail views read as one system. ─────────────────────────────────────────
function StepLabel({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex items-start gap-3 mb-2">
      <span className="font-mono text-[10px] px-1.5 py-[2px] border border-line text-muted shrink-0 mt-0.5">
        {String(n).padStart(2, '0')}
      </span>
      <span className="font-body text-[13px] text-ink font-semibold">{text}</span>
    </div>
  );
}

function eventPlatformUrl(event: EventBucket, legId: string): string | null {
  return event.platforms.find(p => p.legId === legId)?.marketUrl ?? null;
}

// ── OPERATIONAL STEPS — only rendered when a real lockable edge exists
// (edge.matchedOpportunity is non-null). Steps 1-2 are the buy instructions
// with deep links; Step 3 hands off to the shared DeployCalculator (single-
// sourced size/cost/ROI/depth/copy/auto-execute math, same component the
// comparator card uses); Step 4 is the hold-to-resolution note + risk line.
function OperationalSteps({
  event,
  edge,
  valid,
}: {
  event: EventBucket;
  edge: LockableEdge;
  valid: ApiResponse['valid'];
}) {
  const mo = edge.matchedOpportunity!;
  const validMatch = findValidMatch(edge, valid);
  const yesUrl = eventPlatformUrl(event, edge.yesLegId);
  const noUrl  = eventPlatformUrl(event, edge.noLegId);

  return (
    <div className="mt-6">
      <h2 className="font-display font-bold text-base text-ink mb-1">Operational steps</h2>
      <p className="font-body text-[12.5px] text-muted mb-4">
        A lockable edge exists — here&apos;s exactly how to capture it.
      </p>

      <div className="space-y-5">
        <div>
          <StepLabel n={1} text={`Buy YES on ${platformLabel(edge.yesPlatform)} at ${formatCents(edge.yesPrice)}`} />
          <div className="ml-[42px]">
            {yesUrl ? (
              <a
                href={yesUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 font-body text-xs px-3 py-1.5 rounded-button border border-mint-deep/30 text-mint-deep hover:border-mint-deep transition-colors duration-150"
              >
                <PlatformLogo platform={edge.yesPlatform} size={12} />
                Open on {platformLabel(edge.yesPlatform)}
                <ExternalLink size={12} />
              </a>
            ) : (
              <p className="font-body text-xs text-muted">link unavailable for {platformLabel(edge.yesPlatform)}</p>
            )}
          </div>
        </div>

        <div>
          <StepLabel n={2} text={`Buy NO on ${platformLabel(edge.noPlatform)} at ${formatCents(edge.noPrice)}`} />
          <div className="ml-[42px]">
            {noUrl ? (
              <a
                href={noUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 font-body text-xs px-3 py-1.5 rounded-button border border-violet/30 text-violet hover:border-violet transition-colors duration-150"
              >
                <PlatformLogo platform={edge.noPlatform} size={12} />
                Open on {platformLabel(edge.noPlatform)}
                <ExternalLink size={12} />
              </a>
            ) : (
              <p className="font-body text-xs text-muted">link unavailable for {platformLabel(edge.noPlatform)}</p>
            )}
          </div>
        </div>

        <div>
          <StepLabel n={3} text="Size your position — capped by live book depth" />
          <div className="ml-[42px]">
            <DeployCalculator event={event} edge={edge} mo={mo} validMatch={validMatch} />
          </div>
        </div>

        <div>
          <StepLabel n={4} text="Hold both legs until resolution" />
          <div className="ml-[42px] font-body text-[12.5px] text-ink-2 leading-relaxed">
            <p>
              Resolves <span className="font-medium text-ink">{formatResolutionDate(mo.resolutionDate)}</span>
              {mo.daysToResolution != null && <span className="text-muted"> · ~{mo.daysToResolution}d away</span>}.
              One side pays $1/share, the other $0 — your capital unlocks at resolution, not before.
            </p>
          </div>
        </div>
      </div>

      {/* Risk line */}
      <div className="mt-5 px-4 py-3 rounded-card border border-gold/30 bg-gold-tint font-body text-[11px] text-gold leading-relaxed">
        Capital is locked until resolution. Both legs must fill or you carry a one-sided directional
        position. Prices and size shown are from the live order book and can move before you execute.
      </div>
    </div>
  );
}

// ── NO EDGE — honest-engine: never fabricate steps. The exact wording depends
// on why there's no confirmed edge, computed from data actually on the bucket
// (never guessed): fewer than 2 executable venues, or a cheapest-executable
// pair that hasn't cleared full match verification yet. combinedCost is the
// same yesAsk+(1-noBid) sum shared-matcher.js already computed for the edge —
// this only re-displays it, never recomputes arb math independently.
function NoEdgeExplanation({ event }: { event: EventBucket }) {
  const edge = event.lockableEdge;

  if (!edge) {
    return (
      <p className="font-body text-[13px] text-ink-2 leading-relaxed">
        No lockable edge right now — fewer than two executable venues (Kalshi/Polymarket) are quoting this event.
      </p>
    );
  }

  const yesCents = Math.round(edge.yesPrice * 100);
  const noCents  = Math.round(edge.noPrice * 100);
  const sumCents = yesCents + noCents;
  const clearsRawCost = sumCents < 100;

  return (
    <div className="space-y-3">
      <p className="font-body text-[13px] text-ink-2 leading-relaxed">
        No lockable edge right now — the cheapest executable YES ({yesCents}¢ on {platformLabel(edge.yesPlatform)}) +
        NO ({noCents}¢ on {platformLabel(edge.noPlatform)}) = {sumCents}¢.{' '}
        {clearsRawCost
          ? 'That raw sum is under 100¢, but this exact pair hasn’t cleared full match verification (same-event confirmation, confidence, and capacity checks) yet — no trade steps are shown until it’s confirmed.'
          : `This would become lockable if the combined executable cost drops below 100¢ (currently ${sumCents}¢).`}
      </p>
      <div className="flex flex-wrap gap-4 px-4 py-3 rounded-card border border-line bg-bg-soft/40 font-mono text-xs">
        <span>
          <span className="text-muted font-body">Best YES: </span>
          <PlatformLogo platform={edge.yesPlatform} size={12} className="inline mx-1 -mt-0.5" />
          {platformLabel(edge.yesPlatform)} <span className="text-ink font-semibold">{formatCents(edge.yesPrice)}</span>
        </span>
        <span>
          <span className="text-muted font-body">Best NO: </span>
          <PlatformLogo platform={edge.noPlatform} size={12} className="inline mx-1 -mt-0.5" />
          {platformLabel(edge.noPlatform)} <span className="text-ink font-semibold">{formatCents(edge.noPrice)}</span>
        </span>
      </div>
      <p className="font-body text-[11px] text-muted">Reference only — no buy instructions until a confirmed lockable edge exists.</p>
    </div>
  );
}

function EventDetail({ event, valid }: { event: EventBucket; valid: ApiResponse['valid'] }) {
  const edge = event.lockableEdge;
  const hasLockableEdge = !!edge?.matchedOpportunity;

  return (
    <>
      {/* Header */}
      <div className="mb-5">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="font-body font-semibold text-[10px] uppercase tracking-wide px-1.5 py-[2px] rounded-md bg-violet-tint text-violet">
            {event.category}
          </span>
          <span className="flex items-center gap-1 font-body text-[11px] text-muted">
            <Lock size={11} />
            resolves {formatResolutionDate(event.resolutionDate)}
          </span>
        </div>
        <h1 className="font-display font-bold text-xl text-ink leading-snug">{event.title}</h1>
      </div>

      {/* Price comparator */}
      <div className="rounded-card shadow-card bg-surface px-5 py-5 mb-2">
        <h2 className="font-display font-bold text-base text-ink mb-3">Price comparator</h2>
        <PlatformComparatorTable event={event} />
      </div>

      {/* Operational steps or calm no-edge explanation */}
      {hasLockableEdge && edge ? (
        <OperationalSteps event={event} edge={edge} valid={valid} />
      ) : (
        <div className="rounded-card shadow-card bg-surface px-5 py-5 mt-6">
          <h2 className="font-display font-bold text-base text-ink mb-3">Operational steps</h2>
          <NoEdgeExplanation event={event} />
          <div className="mt-4 pt-4 border-t border-line">
            <AutoExecutePanel noEdgeYet />
          </div>
        </div>
      )}
    </>
  );
}

export default function EventDetailPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id);

  const [data,    setData]    = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res  = await fetch('/api/prediction', { cache: 'no-store' });
      const json: ApiResponse = await res.json();
      setData(json);
    } catch { /* keep stale */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const event = data?.events?.find(e => e.eventKey === id) ?? null;

  return (
    <div className="max-w-[860px] mx-auto px-4 py-6">
      {/* Back nav */}
      <div className="mb-5">
        <Link
          href="/dashboard/prediction"
          className="inline-flex items-center gap-1 font-body text-[11px] text-muted hover:text-ink transition-colors duration-100"
        >
          <ArrowLeft size={12} />
          Back to Prediction Markets
        </Link>
      </div>

      {loading ? (
        <div className="py-20 text-center font-body text-[10px] uppercase tracking-widest text-muted animate-pulse">
          Loading…
        </div>
      ) : !data ? (
        <div className="py-20 text-center font-body text-[11px] text-coral-ink">
          Data unavailable — matcher pipeline not running.
        </div>
      ) : !event ? (
        <div className="rounded-card shadow-card bg-surface px-6 py-14 text-center">
          <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-mint-tint text-mint-deep flex items-center justify-center">
            <ShieldCheck size={22} />
          </div>
          <p className="font-body text-base text-ink-2 mb-2">Event not found or no longer live</p>
          <p className="font-body text-sm text-muted max-w-md mx-auto leading-relaxed mb-4">
            This event bucket may have rolled off the current scan, or the link is stale.
          </p>
          <Link href="/dashboard/prediction" className="font-body text-[12px] font-medium text-mint-deep hover:text-mint">
            ← Return to comparator
          </Link>
        </div>
      ) : (
        <EventDetail event={event} valid={data.valid} />
      )}
    </div>
  );
}
