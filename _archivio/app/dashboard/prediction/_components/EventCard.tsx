'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Lock, ExternalLink, Copy, Check, KeyRound, ShieldAlert } from 'lucide-react';
import PlatformLogo from '@/components/PlatformLogo';
import { Redacted } from '@/app/components/ui/Redacted';
import { PlatformLink } from '@/app/components/ui/PlatformLink';
import { AUTO_EXECUTE_ENABLED } from '@/lib/flags';
import type { EventBucket, EventPlatform, LockableEdge, MatchedOpportunity, Opportunity, Leg } from './types';
import { platformLabel, formatCents, formatVolume, formatResolutionDate } from './format';

// ── ARB edge badge (honest-engine) ─────────────────────────────────────────────
// A prominent badge lights up ONLY when a REAL executable lockable edge exists.
// The edge % is NOT recomputed here — it is the matcher's already-fee-adjusted
// matchedOpportunity.roi (agent5-calculator, the SSOT). This function only DECIDES
// whether that real edge is prominent-worthy, applying honest guards:
//   • lockableEdge/mo must exist (null on free tier → no badge, calm state);
//   • ROI must be positive (cleared the fee/executable threshold);
//   • BOTH named legs must be EXECUTABLE venues in this bucket (REF/median venues
//     — PredictIt/Manifold/Futuur — and the market median can NEVER form an edge);
//   • neither leg near 0¢/100¢ (edge there is liquidity/rounding noise);
//   • an implausibly wide edge (>PLAUSIBLE_MAX_PCT) is flagged "check", not shiny.
const NEAR_ZERO_PRICE   = 0.03;   // 3¢  (yes/no prices are fractions 0–1)
const NEAR_ONE_PRICE    = 0.97;   // 97¢
const PLAUSIBLE_MAX_PCT = 8;      // >8% net on a liquid two-venue lock → likely stale/mismatch

export interface ArbBadge {
  edgePct:     number;   // real net-of-fee guaranteed total ROI % (mo.roi)
  implausible: boolean;  // > PLAUSIBLE_MAX_PCT → show muted "check", never a shiny badge
  yesPlatform: string; yesPrice: number;
  noPlatform:  string; noPrice:  number;
}

export function arbBadge(event: EventBucket): ArbBadge | null {
  const edge = event.lockableEdge;
  const mo   = edge?.matchedOpportunity ?? null;
  if (!edge || !mo) return null;                       // no edge (or gated null on free) → no badge
  if (mo.roi == null || mo.roi <= 0) return null;      // must clear the executable/fee threshold
  // EXEC-only enforcement: both legs must be executable venues in THIS bucket.
  const yp = event.platforms.find(p => p.platform === edge.yesPlatform && p.tier === 'executable');
  const np = event.platforms.find(p => p.platform === edge.noPlatform  && p.tier === 'executable');
  if (!yp || !np) return null;                         // a leg is reference-only → never a lockable arb
  // near-0/near-100¢ legs → edge is noise, not a real arb
  if (edge.yesPrice < NEAR_ZERO_PRICE || edge.yesPrice > NEAR_ONE_PRICE) return null;
  if (edge.noPrice  < NEAR_ZERO_PRICE || edge.noPrice  > NEAR_ONE_PRICE) return null;
  return {
    edgePct: mo.roi,
    implausible: mo.roi > PLAUSIBLE_MAX_PCT,
    yesPlatform: edge.yesPlatform, yesPrice: edge.yesPrice,
    noPlatform:  edge.noPlatform,  noPrice:  edge.noPrice,
  };
}

// Rank for the comparator sort — real arb (3) > wide "check" (2) > raw-edge (1) > none (0).
export function arbRank(event: EventBucket): number {
  const b = arbBadge(event);
  if (b && !b.implausible) return 3;
  if (b) return 2;
  return event.lockableEdge?.matchedOpportunity ? 1 : 0;
}

function ArbBadgeBar({ badge }: { badge: ArbBadge }) {
  if (badge.implausible) {
    return (
      <div className="mb-3 rounded-lg bg-gold-tint border border-gold/30 px-3 py-2 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
        <span className="font-body font-semibold text-gold text-[12px] tabular-nums">Check — unusually wide (+{badge.edgePct.toFixed(1)}%)</span>
        <span className="font-body text-[10.5px] text-gold/80">a &gt;{PLAUSIBLE_MAX_PCT}% two-venue lock is often stale/mismatched — verify both legs before trusting it</span>
      </div>
    );
  }
  return (
    <div className="mb-3 rounded-lg bg-mint-tint border border-mint-deep/30 px-3 py-2 flex items-center gap-x-2.5 gap-y-0.5 flex-wrap">
      <span className="font-display font-bold text-mint-deep text-[15px] tabular-nums leading-none">ARB +{badge.edgePct.toFixed(1)}%</span>
      <span className="font-body text-[11px] text-mint-deep/85 tabular-nums">
        Lock: buy YES @ {platformLabel(badge.yesPlatform)} {formatCents(badge.yesPrice)} + NO @ {platformLabel(badge.noPlatform)} {formatCents(badge.noPrice)}
      </span>
    </div>
  );
}

// Correlates a bucket's lockableEdge to the matching pairwise entry in `valid`
// (by platform pair + roi/spread, the only fields both shapes carry) so the
// calculator can read real capacityUsd/depth. attachMatchedOpportunity()
// (agent5-calculator.js) never includes the leg id in matchedOpportunity, so
// an exact-id join isn't possible here — this is a best-effort match, and the
// calculator falls back to "capacity unknown" rather than fabricating one
// when nothing lines up.
export function findValidMatch(edge: LockableEdge, valid: Opportunity[]): Opportunity | null {
  const mo = edge.matchedOpportunity;
  if (!mo) return null;
  return valid.find(o => {
    const plats = new Set([o.lowMarket.platform, o.highMarket.platform]);
    if (!(plats.has(edge.yesPlatform) && plats.has(edge.noPlatform))) return false;
    return o.roi != null && o.spread != null
      && Math.abs(o.roi - mo.roi) < 0.05 && Math.abs(o.spread - mo.spread) < 0.05;
  }) ?? null;
}

function eventPlatform(event: EventBucket, legId: string): EventPlatform | null {
  return event.platforms.find(p => p.legId === legId) ?? null;
}

// Short label on phone widths so the platform column never has to fight the
// chip for space; full word from sm: up, where there's room for it.
function TierBadge({ tier }: { tier: 'executable' | 'reference' }) {
  const isExecutable = tier === 'executable';
  return (
    <span
      className={`inline-flex items-center px-1.5 py-[2px] rounded-md font-body font-semibold text-[9px] uppercase tracking-wide flex-shrink-0 ${
        isExecutable ? 'bg-mint-tint text-mint-deep' : 'bg-bg-soft text-muted'
      }`}
    >
      <span className="sm:hidden">{isExecutable ? 'Exec' : 'Ref'}</span>
      <span className="hidden sm:inline">{isExecutable ? 'Executable' : 'Reference'}</span>
    </span>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {}
      }}
      className="inline-flex items-center gap-1.5 font-body font-medium text-xs px-3 py-1.5 rounded-button border border-line text-ink-2 hover:border-mint hover:text-mint-deep transition-colors duration-150"
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? 'Copied' : label}
    </button>
  );
}

// Order-book ladder for one executable leg. Labeled honestly as the leg's own
// YES-ask book — that's literally what /api/prediction's `depth` field is
// (see lib/depth.js), even for the leg used as the pair's NO side, so this
// never implies it's the fill price for a NO order.
function DepthLadder({ label, leg, deployable }: { label: string; leg: Leg | null; deployable: number }) {
  const levels = leg?.depth ?? null;
  return (
    <div className="mt-3">
      <p className="font-body text-[10.5px] text-muted uppercase tracking-wide mb-1">{label}</p>
      {!levels || levels.length === 0 ? (
        <p className="font-body text-[12px] text-muted">order book depth not available for this pair right now</p>
      ) : (
        (() => {
          let cum = 0;
          return (
            <div className="space-y-0.5">
              {levels.map((lvl, i) => {
                const fillable = cum < deployable;
                cum += lvl.sizeUsd;
                return (
                  <div
                    key={i}
                    className={`flex justify-between font-mono text-[11px] px-2 py-0.5 rounded tabular-nums ${
                      fillable ? 'bg-mint-tint text-mint-deep' : 'text-muted'
                    }`}
                  >
                    <span>{lvl.price.toFixed(1)}¢</span>
                    <span>${lvl.sizeUsd.toFixed(0)}</span>
                  </div>
                );
              })}
            </div>
          );
        })()
      )}
    </div>
  );
}

function ConnectKeysForm() {
  const [saved, setSaved] = useState(false);
  return (
    <div className="rounded-card border border-line bg-bg-soft/60 px-4 py-4">
      <div className="flex items-center gap-2 mb-2">
        <KeyRound size={14} className="text-ink-2" />
        <span className="font-body font-semibold text-sm text-ink">Connect keys</span>
      </div>
      <p className="font-body text-[11px] text-muted mb-3 leading-relaxed">
        Not implemented yet — this form does not store or transmit any key. Auto-copy will require
        API keys scoped per platform, custody of order placement (not funds) on Edgeradar's
        servers, and is subject to each platform's own terms and your local trading regulations.
      </p>
      <div className="space-y-2 mb-3">
        {['Kalshi', 'Polymarket'].map(p => (
          <input
            key={p}
            type="password"
            disabled
            placeholder={`${p} API key — coming soon`}
            className="w-full px-3 py-2 rounded-button bg-surface border border-line text-ink font-body text-xs placeholder:text-muted disabled:opacity-60"
          />
        ))}
      </div>
      <button
        type="button"
        disabled
        onClick={() => setSaved(true)}
        className="font-body font-medium text-xs px-3 py-1.5 rounded-button bg-mint-deep/40 text-white cursor-not-allowed"
      >
        {saved ? 'Saved' : 'Save (disabled)'}
      </button>
    </div>
  );
}

// noEdgeYet: this event currently has no confirmed lockable edge. The panel
// still renders (never gated behind an edge existing) but stays honest that
// there is nothing to auto-execute for this event until one is confirmed —
// regardless of whether AUTO_EXECUTE_ENABLED is on.
export function AutoExecutePanel({ noEdgeYet = false }: { noEdgeYet?: boolean }) {
  const { data: session } = useSession();

  if (!AUTO_EXECUTE_ENABLED) {
    return (
      <div className="rounded-card border border-line bg-bg-soft/60 px-4 py-4 opacity-70">
        <div className="flex items-center gap-2 mb-1.5">
          <KeyRound size={14} className="text-muted" />
          <span className="font-body font-semibold text-sm text-ink-2">Auto-execute · requires keys</span>
        </div>
        <p className="font-body text-[11px] text-muted leading-relaxed">
          Coming soon — currently disabled. Auto-copy will require linked platform API keys and a
          separate signed-in area; Edgeradar never touches funds directly.
          {noEdgeYet && ' This event also has no confirmed lockable edge right now, so there would be nothing to auto-execute here even once enabled.'}
        </p>
      </div>
    );
  }

  if (noEdgeYet) {
    return (
      <div className="rounded-card border border-line bg-bg-soft/60 px-4 py-4 opacity-70">
        <div className="flex items-center gap-2 mb-1.5">
          <KeyRound size={14} className="text-muted" />
          <span className="font-body font-semibold text-sm text-ink-2">Auto-execute · no edge yet</span>
        </div>
        <p className="font-body text-[11px] text-muted leading-relaxed">
          This event has no confirmed lockable edge right now, so there&apos;s nothing to auto-execute.
          This will activate for this event once a lockable edge is confirmed.
        </p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="rounded-card border border-line bg-bg-soft/60 px-4 py-4">
        <div className="flex items-center gap-2 mb-2">
          <KeyRound size={14} className="text-ink-2" />
          <span className="font-body font-semibold text-sm text-ink">Auto-execute · requires keys</span>
        </div>
        <p className="font-body text-[11px] text-muted mb-3 leading-relaxed">
          Sign in to connect platform API keys and enable auto-copy on this pair.
        </p>
        <Link
          href="/auth/login"
          className="inline-flex items-center gap-1.5 font-body font-medium text-xs px-3 py-1.5 rounded-button border border-mint/40 bg-mint/10 text-mint-deep hover:bg-mint/20 transition-colors duration-150"
        >
          Sign in to connect keys
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-1.5 font-body text-[11px] text-gold leading-relaxed">
        <ShieldAlert size={13} className="mt-[1px] flex-shrink-0" />
        <span>Auto-execute involves custody of order placement, regulatory exposure that varies by
          platform/region, and runs from a separate authenticated area from the public dashboard.</span>
      </div>
      <ConnectKeysForm />
    </div>
  );
}

// Platform-by-platform price table — executable tier first, reference tier
// after, plus the reference-median row. Shared between the compact comparator
// card and the event detail page so the arb-critical BEST tags and tiering
// can never drift between the two views.
// `side` filters the price columns to a single chosen side — 'yes' or 'no' shows
// only that side (the "side-only book" view the order page uses), 'both' (default)
// keeps the two-column compact-card layout byte-identical. When a side is chosen we
// also surface the real per-venue fee column (fee comes from /api/prediction, public).
export function PlatformComparatorTable({ event, side = 'both' }: { event: EventBucket; side?: 'both' | 'yes' | 'no' }) {
  const edge = event.lockableEdge;
  const bestYes = edge?.yesPlatform ?? null;
  const bestNo  = edge?.noPlatform  ?? null;

  const executable = event.platforms.filter(p => p.tier === 'executable');
  const reference   = event.platforms.filter(p => p.tier === 'reference');
  const rows = [...executable, ...reference];

  const showYes = side !== 'no';
  const showNo  = side !== 'yes';
  const showFee = side !== 'both';
  const fmtFee  = (f: number | undefined) => (typeof f === 'number' ? `${Math.round(f * 100)}%` : '—');

  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="font-body text-[10.5px] text-muted uppercase tracking-wide">
            <th className="px-1 pb-1.5 font-medium">Platform</th>
            {showYes && <th className="px-1 pb-1.5 font-medium">Yes</th>}
            {showNo  && <th className="px-1 pb-1.5 font-medium">No</th>}
            {showFee && <th className="px-1 pb-1.5 font-medium">Fee</th>}
            <th className="hidden sm:table-cell px-1 pb-1.5 font-medium text-right">Vol</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(p => {
            const isBestYes = p.tier === 'executable' && p.platform === bestYes;
            const isBestNo  = p.tier === 'executable' && p.platform === bestNo;
            return (
              <tr key={p.legId} className={p.tier === 'reference' ? 'opacity-55' : ''}>
                <td className="px-1 py-1.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <PlatformLogo platform={p.platform} size={13} />
                    <span className="font-body text-xs text-ink-2">{platformLabel(p.platform)}</span>
                    <TierBadge tier={p.tier} />
                    {p.marketUrl && <PlatformLink href={p.marketUrl} label={platformLabel(p.platform)} compact />}
                  </div>
                  <div className="sm:hidden font-mono text-[10px] text-muted mt-0.5 tabular-nums">
                    vol {formatVolume(p)}
                  </div>
                </td>
                {showYes && (
                  <td className={`px-1 py-1.5 font-mono text-xs tabular-nums ${isBestYes ? 'text-mint-deep font-semibold' : 'text-ink-2'}`}>
                    <Redacted value={p.yesPrice}>{v => formatCents(v)}</Redacted>
                    {isBestYes && <span className="ml-1.5 font-body font-bold text-[9px] text-mint-deep align-middle">BEST</span>}
                  </td>
                )}
                {showNo && (
                  <td className={`px-1 py-1.5 font-mono text-xs tabular-nums ${isBestNo ? 'text-mint-deep font-semibold' : 'text-ink-2'}`}>
                    <Redacted value={p.noPrice}>{v => formatCents(v)}</Redacted>
                    {isBestNo && <span className="ml-1.5 font-body font-bold text-[9px] text-mint-deep align-middle">BEST</span>}
                  </td>
                )}
                {showFee && (
                  <td className="px-1 py-1.5 font-mono text-xs text-muted tabular-nums">{fmtFee(p.fee)}</td>
                )}
                <td className="hidden sm:table-cell px-1 py-1.5 font-mono text-xs text-muted text-right tabular-nums">{formatVolume(p)}</td>
              </tr>
            );
          })}
          <tr className="opacity-55">
            <td className="px-1 py-1.5">
              <span className="font-body text-[10.5px] text-muted uppercase tracking-wide">
                Market median · reference only · not executable
              </span>
            </td>
            {showYes && (
              <td className="px-1 py-1.5 font-mono text-xs text-muted tabular-nums">
                <Redacted value={event.referenceMedian.yesPrice}>{v => formatCents(v)}</Redacted>
              </td>
            )}
            {showNo && (
              <td className="px-1 py-1.5 font-mono text-xs text-muted tabular-nums">
                <Redacted value={event.referenceMedian.yesPrice}>{v => formatCents(1 - v)}</Redacted>
              </td>
            )}
            {showFee && <td className="px-1 py-1.5 text-muted">—</td>}
            <td className="hidden sm:table-cell px-1 py-1.5 text-right text-muted">—</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function DeployCalculator({
  event,
  edge,
  mo,
  validMatch,
}: {
  event: EventBucket;
  edge: LockableEdge;
  mo: MatchedOpportunity;
  validMatch: Opportunity | null;
}) {
  const [capital, setCapital]         = useState(100);
  const [slippagePct, setSlippagePct] = useState(0);

  const capacity   = typeof validMatch?.capacityUsd === 'number' ? validMatch!.capacityUsd : null;
  const deployable = capacity != null ? Math.min(capital, capacity) : capital;
  const effRoiPct  = Math.max(0, mo.roi - slippagePct);
  const returnUsd  = deployable * (effRoiPct / 100);

  const yesLeg = validMatch
    ? (validMatch.lowMarket.platform === edge.yesPlatform ? validMatch.lowMarket : validMatch.highMarket)
    : null;
  const noLeg = validMatch
    ? (validMatch.lowMarket.platform === edge.noPlatform ? validMatch.lowMarket : validMatch.highMarket)
    : null;

  const yesUrl = eventPlatform(event, edge.yesLegId)?.marketUrl ?? null;
  const noUrl  = eventPlatform(event, edge.noLegId)?.marketUrl  ?? null;

  const copyText =
    `${event.title}\n` +
    `Buy YES @ ${formatCents(edge.yesPrice)} on ${platformLabel(edge.yesPlatform)}\n` +
    `Buy NO @ ${formatCents(edge.noPrice)} on ${platformLabel(edge.noPlatform)}\n` +
    `Total ROI: ${mo.roi.toFixed(2)}% · one-time · unlock ${formatResolutionDate(mo.resolutionDate)}`;

  return (
    <div className="mt-4 pt-4 border-t border-line">
      <div className="flex items-center gap-2 mb-1">
        <span className="w-1.5 h-1.5 rounded-full bg-mint flex-shrink-0" />
        <span className="font-body font-semibold text-sm text-ink">Lockable edge</span>
      </div>
      <p className="font-body text-[12.5px] text-ink-2 mb-3">
        Buy <span className="font-mono font-semibold text-mint-deep">YES @ {formatCents(edge.yesPrice)}</span> on{' '}
        {platformLabel(edge.yesPlatform)} · buy{' '}
        <span className="font-mono font-semibold text-mint-deep">NO @ {formatCents(edge.noPrice)}</span> on{' '}
        {platformLabel(edge.noPlatform)}
      </p>

      {/* Deploy calculator inputs */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="font-body text-[11px] text-muted uppercase tracking-wide">Capital ($)</label>
          <input
            type="number"
            min={0}
            value={capital}
            onChange={e => setCapital(Math.max(0, parseFloat(e.target.value) || 0))}
            className="w-full mt-1 px-3 py-1.5 rounded-button bg-surface border border-line text-ink font-mono text-sm focus:outline-none focus:border-mint/60"
          />
        </div>
        <div>
          <label className="font-body text-[11px] text-muted uppercase tracking-wide">Slippage buffer (%)</label>
          <input
            type="number"
            min={0}
            max={mo.roi}
            step={0.1}
            value={slippagePct}
            onChange={e => setSlippagePct(Math.max(0, parseFloat(e.target.value) || 0))}
            className="w-full mt-1 px-3 py-1.5 rounded-button bg-surface border border-line text-ink font-mono text-sm focus:outline-none focus:border-mint/60"
          />
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-3 mb-1">
        <div className="rounded-button bg-bg-soft px-3 py-2">
          <p className="font-body text-[10.5px] text-muted uppercase tracking-wide">Deployable</p>
          <p className="font-mono font-semibold text-base text-ink tabular-nums">${deployable.toFixed(2)}</p>
          {capacity == null ? (
            <p className="font-body text-[10.5px] text-muted mt-0.5">capacity unknown — uncapped</p>
          ) : (
            <p className="font-body text-[10.5px] text-muted mt-0.5">capped by ${capacity.toFixed(0)} capacity</p>
          )}
        </div>
        <div className="rounded-button bg-mint-tint px-3 py-2">
          <p className="font-body text-[10.5px] text-mint-deep/70 uppercase tracking-wide">Total return</p>
          <p className="font-mono font-semibold text-base text-mint-deep tabular-nums">
            ${returnUsd.toFixed(2)} <span className="text-sm">({effRoiPct.toFixed(2)}%)</span>
          </p>
          <p className="font-body text-[10.5px] text-mint-deep/70 mt-0.5">total ROI, not annualized</p>
        </div>
      </div>

      {/* Honest lock model — never a fabricated $/day */}
      <div className="flex items-center gap-1.5 font-body text-[12px] text-ink-2 mt-2 mb-3">
        <Lock size={12} className="text-muted flex-shrink-0" />
        one-time · unlock {formatResolutionDate(mo.resolutionDate)}
        {mo.daysToResolution != null && <span className="text-muted"> · {mo.daysToResolution}d away</span>}
      </div>

      {/* Depth ladders */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <DepthLadder
          label={`${platformLabel(edge.yesPlatform)} — order book (YES ask, ¢)`}
          leg={yesLeg}
          deployable={deployable}
        />
        <DepthLadder
          label={`${platformLabel(edge.noPlatform)} — order book (YES ask, ¢)`}
          leg={noLeg}
          deployable={deployable}
        />
      </div>

      {/* Copy actions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
        <div className="rounded-card border border-line px-4 py-4">
          <div className="flex items-center justify-between mb-2">
            <span className="font-body font-semibold text-sm text-ink">Pre-filled order · no custody</span>
            <CopyButton text={copyText} label="Copy signal" />
          </div>
          <div className="space-y-2">
            {yesUrl ? (
              <a
                href={yesUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between gap-2 font-body text-xs px-3 py-2 rounded-button border border-line text-ink-2 hover:border-mint hover:text-mint-deep transition-colors duration-150"
              >
                <span>Open on {platformLabel(edge.yesPlatform)} · buy YES @ {formatCents(edge.yesPrice)}</span>
                <ExternalLink size={13} />
              </a>
            ) : (
              <p className="font-body text-xs text-muted px-3 py-2">link unavailable for {platformLabel(edge.yesPlatform)}</p>
            )}
            {noUrl ? (
              <a
                href={noUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between gap-2 font-body text-xs px-3 py-2 rounded-button border border-line text-ink-2 hover:border-mint hover:text-mint-deep transition-colors duration-150"
              >
                <span>Open on {platformLabel(edge.noPlatform)} · buy NO @ {formatCents(edge.noPrice)}</span>
                <ExternalLink size={13} />
              </a>
            ) : (
              <p className="font-body text-xs text-muted px-3 py-2">link unavailable for {platformLabel(edge.noPlatform)}</p>
            )}
          </div>
          <p className="font-body text-[11px] text-muted mt-2 leading-relaxed">
            Edgeradar holds no keys or funds — you execute both legs yourself, on each platform.
          </p>
        </div>

        <AutoExecutePanel />
      </div>
    </div>
  );
}

export default function EventCard({ event, valid }: { event: EventBucket; valid: Opportunity[] }) {
  const router = useRouter();
  const edge = event.lockableEdge;
  const mo   = edge?.matchedOpportunity ?? null;
  const validMatch = edge && mo ? findValidMatch(edge, valid) : null;
  const badge = arbBadge(event);   // non-null ONLY on a real EXEC-only lockable edge (gated → null on free)

  const href = `/dashboard/prediction/event/${encodeURIComponent(event.eventKey)}`;
  const goToDetail = () => router.push(href);

  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={`View operational steps for ${event.title}`}
      onClick={goToDetail}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          goToDetail();
        }
      }}
      className="rounded-card shadow-card bg-surface px-5 py-5 cursor-pointer hover:shadow-[0_2px_8px_rgba(11,26,21,.09)] transition-shadow duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-mint/50"
    >
      {/* ARB badge — only on a real EXEC-only lockable edge above the fee threshold */}
      {badge && <ArbBadgeBar badge={badge} />}

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-body font-semibold text-sm text-ink leading-snug">{event.title}</span>
          <span className="flex-shrink-0 inline-flex items-center px-1.5 py-[2px] rounded-md bg-violet-tint text-violet font-body font-semibold text-[9px] uppercase tracking-wide">
            {event.category}
          </span>
        </div>
        <div className="flex items-center gap-1 font-body text-[11px] text-muted flex-shrink-0">
          <Lock size={11} />
          resolves {formatResolutionDate(event.resolutionDate)}
        </div>
      </div>

      {/* Platform table — VOL is a column from sm: up; on phone widths it drops
          out of the table entirely and shows inline under the platform name
          instead, so PLATFORM/YES/NO (the arb-critical columns) never have to
          compete with it for space. overflow-x-auto stays as a safety net for
          extreme cases (long category/platform names), not the primary fix. */}
      <PlatformComparatorTable event={event} />

      {/* Lockable edge + deploy calculator, or calm "no edge" note. Wrapped with
          stopPropagation so the capital/slippage inputs, copy buttons and deep
          links inside remain fully usable without triggering card navigation —
          only the header/table zone above navigates to the detail page. */}
      <div onClick={e => e.stopPropagation()}>
        {edge && mo ? (
          <DeployCalculator event={event} edge={edge} mo={mo} validMatch={validMatch} />
        ) : (
          <p className="font-body text-[12.5px] text-muted mt-3 pt-3 border-t border-line">
            {edge
              ? 'No lockable edge right now — the spread doesn’t clear the executable threshold.'
              : 'No lockable edge right now — fewer than two executable venues are quoting this event.'}
          </p>
        )}
      </div>
    </div>
  );
}
