'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import PlatformLogo from '@/components/PlatformLogo';
import { RedactedPanel } from '@/app/components/ui/Redacted';
import CollectionStoppedNote from '@/app/components/CollectionStoppedNote';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Leg {
  platform:    string;
  // null on free tier (server-side redaction) — see lib/paid-gating.ts
  probability: number | null;  // 0–100 (mid-price in cents)
  url:         string;
  urlVerified: boolean;    // true = canonical deep link; false = fallback/homepage
  fee:         number;     // display rate (0–1); fee calculation uses per-platform model below
  expiresAt:   number | null;
  yesBid?:     number | null;  // 0–1 decimal, order-book best bid for YES
  yesAsk?:     number | null;  // 0–1 decimal, order-book best ask for YES
}

interface Opportunity {
  id:               string;
  question:         string;
  lowMarket:        Leg;   // leg where YES is cheaper — we BUY YES here
  highMarket:       Leg;   // leg where YES is more expensive — we BUY NO here
  // spread/roi/confidence: null on free tier (server-side redaction) — gated
  // as a whole calculator section below rather than field-by-field (see
  // PredictionDetailPage's `isRedacted`), since every downstream number in
  // CashableDetail/SignalDetail derives from these same few inputs.
  spread:           number | null;
  roi:              number | null;        // net ROI % after fees (authoritative)
  earnPer100:       number | null;
  confidence:       number | null;
  category:         string;
  type:                 'cashable' | 'signal';
  annualizedROI?:       number | null;
  daysToResolution?:    number | null;
  resolutionDate?:      string | null;
  confirmReason?:       string | null;
  lockupFlag?:          string | null;
  nonCashableReason?:   'play_money' | 'stage_mismatch' | 'low_confidence' | 'small_capacity' | 'no_arb' | null;
  confidenceNote?:      string | null;
  capacityNote?:        string | null;
}

// Narrowed shape used inside CashableDetail/SignalDetail — both components are
// only ever rendered after PredictionDetailPage's `isRedacted` check confirms
// roi (and therefore the whole redacted-together field set: spread, confidence,
// lowMarket/highMarket.probability) is non-null, i.e. this is a paid response.
type PaidLeg = Leg & { probability: number };
type PaidOpportunity = Opportunity & {
  roi:        number;
  spread:     number;
  confidence: number;
  lowMarket:  PaidLeg;
  highMarket: PaidLeg;
};

interface ApiResponse {
  valid:     Opportunity[];
  rejected:  number;
  // Only the last-observation stamp is read here (to date the "collection stopped" note).
  stats:     { updatedAt: number | null } | null;
  // /api/prediction emits two independent staleness clocks; either being stale means the
  // producing agent has stopped and the numbers below are frozen (see lib/collection-status.js).
  freshness: { repriceStale?: boolean; discoveryStale?: boolean };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function platformLabel(p: string): string {
  const MAP: Record<string, string> = {
    kalshi: 'Kalshi', polymarket: 'Polymarket',
    predictit: 'PredictIt', manifold: 'Manifold', oddsapi: 'Odds API',
    futuur: 'Futuur',
  };
  return MAP[p?.toLowerCase()] ?? p;
}

// Returns { url, verified } for external market links.
// verified=true means a canonical deep link to this specific market.
// verified=false means we only have the platform homepage — label it "(search)" to avoid
// presenting a guessed deep link as confirmed.
function getMarketUrl(leg: Leg): { url: string; verified: boolean } {
  const fallbacks: Record<string, string> = {
    polymarket: 'https://polymarket.com/markets',
    kalshi:     'https://kalshi.com',
    predictit:  'https://www.predictit.org',
    manifold:   'https://manifold.markets',
    futuur:     'https://futuur.com',
  };
  const p = leg.platform?.toLowerCase() ?? '';

  // If the pipeline already verified the URL, trust it.
  if (leg.urlVerified && leg.url && leg.url !== fallbacks[p]) {
    return { url: leg.url, verified: true };
  }

  // Double-check legacy data (before urlVerified field existed) by pattern matching.
  if (leg.url) {
    switch (p) {
      case 'polymarket':
        if (/polymarket\.com\/event\/[^/]+/.test(leg.url)) return { url: leg.url, verified: true };
        break;
      case 'kalshi':
        // Canonical format: /markets/{series}/{series_slug}/{event_ticker} (3 segments)
        if (/kalshi\.com\/markets\/[^/]+\/[^/]+\/.+/.test(leg.url)) return { url: leg.url, verified: true };
        break;
      case 'predictit':
        if (/predictit\.org\/markets\/detail\/\d+/.test(leg.url)) return { url: leg.url, verified: true };
        break;
      case 'manifold':
        if (/manifold\.markets\/[^/]+\/[^/]+/.test(leg.url)) return { url: leg.url, verified: true };
        break;
      case 'futuur':
        if (/futuur\.com\/q\/.+/.test(leg.url)) return { url: leg.url, verified: true };
        break;
    }
  }

  return { url: fallbacks[p] ?? leg.url ?? '#', verified: false };
}

function fmtPct(n: number, dec = 2): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(dec)}%`;
}

function fmtUsd(n: number, dec = 2): string {
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  if (abs >= 100)    return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(dec)}`;
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return d; }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionTitle({ title }: { title: string }) {
  return (
    <h2 className="font-body text-[9px] uppercase tracking-widest text-muted mb-3 mt-6 border-b border-line/30 pb-1.5">
      {title}
    </h2>
  );
}

function StepLabel({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex items-start gap-3 mb-4">
      <span className="font-mono text-[9px] px-1.5 py-[2px] border border-line text-muted shrink-0 mt-0.5">
        {String(n).padStart(2, '0')}
      </span>
      <span className="font-body text-[11px] text-ink-2 font-medium">{text}</span>
    </div>
  );
}

// Returns fee per contract in dollars using each platform's published schedule.
// Kalshi: variable — 7% × YES_price × (1 − YES_price); peaks at 1.75¢ when p=0.5.
// Polymarket: 0% trading fee (as of 2024).
function contractFeePerPair(platform: string, yesPriceDec: number): number {
  switch (platform?.toLowerCase()) {
    case 'kalshi':
      return 0.07 * yesPriceDec * (1 - yesPriceDec);
    case 'polymarket':
      return 0;
    default:
      return 0;
  }
}

// ── CASHABLE detail ───────────────────────────────────────────────────────────

function CashableDetail({ opp, capital, setCapital }: {
  opp:        PaidOpportunity;
  capital:    number;
  setCapital: (n: number) => void;
}) {
  const low  = opp.lowMarket;
  const high = opp.highMarket;

  // Executable prices — use order-book ask/bid when available, else mid-price
  // Buy YES at ask on lowMarket
  const priceYES: number = low.yesAsk  ?? (low.probability  / 100);
  // Buy NO  at (1 − bid) on highMarket (NO ask = 1 − YES bid)
  const priceNO:  number = high.yesBid != null ? (1 - high.yesBid) : ((100 - high.probability) / 100);

  const costPerPair        = priceYES + priceNO;
  const grossProfitPerPair = 1 - costPerPair;

  // Per-contract fee using each platform's real fee schedule (applied to notional, not profit).
  const highYesDec        = high.yesAsk ?? (high.probability / 100);
  const feePerContLow     = contractFeePerPair(low.platform,  priceYES);
  const feePerContHigh    = contractFeePerPair(high.platform, highYesDec);
  const netProfitPerPair  = grossProfitPerPair - feePerContLow - feePerContHigh;
  const netROI            = costPerPair > 0 ? (netProfitPerPair / costPerPair) * 100 : 0;

  // Scale to N contracts given capital budget
  const N              = capital > 0 ? Math.floor(capital / costPerPair) : 0;
  const totalCost      = N * costPerPair;
  const grossProfit    = N * grossProfitPerPair;
  const totalFeeOnLow  = N * feePerContLow;
  const totalFeeOnHigh = N * feePerContHigh;
  const netProfit      = N * netProfitPerPair;

  // Whether prices shown are executable or mid
  const usingLiveYES = low.yesAsk  != null;
  const usingLiveNO  = high.yesBid != null;

  return (
    <>
      {/* Price snapshot */}
      <div className="mb-5 px-4 py-3 bg-surface border border-line rounded-card font-mono text-[11px]">
        <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-2">Current prices (snapshot)</div>
        <div className="flex flex-wrap gap-x-8 gap-y-1.5">
          <span>
            <span className="text-muted inline-flex items-center gap-1">YES on <PlatformLogo platform={low.platform} size={11} />{platformLabel(low.platform)}: </span>
            <span className="text-mint-deep font-medium tabular-nums">
              {(priceYES * 100).toFixed(1)}¢
            </span>
            {usingLiveYES && (
              <span className="text-muted/60 text-[9px] ml-1">
                (ask · mid {low.probability}¢)
              </span>
            )}
          </span>
          <span>
            <span className="text-muted inline-flex items-center gap-1">NO on <PlatformLogo platform={high.platform} size={11} />{platformLabel(high.platform)}: </span>
            <span className="text-violet font-medium tabular-nums">
              {(priceNO * 100).toFixed(1)}¢
            </span>
            {usingLiveNO && (
              <span className="text-muted/60 text-[9px] ml-1">
                (1 − bid · mid {(100 - high.probability)}¢)
              </span>
            )}
          </span>
          <span>
            <span className="text-muted">Cost per contract pair: </span>
            <span className="text-ink tabular-nums font-medium">{(costPerPair * 100).toFixed(1)}¢</span>
          </span>
          <span>
            <span className="text-muted">Net ROI: </span>
            <span className="text-mint-deep font-medium tabular-nums">{fmtPct(netROI, 2)}</span>
            <span className="text-muted/60 text-[9px] ml-1">(real fee model · matcher: {fmtPct(opp.roi, 2)})</span>
          </span>
        </div>
        {!usingLiveYES && !usingLiveNO && (
          <p className="font-body text-[9px] text-gold/60 mt-1.5">
            No order-book data — prices shown are mid-market. Actual executable prices may differ.
          </p>
        )}
      </div>

      {/* Capital input */}
      <div className="mb-5 px-4 py-3 bg-surface border border-line rounded-card">
        <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-2">Your capital</div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-muted">$</span>
          <input
            type="number" min={0} step={100} value={capital}
            onChange={e => setCapital(Math.max(0, parseFloat(e.target.value) || 0))}
            className="w-[5rem] px-1.5 py-0.5 font-mono text-[11px] bg-surface border border-line text-ink focus:border-mint/50 focus:outline-none tabular-nums rounded-sm"
          />
        </div>
      </div>

      {/* P&L estimate */}
      {capital > 0 && N > 0 && (
        <div className="mb-6 px-4 py-4 border border-mint-deep/25 bg-mint-tint/30 rounded-card">
          <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-2">
            Estimated outcome at ${capital.toLocaleString()}
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-1.5 font-mono text-[11px] mb-4">
            <span>
              <span className="text-muted">Contracts: </span>
              <span className="text-ink font-medium tabular-nums">{N} pairs</span>
              <span className="text-muted/60 text-[9px] ml-1">({N} YES + {N} NO)</span>
            </span>
            <span>
              <span className="text-muted">Total deployed: </span>
              <span className="text-ink tabular-nums font-medium">{fmtUsd(totalCost)}</span>
              <span className="text-muted/60 text-[9px] ml-1">({fmtUsd(capital - totalCost)} undeployed)</span>
            </span>
            <span>
              <span className="text-mint-deep font-bold text-[14px] tabular-nums">{fmtUsd(netProfit)} locked profit</span>
              <span className="text-muted/60 text-[9px] ml-1">(net, at resolution)</span>
            </span>
            {opp.annualizedROI != null && opp.daysToResolution != null && (
              <span>
                <span className="text-muted">Annualized: </span>
                <span className="text-mint-deep tabular-nums">{fmtPct(opp.annualizedROI, 1)}/yr</span>
                <span className="text-muted/60 text-[9px] ml-1">({opp.daysToResolution}d lock)</span>
              </span>
            )}
          </div>

          {/* Fee breakdown */}
          <div className="border-t border-line/30 pt-3">
            <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-2">Fee breakdown</div>
            <div className="space-y-[3px] font-mono text-[10px]">
              <div className="flex gap-2">
                <span className="text-muted w-[120px] shrink-0">Gross profit</span>
                <span className="text-muted/60 text-[9px]">{N} × {(grossProfitPerPair * 100).toFixed(2)}¢</span>
                <span className="text-ink tabular-nums ml-auto">{fmtUsd(grossProfit)}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-muted w-[120px] shrink-0 inline-flex items-center gap-1"><PlatformLogo platform={low.platform} size={10} />{platformLabel(low.platform)} fee</span>
                <span className="text-muted/60 text-[9px]">
                  {low.platform?.toLowerCase() === 'polymarket' ? '0% · no trading fee'
                   : low.platform?.toLowerCase() === 'kalshi'
                     ? `7%×${(priceYES*100).toFixed(1)}¢×${((1-priceYES)*100).toFixed(1)}¢`
                     : `${(low.fee*100).toFixed(0)}% on winnings`}
                </span>
                <span className={`tabular-nums ml-auto ${totalFeeOnLow === 0 ? 'text-muted/50' : 'text-coral-ink/80'}`}>
                  {fmtUsd(-totalFeeOnLow)}
                </span>
              </div>
              <div className="flex gap-2">
                <span className="text-muted w-[120px] shrink-0 inline-flex items-center gap-1"><PlatformLogo platform={high.platform} size={10} />{platformLabel(high.platform)} fee</span>
                <span className="text-muted/60 text-[9px]">
                  {high.platform?.toLowerCase() === 'polymarket' ? '0% · no trading fee'
                   : high.platform?.toLowerCase() === 'kalshi'
                     ? `7%×${(highYesDec*100).toFixed(1)}¢×${((1-highYesDec)*100).toFixed(1)}¢`
                     : `${(high.fee*100).toFixed(0)}% on winnings`}
                </span>
                <span className={`tabular-nums ml-auto ${totalFeeOnHigh === 0 ? 'text-muted/50' : 'text-coral-ink/80'}`}>
                  {fmtUsd(-totalFeeOnHigh)}
                </span>
              </div>
              <div className="flex gap-2 border-t border-line/30 pt-1.5 mt-1">
                <span className="text-ink-2 font-medium">Net profit</span>
                <span className="text-muted/50 text-[9px] ml-1">({netROI.toFixed(2)}% ROI on deployed)</span>
                <span className="text-mint-deep font-medium tabular-nums ml-auto">{fmtUsd(netProfit)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
      {capital > 0 && N === 0 && (
        <div className="mb-6 px-4 py-3 border border-line bg-surface rounded-card font-body text-[10px] text-gold/70">
          Capital too low to buy even one contract pair at {(costPerPair * 100).toFixed(1)}¢/pair cost.
        </div>
      )}

      {/* Step-by-step guide */}
      <SectionTitle title="Step-by-step execution guide" />
      <div className="space-y-0 mb-6">

        <div className="border-b border-line/20 pb-4 mb-4">
          <StepLabel n={1} text={`Buy YES on ${platformLabel(low.platform)}`} />
          <div className="ml-[42px] font-body text-[10px] text-muted leading-relaxed space-y-1">
            <p>
              Market: <span className="text-ink-2">{opp.question}</span>
            </p>
            <p>
              Outcome to buy: <span className="text-mint-deep font-medium">YES</span>
              {' '} · Price: <span className="text-mint-deep tabular-nums font-medium font-mono">{(priceYES * 100).toFixed(1)}¢ per share</span>
              {usingLiveYES && <span className="text-muted/60"> (order-book ask)</span>}
            </p>
            {capital > 0 && N > 0 && (
              <p>
                Quantity: <span className="text-ink tabular-nums font-mono">{N} shares</span>
                {' '}· Cost: <span className="tabular-nums text-ink font-mono">{fmtUsd(N * priceYES)}</span>
              </p>
            )}
            <p className="text-[9px] text-muted/60 border-l border-line/30 pl-2 mt-1">
              {(() => { const { url: lu, verified: lv } = getMarketUrl(low); return (
                <a href={lu} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-mint hover:text-mint-deep">
                  <PlatformLogo platform={low.platform} size={10} />
                  Open {platformLabel(low.platform)} market{!lv && ' (search)'} <ExternalLink size={9} />
                </a>
              ); })()}
              {' · '}{low.platform?.toLowerCase() === 'kalshi'
                ? `Kalshi fee: 7%×p×(1−p) ≈ ${(feePerContLow*100).toFixed(3)}¢/contract.`
                : low.platform?.toLowerCase() === 'polymarket'
                  ? 'Polymarket: 0% trading fee.'
                  : `Platform fee: ${(low.fee*100).toFixed(0)}%.`
              }
            </p>
          </div>
        </div>

        <div className="border-b border-line/20 pb-4 mb-4">
          <StepLabel n={2} text={`Buy NO on ${platformLabel(high.platform)}`} />
          <div className="ml-[42px] font-body text-[10px] text-muted leading-relaxed space-y-1">
            <p>
              Market: <span className="text-ink-2">{opp.question}</span>
            </p>
            <p>
              Outcome to buy: <span className="text-violet font-medium">NO</span>
              {' '}· Price: <span className="text-violet tabular-nums font-medium font-mono">{(priceNO * 100).toFixed(1)}¢ per share</span>
              {usingLiveNO && <span className="text-muted/60"> (1 − YES bid)</span>}
            </p>
            {capital > 0 && N > 0 && (
              <p>
                Quantity: <span className="text-ink tabular-nums font-mono">{N} shares</span>
                {' '}· Cost: <span className="tabular-nums text-ink font-mono">{fmtUsd(N * priceNO)}</span>
              </p>
            )}
            <p className="text-[9px] text-muted/60 border-l border-line/30 pl-2 mt-1">
              {(() => { const { url: hu, verified: hv } = getMarketUrl(high); return (
                <a href={hu} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-mint hover:text-mint-deep">
                  <PlatformLogo platform={high.platform} size={10} />
                  Open {platformLabel(high.platform)} market{!hv && ' (search)'} <ExternalLink size={9} />
                </a>
              ); })()}
              {' · '}{high.platform?.toLowerCase() === 'kalshi'
                ? `Kalshi fee: 7%×p×(1−p) ≈ ${(feePerContHigh*100).toFixed(3)}¢/contract.`
                : high.platform?.toLowerCase() === 'polymarket'
                  ? 'Polymarket: 0% trading fee.'
                  : `Platform fee: ${(high.fee*100).toFixed(0)}%.`
              }
            </p>
          </div>
        </div>

        <div className="border-b border-line/20 pb-4 mb-4">
          <StepLabel n={3} text="Why equal contract count (not equal dollar size)" />
          <div className="ml-[42px] font-body text-[10px] text-muted leading-relaxed space-y-1.5">
            <p>
              You buy the same number of shares ({N > 0 ? N : 'N'}) on each side — not equal dollars.
              Each share resolves to exactly $1 (win) or $0 (loss).
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 my-2 text-[9px]">
              <div className="text-ink-2 font-medium">If YES resolves:</div>
              <div className="text-ink-2 font-medium">If NO resolves:</div>
              <div className="text-mint-deep">YES shares → $1/share × {N > 0 ? N : 'N'} = ${N > 0 ? N : 'N'}</div>
              <div className="text-muted">YES shares → $0/share × {N > 0 ? N : 'N'} = $0</div>
              <div className="text-muted">NO shares → $0/share × {N > 0 ? N : 'N'} = $0</div>
              <div className="text-mint-deep">NO shares → $1/share × {N > 0 ? N : 'N'} = ${N > 0 ? N : 'N'}</div>
              <div className="text-ink-2 font-medium pt-0.5">Net received: ${N > 0 ? N : 'N'}</div>
              <div className="text-ink-2 font-medium pt-0.5">Net received: ${N > 0 ? N : 'N'}</div>
            </div>
            <p>
              In both cases you receive ${N > 0 ? N.toLocaleString() : 'N'}.
              You paid {fmtUsd(totalCost > 0 ? totalCost : costPerPair)}{N > 0 ? ` total` : ` per pair`}.
              Gross profit = ${N > 0 ? N : 'N'} − {fmtUsd(totalCost > 0 ? totalCost : costPerPair)} = {fmtUsd(N > 0 ? (N - totalCost) : grossProfitPerPair)}.
            </p>
            <p className="text-[9px] text-gold/70">
              This only holds if both platforms resolve identically (same real-world outcome, same criteria, same date).
              See the resolution-risk warning below.
            </p>
          </div>
        </div>

        <div className="border-b border-line/20 pb-4 mb-4">
          <StepLabel n={4} text="Open both legs as simultaneously as possible" />
          <div className="ml-[42px] font-body text-[10px] text-muted leading-relaxed">
            <p>
              Between your first fill and your second, the price can move on either platform.
              An unhedged leg is a directional bet on the event. Minimize the time between clicks.
            </p>
          </div>
        </div>

        <div className="border-b border-line/20 pb-4 mb-4">
          <StepLabel n={5} text="Hold to resolution — no active management needed" />
          <div className="ml-[42px] font-body text-[10px] text-muted leading-relaxed space-y-1">
            <p>
              Shares are non-fungible claims — they cannot be transferred between platforms.
              Once bought, hold both legs until the market resolves. You can sell early on each platform&apos;s
              own secondary market if prices move, but the locked profit only materialises at resolution.
            </p>
            {opp.resolutionDate && (
              <p>
                <span className="text-ink-2">Resolution date: </span>
                <span className="text-ink font-medium">{fmtDate(opp.resolutionDate)}</span>
                {opp.daysToResolution != null && (
                  <span className="text-muted/60"> · {opp.daysToResolution} days from now</span>
                )}
              </p>
            )}
            {opp.lockupFlag && (
              <p className="text-gold/70 text-[9px]">⚠ {opp.lockupFlag}</p>
            )}
          </div>
        </div>

        <div className="border-b border-line/20 pb-4 mb-4">
          <StepLabel n={6} text="At resolution — collect payout" />
          <div className="ml-[42px] font-body text-[10px] text-muted leading-relaxed space-y-1">
            <p>
              The winning platform credits $1/share × {N > 0 ? N : 'N'} to your account (after platform fee).
              The losing platform&apos;s shares expire worthless — those {N > 0 ? N : 'N'} shares cost ${N > 0 ? N.toFixed(0) : 'N'} × the price you paid
              for the losing leg, which you already accounted for in the total cost.
            </p>
            <p>
              Net to you: {N > 0 ? fmtUsd(netProfit) : 'N × net-profit-per-share'} (fees already deducted above).
            </p>
          </div>
        </div>

      </div>

      {/* Exit triggers */}
      <SectionTitle title="Exit triggers — computed from current data" />
      <div className="mb-6 px-4 py-4 bg-surface border border-line rounded-card">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-4 mb-4">
          <div>
            <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-1">Net ROI at current price</div>
            <div className="font-mono text-[18px] font-bold text-mint-deep tabular-nums">{fmtPct(netROI, 2)}</div>
            <div className="font-body text-[9px] text-muted/70 mt-0.5">real fee model · matcher stored {fmtPct(opp.roi, 2)}</div>
          </div>
          {opp.annualizedROI != null && (
            <div>
              <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-1">Annualized ROI</div>
              <div className="font-mono text-[18px] font-bold text-mint-deep/80 tabular-nums">{fmtPct(opp.annualizedROI, 1)}/yr</div>
              <div className="font-body text-[9px] text-muted/70 mt-0.5">capital locked {opp.daysToResolution ?? '?'}d to resolution</div>
            </div>
          )}
          <div>
            <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-1">Spread</div>
            <div className="font-mono text-[18px] font-bold text-ink tabular-nums">{opp.spread.toFixed(1)}pp</div>
            <div className="font-body text-[9px] text-muted/70 mt-0.5">YES price difference between platforms</div>
          </div>
        </div>
        <div className="font-body text-[9px] text-muted leading-relaxed space-y-1">
          <p>
            <span className="text-ink-2">Exit early when: </span>
            spread narrows to near-zero (most edge is captured) OR one platform changes its resolution criteria
            OR you need liquidity before resolution.
          </p>
          <p>
            <span className="text-ink-2">Early exit cost: </span>
            selling early on each platform incurs spread + fees a second time, reducing net profit.
            Compare early-exit prices carefully before acting.
          </p>
        </div>
      </div>

      {/* RESOLUTION RISK — PROMINENT */}
      <div className="mb-6 px-4 py-4 border-2 border-coral-ink/40 bg-coral-tint/30 rounded-card">
        <div className="font-body text-[11px] font-bold text-coral-ink uppercase tracking-widest mb-3">
          ⚠ Resolution-risk warning — read before trading
        </div>
        <div className="font-body text-[10px] text-muted leading-relaxed space-y-2">
          <p>
            <span className="text-ink-2 font-medium">This is only a locked arb if both platforms resolve on the exact same real-world criteria, source, and date.</span>
            {' '}If they diverge — one says YES, one says NO — you lose on both legs simultaneously.
          </p>
          {opp.confirmReason && (
            <p>
              <span className="text-ink-2">AI confirmation: </span>
              <span className="text-muted/80 italic">&quot;{opp.confirmReason}&quot;</span>
              <span className="text-muted/50"> — AI-generated, not guaranteed to be correct.</span>
            </p>
          )}
          <ul className="list-none space-y-1 ml-3 text-[9px]">
            <li>· <span className="text-ink-2">Criteria risk:</span> each platform writes its own resolution rules. Read both market descriptions carefully. Words like &quot;wins&quot; or &quot;elected&quot; can differ in edge cases.</li>
            <li>· <span className="text-ink-2">Date risk:</span> if one platform resolves early (e.g. on election night) and the other waits for official certification, you carry a one-sided open position in between.</li>
            <li>· <span className="text-ink-2">Void / cancel risk:</span> if either market is voided or cancelled, that leg reverts to cost price while the other leg may already have resolved. This leaves you with a one-sided directional position you did not intend to hold.</li>
            <li>· <span className="text-ink-2">Fill risk:</span> prices shown are snapshots. The order book may have moved or dried up by the time you execute. Partial fills create uncovered directional exposure.</li>
          </ul>
          <p className="text-muted/60 text-[9px] mt-1">
            Manually verify the resolution rules on both platforms before committing capital.
            This page does not and cannot guarantee that the two markets resolve identically.
          </p>
        </div>
      </div>

      {/* Links */}
      <SectionTitle title="Market links" />
      <div className="mb-6 flex flex-wrap gap-3">
        {(() => { const { url: lu, verified: lv } = getMarketUrl(low); return (
          <a href={lu} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-body text-[10px] px-3 py-1.5 border border-mint-deep/30 text-mint-deep/70 hover:border-mint-deep hover:text-mint-deep rounded-button transition-colors duration-100">
            <ExternalLink size={10} />
            <PlatformLogo platform={low.platform} size={10} />
            {platformLabel(low.platform)} — YES market{!lv && ' (search)'}
          </a>
        ); })()}
        {(() => { const { url: hu, verified: hv } = getMarketUrl(high); return (
          <a href={hu} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-body text-[10px] px-3 py-1.5 border border-violet/30 text-violet/70 hover:border-violet hover:text-violet rounded-button transition-colors duration-100">
            <ExternalLink size={10} />
            <PlatformLogo platform={high.platform} size={10} />
            {platformLabel(high.platform)} — NO market{!hv && ' (search)'}
          </a>
        ); })()}
      </div>
    </>
  );
}

// ── HOW TO OPERATE — signal pairs ────────────────────────────────────────────
// Replaces the old "SIGNAL ONLY / WHY THIS CANNOT BE EXECUTED" pattern.
// Three cases:
//   1. Play-money leg (Manifold) → directional-only with honest play-money explanation.
//   2. Real-money × real-money, live net ≤ 0 → directional-only + true reason + arithmetic.
//   3. Real-money × real-money, live net > 0 → full executable HOW TO OPERATE guide.

function SignalDetail({ opp, capital, setCapital }: {
  opp:        PaidOpportunity;
  capital:    number;
  setCapital: (n: number) => void;
}) {
  const low  = opp.lowMarket;
  const high = opp.highMarket;

  const PLAY_MONEY_PLATFORMS = new Set(['manifold']);
  const lowIsPlay  = PLAY_MONEY_PLATFORMS.has(low.platform?.toLowerCase()  ?? '');
  const highIsPlay = PLAY_MONEY_PLATFORMS.has(high.platform?.toLowerCase() ?? '');
  const hasPlayMoney = lowIsPlay || highIsPlay;

  // Live arithmetic for real-money pairs (same model as CashableDetail)
  const priceYES     = low.yesAsk   ?? (low.probability  / 100);
  const priceNO      = high.yesBid  != null ? (1 - high.yesBid) : ((100 - high.probability) / 100);
  const costPerPair  = priceYES + priceNO;
  const grossPerPair = 1 - costPerPair;
  const highYesDec   = high.yesAsk  ?? (high.probability / 100);
  const feePerContLow  = contractFeePerPair(low.platform,  priceYES);
  const feePerContHigh = contractFeePerPair(high.platform, highYesDec);
  const netPerPair   = grossPerPair - feePerContLow - feePerContHigh;
  const liveNetROI   = !hasPlayMoney && costPerPair > 0 ? (netPerPair / costPerPair) * 100 : 0;
  const isExecutable = !hasPlayMoney && liveNetROI > 0;

  const N            = isExecutable && capital > 0 ? Math.floor(capital / costPerPair) : 0;
  const totalCost    = N * costPerPair;
  const totalFeeLow  = N * feePerContLow;
  const totalFeeHigh = N * feePerContHigh;
  const netTotal     = N * netPerPair;

  const usingLiveYES = low.yesAsk  != null;
  const usingLiveNO  = high.yesBid != null;

  // Scanner reason why this was not classified as cashable
  const scannerNote = (() => {
    switch (opp.nonCashableReason) {
      case 'low_confidence':
        return `AI match confidence below threshold${opp.confidenceNote ? ` (${opp.confidenceNote})` : ''}. Verify both markets resolve on identical criteria before trading.`;
      case 'small_capacity':
        return `Executable size is small${opp.capacityNote ? ` (${opp.capacityNote})` : ''}. Execution cost may exceed potential profit at this size.`;
      case 'stage_mismatch':
        return 'Possible resolution-criteria mismatch (Kalshi single-stage vs Polymarket cumulative). Verify both descriptions resolve identically.';
      case 'no_arb':
        return 'Spread did not survive fees at discovery-time prices.';
      default:
        return null;
    }
  })();

  // ── CASE 1: play-money leg ──────────────────────────────────────────────────
  if (hasPlayMoney) {
    const playPlatform = lowIsPlay ? low.platform : high.platform;
    const playName = platformLabel(playPlatform);
    return (
      <>
        <SectionTitle title="How to operate" />
        <div className="mb-5 px-4 py-4 bg-surface border border-gold/30 rounded-card">
          <div className="font-body text-[11px] font-semibold text-gold uppercase tracking-widest mb-2">
            Directional only — not a cashable arbitrage
          </div>
          <div className="font-body text-[10px] text-muted leading-relaxed space-y-2">
            <p>
              <span className="text-ink-2 inline-flex items-center gap-1"><PlatformLogo platform={playPlatform} size={11} />{playName}</span> uses play money (MANA) — not real currency and not convertible to cash.
              The price divergence cannot be captured as guaranteed profit between these platforms.
            </p>
            <p>
              <span className="text-ink-2">What it means: </span>
              <PlatformLogo platform={low.platform} size={11} className="mr-0.5" />
              {platformLabel(low.platform)} prices this at {low.probability}¢ while{' '}
              <PlatformLogo platform={high.platform} size={11} className="mr-0.5" />
              {platformLabel(high.platform)} prices it at {high.probability}¢ — a {opp.spread.toFixed(1)}pp divergence.
              Use this as a directional signal only.
            </p>
            <p>
              If you believe the real-money platform is mispriced, trade that side accepting full directional risk.
              No cross-platform settlement exists — prediction-market shares are platform-specific tokens.
            </p>
          </div>
        </div>

        <SectionTitle title="Price comparison (informational)" />
        <div className="mb-6 px-4 py-4 bg-surface border border-line rounded-card font-mono text-[10px]">
          <div className="grid grid-cols-2 gap-4">
            {([low, high] as const).map((leg, i) => {
              const isPlay = i === 0 ? lowIsPlay : highIsPlay;
              return (
                <div key={i}>
                  <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-1 inline-flex items-center gap-1"><PlatformLogo platform={leg.platform} size={10} />{platformLabel(leg.platform)}</div>
                  <div className="text-[18px] font-bold text-ink tabular-nums">{leg.probability}¢ YES</div>
                  <div className="font-body text-[9px] text-muted/70 mt-0.5">
                    {isPlay ? 'Play-money (MANA) — not convertible to cash' : 'Real-money market'}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 pt-3 border-t border-line/30">
            <span className="text-muted">Spread: </span>
            <span className="text-gold font-medium">{opp.spread.toFixed(1)}pp</span>
            <span className="text-muted ml-2">· Conf {Math.round(opp.confidence * 100)}%</span>
          </div>
          {opp.confirmReason && (
            <p className="font-body text-[9px] text-muted/60 mt-2 italic">&quot;{opp.confirmReason}&quot;</p>
          )}
        </div>

        <SectionTitle title="Market links (reference)" />
        <div className="mb-6 flex flex-wrap gap-3">
          {([low, high] as const).map((leg, i) => {
            const { url, verified } = getMarketUrl(leg);
            return (
              <a key={i} href={url} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 font-body text-[10px] px-3 py-1.5 border border-line text-muted hover:border-ink-2 hover:text-ink rounded-button transition-colors duration-100">
                <ExternalLink size={10} />
                <PlatformLogo platform={leg.platform} size={10} />
                {platformLabel(leg.platform)} market{!verified && ' (search)'}
              </a>
            );
          })}
        </div>
      </>
    );
  }

  // ── CASE 2: real-money × real-money, net ≤ 0 at live prices ────────────────
  if (!isExecutable) {
    return (
      <>
        <SectionTitle title="How to operate" />
        <div className="mb-5 px-4 py-4 bg-surface border border-line rounded-card">
          <div className="font-body text-[11px] font-semibold text-ink-2 uppercase tracking-widest mb-2">
            Directional only — spread does not lock positive at live bid/ask prices
          </div>
          <div className="font-body text-[10px] text-muted leading-relaxed space-y-2">
            <p>
              Both <PlatformLogo platform={low.platform} size={11} className="mr-0.5" />{platformLabel(low.platform)} and{' '}
              <PlatformLogo platform={high.platform} size={11} className="mr-0.5" />{platformLabel(high.platform)} are real-money platforms.
              Arithmetic at current executable (bid/ask) prices:
            </p>
            <div className="my-2 px-3 py-2 bg-bg-soft border border-line rounded-card font-mono text-[10px] space-y-0.5">
              <div>
                <span className="text-muted inline-flex items-center gap-1">Buy YES on <PlatformLogo platform={low.platform} size={11} />{platformLabel(low.platform)}: </span>
                <span className="text-mint-deep tabular-nums font-medium">{(priceYES * 100).toFixed(1)}¢</span>
                {usingLiveYES && <span className="text-muted/50 text-[9px]"> (ask · mid {low.probability}¢)</span>}
              </div>
              <div>
                <span className="text-muted inline-flex items-center gap-1">Buy NO on <PlatformLogo platform={high.platform} size={11} />{platformLabel(high.platform)}: </span>
                <span className="text-violet tabular-nums font-medium">{(priceNO * 100).toFixed(1)}¢</span>
                {usingLiveNO && <span className="text-muted/50 text-[9px]"> (1 − bid · mid {100 - high.probability}¢)</span>}
              </div>
              <div className="border-t border-line/30 pt-1 mt-0.5">
                <span className="text-muted">Total cost: </span>
                <span className="tabular-nums font-medium">{(costPerPair * 100).toFixed(1)}¢</span>
                <span className="text-muted ml-3">Gross: </span>
                <span className={`tabular-nums font-medium ${grossPerPair > 0 ? 'text-mint-deep' : 'text-coral-ink/80'}`}>
                  {grossPerPair >= 0 ? '+' : ''}{(grossPerPair * 100).toFixed(2)}¢
                </span>
              </div>
              <div>
                <span className="text-muted">After fees: </span>
                <span className={`tabular-nums font-medium ${netPerPair > 0 ? 'text-mint-deep' : 'text-coral-ink/80'}`}>
                  {netPerPair >= 0 ? '+' : ''}{(netPerPair * 100).toFixed(3)}¢ per contract pair
                </span>
                <span className="text-muted/60 text-[9px] ml-2">({liveNetROI.toFixed(2)}% net ROI)</span>
              </div>
            </div>
            {scannerNote && (
              <p className="text-[9px] text-muted/60 border-l-2 border-line pl-2">
                <span className="text-ink-2 font-medium">Scanner: </span>{scannerNote}
              </p>
            )}
            <p>
              <span className="text-ink-2">How to act: </span>
              Track the spread — if YES prices diverge further the arithmetic may become positive.
              Trade the mispriced side with full directional risk if you have a view.
            </p>
          </div>
        </div>

        <SectionTitle title="Price comparison" />
        <div className="mb-6 px-4 py-4 bg-surface border border-line rounded-card font-mono text-[10px]">
          <div className="grid grid-cols-2 gap-4">
            {([low, high] as const).map((leg, i) => (
              <div key={i}>
                <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-1 inline-flex items-center gap-1"><PlatformLogo platform={leg.platform} size={10} />{platformLabel(leg.platform)}</div>
                <div className="text-[18px] font-bold text-ink tabular-nums">{leg.probability}¢ YES</div>
                <div className="font-body text-[9px] text-muted/70 mt-0.5">Real-money market</div>
              </div>
            ))}
          </div>
          <div className="mt-3 pt-3 border-t border-line/30">
            <span className="text-muted">Spread: </span>
            <span className="font-medium tabular-nums">{opp.spread.toFixed(1)}pp</span>
            <span className="text-muted ml-2">· Conf {Math.round(opp.confidence * 100)}%</span>
          </div>
          {opp.confirmReason && (
            <p className="font-body text-[9px] text-muted/60 mt-2 italic">&quot;{opp.confirmReason}&quot;</p>
          )}
        </div>

        <SectionTitle title="Market links" />
        <div className="mb-6 flex flex-wrap gap-3">
          {([low, high] as const).map((leg, i) => {
            const { url, verified } = getMarketUrl(leg);
            return (
              <a key={i} href={url} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 font-body text-[10px] px-3 py-1.5 border border-line text-muted hover:border-ink-2 hover:text-ink rounded-button transition-colors duration-100">
                <ExternalLink size={10} />
                <PlatformLogo platform={leg.platform} size={10} />
                {platformLabel(leg.platform)} market{!verified && ' (search)'}
              </a>
            );
          })}
        </div>
      </>
    );
  }

  // ── CASE 3: real-money × real-money, live net > 0 — full execution guide ────
  return (
    <>
      <SectionTitle title="How to operate" />

      {/* Explain why the scanner flagged it as informational despite positive arithmetic */}
      {scannerNote && (
        <div className="mb-4 px-4 py-3 border border-gold/30 bg-gold/5 rounded-card font-body text-[10px] text-gold/80">
          <span className="font-semibold">Scanner note: </span>{scannerNote}{' '}
          The live arithmetic below is positive — verify resolution criteria on both platforms before trading.
        </div>
      )}

      {/* Price snapshot */}
      <div className="mb-5 px-4 py-3 bg-surface border border-line rounded-card font-mono text-[11px]">
        <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-2">Current prices (snapshot)</div>
        <div className="flex flex-wrap gap-x-8 gap-y-1.5">
          <span>
            <span className="text-muted inline-flex items-center gap-1">YES on <PlatformLogo platform={low.platform} size={11} />{platformLabel(low.platform)}: </span>
            <span className="text-mint-deep font-medium tabular-nums">{(priceYES * 100).toFixed(1)}¢</span>
            {usingLiveYES && <span className="text-muted/60 text-[9px] ml-1">(ask · mid {low.probability}¢)</span>}
          </span>
          <span>
            <span className="text-muted inline-flex items-center gap-1">NO on <PlatformLogo platform={high.platform} size={11} />{platformLabel(high.platform)}: </span>
            <span className="text-violet font-medium tabular-nums">{(priceNO * 100).toFixed(1)}¢</span>
            {usingLiveNO && <span className="text-muted/60 text-[9px] ml-1">(1 − bid · mid {100 - high.probability}¢)</span>}
          </span>
          <span>
            <span className="text-muted">Cost per pair: </span>
            <span className="text-ink tabular-nums font-medium">{(costPerPair * 100).toFixed(1)}¢</span>
          </span>
          <span>
            <span className="text-muted">Net ROI: </span>
            <span className="text-mint-deep font-medium tabular-nums">{fmtPct(liveNetROI, 2)}</span>
            <span className="text-muted/60 text-[9px] ml-1">(live fee model)</span>
          </span>
        </div>
        {!usingLiveYES && !usingLiveNO && (
          <p className="font-body text-[9px] text-gold/60 mt-1.5">
            No order-book data — prices shown are mid-market. Actual executable prices may differ.
          </p>
        )}
      </div>

      {/* Capital input */}
      <div className="mb-5 px-4 py-3 bg-surface border border-line rounded-card">
        <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-2">Your capital</div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-muted">$</span>
          <input
            type="number" min={0} step={100} value={capital}
            onChange={e => setCapital(Math.max(0, parseFloat(e.target.value) || 0))}
            className="w-[5rem] px-1.5 py-0.5 font-mono text-[11px] bg-surface border border-line text-ink focus:border-mint/50 focus:outline-none tabular-nums rounded-sm"
          />
        </div>
      </div>

      {/* P&L estimate */}
      {capital > 0 && N > 0 && (
        <div className="mb-6 px-4 py-4 border border-mint-deep/25 bg-mint-tint/30 rounded-card">
          <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-2">
            Estimated outcome at ${capital.toLocaleString()}
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1.5 font-mono text-[11px] mb-4">
            <span>
              <span className="text-muted">Contracts: </span>
              <span className="text-ink font-medium tabular-nums">{N} pairs</span>
              <span className="text-muted/60 text-[9px] ml-1">({N} YES + {N} NO)</span>
            </span>
            <span>
              <span className="text-muted">Deployed: </span>
              <span className="text-ink tabular-nums font-medium">{fmtUsd(totalCost)}</span>
              <span className="text-muted/60 text-[9px] ml-1">({fmtUsd(capital - totalCost)} undeployed)</span>
            </span>
            <span>
              <span className="text-mint-deep font-bold text-[14px] tabular-nums">{fmtUsd(netTotal)} locked profit</span>
              <span className="text-muted/60 text-[9px] ml-1">(net, at resolution)</span>
            </span>
          </div>
          <div className="border-t border-line/30 pt-3">
            <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-2">Fee breakdown</div>
            <div className="space-y-[3px] font-mono text-[10px]">
              <div className="flex gap-2">
                <span className="text-muted w-[120px] shrink-0">Gross profit</span>
                <span className="text-muted/60 text-[9px]">{N} × {(grossPerPair * 100).toFixed(2)}¢</span>
                <span className="text-ink tabular-nums ml-auto">{fmtUsd(N * grossPerPair)}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-muted w-[120px] shrink-0 inline-flex items-center gap-1"><PlatformLogo platform={low.platform} size={10} />{platformLabel(low.platform)} fee</span>
                <span className="text-muted/60 text-[9px]">
                  {low.platform?.toLowerCase() === 'kalshi'
                    ? `7%×${(priceYES*100).toFixed(1)}¢×${((1-priceYES)*100).toFixed(1)}¢`
                    : low.platform?.toLowerCase() === 'polymarket' ? '0% · no trading fee'
                    : `${(low.fee*100).toFixed(0)}% on winnings`}
                </span>
                <span className={`tabular-nums ml-auto ${totalFeeLow === 0 ? 'text-muted/50' : 'text-coral-ink/80'}`}>
                  {fmtUsd(-totalFeeLow)}
                </span>
              </div>
              <div className="flex gap-2">
                <span className="text-muted w-[120px] shrink-0 inline-flex items-center gap-1"><PlatformLogo platform={high.platform} size={10} />{platformLabel(high.platform)} fee</span>
                <span className="text-muted/60 text-[9px]">
                  {high.platform?.toLowerCase() === 'kalshi'
                    ? `7%×${(highYesDec*100).toFixed(1)}¢×${((1-highYesDec)*100).toFixed(1)}¢`
                    : high.platform?.toLowerCase() === 'polymarket' ? '0% · no trading fee'
                    : `${(high.fee*100).toFixed(0)}% on winnings`}
                </span>
                <span className={`tabular-nums ml-auto ${totalFeeHigh === 0 ? 'text-muted/50' : 'text-coral-ink/80'}`}>
                  {fmtUsd(-totalFeeHigh)}
                </span>
              </div>
              <div className="flex gap-2 border-t border-line/30 pt-1.5 mt-1">
                <span className="text-ink-2 font-medium">Net profit</span>
                <span className="text-muted/50 text-[9px] ml-1">({liveNetROI.toFixed(2)}% ROI)</span>
                <span className="text-mint-deep font-medium tabular-nums ml-auto">{fmtUsd(netTotal)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
      {capital > 0 && N === 0 && (
        <div className="mb-6 px-4 py-3 border border-line bg-surface rounded-card font-body text-[10px] text-gold/70">
          Capital too low for one contract pair at {(costPerPair * 100).toFixed(1)}¢/pair cost.
        </div>
      )}

      {/* Step-by-step */}
      <SectionTitle title="Step-by-step execution" />
      <div className="space-y-0 mb-6">
        <div className="border-b border-line/20 pb-4 mb-4">
          <StepLabel n={1} text={`Buy YES on ${platformLabel(low.platform)}`} />
          <div className="ml-[42px] font-body text-[10px] text-muted leading-relaxed space-y-1">
            <p>Market: <span className="text-ink-2">{opp.question}</span></p>
            <p>
              Outcome: <span className="text-mint-deep font-medium">YES</span>
              {' '}· Price: <span className="text-mint-deep tabular-nums font-medium font-mono">{(priceYES * 100).toFixed(1)}¢/share</span>
              {usingLiveYES && <span className="text-muted/60"> (order-book ask)</span>}
            </p>
            {capital > 0 && N > 0 && (
              <p>Quantity: <span className="tabular-nums text-ink font-mono">{N} shares</span> · Cost: <span className="tabular-nums font-mono">{fmtUsd(N * priceYES)}</span></p>
            )}
            <p className="text-[9px] text-muted/60 border-l border-line/30 pl-2 mt-1">
              {(() => { const { url, verified } = getMarketUrl(low); return (
                <a href={url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-mint hover:text-mint-deep">
                  <PlatformLogo platform={low.platform} size={10} />
                  Open {platformLabel(low.platform)} market{!verified && ' (search)'} <ExternalLink size={9} />
                </a>
              ); })()}
              {' · '}{low.platform?.toLowerCase() === 'kalshi'
                ? `Kalshi fee: 7%×p×(1−p) ≈ ${(feePerContLow * 100).toFixed(3)}¢/contract.`
                : low.platform?.toLowerCase() === 'polymarket'
                  ? 'Polymarket: 0% trading fee.'
                  : `Fee: ${(low.fee * 100).toFixed(0)}%.`}
            </p>
          </div>
        </div>

        <div className="border-b border-line/20 pb-4 mb-4">
          <StepLabel n={2} text={`Buy NO on ${platformLabel(high.platform)}`} />
          <div className="ml-[42px] font-body text-[10px] text-muted leading-relaxed space-y-1">
            <p>Market: <span className="text-ink-2">{opp.question}</span></p>
            <p>
              Outcome: <span className="text-violet font-medium">NO</span>
              {' '}· Price: <span className="text-violet tabular-nums font-medium font-mono">{(priceNO * 100).toFixed(1)}¢/share</span>
              {usingLiveNO && <span className="text-muted/60"> (1 − YES bid)</span>}
            </p>
            {capital > 0 && N > 0 && (
              <p>Quantity: <span className="tabular-nums text-ink font-mono">{N} shares</span> · Cost: <span className="tabular-nums font-mono">{fmtUsd(N * priceNO)}</span></p>
            )}
            <p className="text-[9px] text-muted/60 border-l border-line/30 pl-2 mt-1">
              {(() => { const { url, verified } = getMarketUrl(high); return (
                <a href={url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-mint hover:text-mint-deep">
                  <PlatformLogo platform={high.platform} size={10} />
                  Open {platformLabel(high.platform)} market{!verified && ' (search)'} <ExternalLink size={9} />
                </a>
              ); })()}
              {' · '}{high.platform?.toLowerCase() === 'polymarket'
                ? 'Polymarket: 0% trading fee.'
                : high.platform?.toLowerCase() === 'kalshi'
                  ? `Kalshi fee: 7%×p×(1−p) ≈ ${(feePerContHigh * 100).toFixed(3)}¢/contract.`
                  : `Fee: ${(high.fee * 100).toFixed(0)}%.`}
            </p>
          </div>
        </div>

        <div className="border-b border-line/20 pb-4 mb-4">
          <StepLabel n={3} text="Open both legs as simultaneously as possible" />
          <div className="ml-[42px] font-body text-[10px] text-muted leading-relaxed">
            <p>Between fills the price can move. An unhedged leg is a directional bet. Minimize time between clicks.</p>
          </div>
        </div>

        <div className="border-b border-line/20 pb-4 mb-4">
          <StepLabel n={4} text="Hold to resolution — no active management needed" />
          <div className="ml-[42px] font-body text-[10px] text-muted leading-relaxed space-y-1">
            <p>Shares are non-fungible platform tokens — hold both until resolution.</p>
            {opp.resolutionDate && (
              <p>
                <span className="text-ink-2">Resolution: </span>
                <span className="font-medium">{fmtDate(opp.resolutionDate)}</span>
                {opp.daysToResolution != null && <span className="text-muted/60"> · {opp.daysToResolution} days</span>}
              </p>
            )}
            {opp.lockupFlag && <p className="text-gold/70 text-[9px]">⚠ {opp.lockupFlag}</p>}
          </div>
        </div>
      </div>

      {/* Resolution risk warning */}
      <div className="mb-6 px-4 py-4 border-2 border-coral-ink/40 bg-coral-tint/30 rounded-card">
        <div className="font-body text-[11px] font-bold text-coral-ink uppercase tracking-widest mb-3">
          ⚠ Resolution-risk warning — read before trading
        </div>
        <div className="font-body text-[10px] text-muted leading-relaxed space-y-2">
          <p>
            <span className="text-ink-2 font-medium">This is only a locked arb if both platforms resolve on the exact same real-world criteria, source, and date.</span>
            {' '}If they diverge — one says YES, one says NO — you lose on both legs simultaneously.
          </p>
          {opp.confirmReason && (
            <p>
              <span className="text-ink-2">AI confirmation: </span>
              <span className="italic">&quot;{opp.confirmReason}&quot;</span>
              <span className="text-muted/50"> — AI-generated, not guaranteed correct.</span>
            </p>
          )}
          <ul className="list-none space-y-1 ml-3 text-[9px]">
            <li>· <span className="text-ink-2">Criteria risk:</span> each platform writes its own resolution rules — read both descriptions carefully.</li>
            <li>· <span className="text-ink-2">Date risk:</span> one platform may resolve early (e.g. election night) while the other waits for certification.</li>
            <li>· <span className="text-ink-2">Void risk:</span> if either market is voided you carry a one-sided open position.</li>
            <li>· <span className="text-ink-2">Fill risk:</span> prices are snapshots — order book may move before you execute.</li>
          </ul>
          <p className="text-muted/60 text-[9px] mt-1">
            Manually verify resolution rules on both platforms before committing capital.
          </p>
        </div>
      </div>

      {/* Market links */}
      <SectionTitle title="Market links" />
      <div className="mb-6 flex flex-wrap gap-3">
        {(() => { const { url, verified } = getMarketUrl(low); return (
          <a href={url} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-body text-[10px] px-3 py-1.5 border border-mint-deep/30 text-mint-deep/70 hover:border-mint-deep hover:text-mint-deep rounded-button transition-colors duration-100">
            <ExternalLink size={10} />
            <PlatformLogo platform={low.platform} size={10} />
            {platformLabel(low.platform)} — YES market{!verified && ' (search)'}
          </a>
        ); })()}
        {(() => { const { url, verified } = getMarketUrl(high); return (
          <a href={url} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-body text-[10px] px-3 py-1.5 border border-violet/30 text-violet/70 hover:border-violet hover:text-violet rounded-button transition-colors duration-100">
            <ExternalLink size={10} />
            <PlatformLogo platform={high.platform} size={10} />
            {platformLabel(high.platform)} — NO market{!verified && ' (search)'}
          </a>
        ); })()}
      </div>
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PredictionDetailPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id);  // belt-and-suspenders decode; IDs are already alphanumeric

  const [data,    setData]    = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [capital, setCapital] = useState(1000);

  const load = useCallback(async () => {
    try {
      const res  = await fetch('/api/prediction', { cache: 'no-store' });
      const json = await res.json();
      setData(json);
    } catch { /* keep stale */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const opp = data?.valid?.find(o => o.id === id) ?? null;
  // roi/spread/confidence/probability/yesBid/yesAsk are redacted together as a
  // set for free tier — opp.roi is a reliable single proxy for "is this
  // opportunity's numbers visible" (see lib/paid-gating.ts REDACTION_MAP.prediction).
  const isRedacted = opp != null && opp.roi == null;
  // Collection stopped = the re-pricer/discovery agent's file has frozen. The existing !data?.valid
  // check below only catches a MISSING file — a frozen-but-present file passes it, so we gate on the
  // staleness clocks and never present the frozen ROI/prices/step math as current.
  const stopped = Boolean(data?.freshness?.repriceStale || data?.freshness?.discoveryStale);
  const asOf = data?.stats?.updatedAt ?? null;

  return (
    <div className="max-w-[860px] mx-auto px-4 py-6">

      {/* Back nav */}
      <div className="mb-5">
        <Link
          href="/dashboard/prediction"
          className="font-body text-[10px] text-muted hover:text-ink transition-colors duration-100"
        >
          ← Back to Prediction Markets
        </Link>
      </div>

      {loading ? (
        <div className="py-20 text-center font-body text-[10px] uppercase tracking-widest text-muted animate-pulse">
          Loading…
        </div>
      ) : !data?.valid ? (
        <div className="py-20 text-center font-body text-[10px] text-coral-ink">
          Data unavailable — matcher pipeline not running.
        </div>
      ) : !opp ? (
        <div className="py-20 text-center space-y-2">
          <div className="font-body text-[11px] text-muted">
            Opportunity not found — it may have expired or the spread closed.
          </div>
          <div className="mt-4">
            <Link href="/dashboard/prediction" className="font-body text-[10px] text-mint">
              ← Return to list
            </Link>
          </div>
        </div>
      ) : (
        <>
          {/* Header */}
          <div className="mb-5">
            <div className="flex items-center gap-3 mb-2">
              <span className="font-body text-[10px] uppercase tracking-widest px-1.5 py-[2px] bg-mint/10 text-mint border border-mint/25 rounded-sm">
                RESULT FOUND
              </span>
              <span className="font-body text-[9px] text-muted uppercase tracking-widest">{opp.category}</span>
            </div>
            <h1 className="font-display font-bold text-[17px] text-ink leading-snug mb-1">
              {opp.question}
            </h1>
            <p className="font-body text-[11px] text-muted">
              <PlatformLogo platform={opp.lowMarket.platform} size={11} className="mr-0.5" />
              {platformLabel(opp.lowMarket.platform)} ×{' '}
              <PlatformLogo platform={opp.highMarket.platform} size={11} className="mx-0.5" />
              {platformLabel(opp.highMarket.platform)}
              {' · '}
              {stopped
                ? '—'
                : isRedacted
                  ? 'upgrade to see ROI/spread'
                  : opp.type === 'cashable'
                    ? `${fmtPct(opp.roi!, 2)} net ROI${opp.annualizedROI != null && opp.daysToResolution != null ? ` · ${opp.annualizedROI.toFixed(1)}%/yr (${opp.daysToResolution}d lock)` : ''}`
                    : `${opp.spread!.toFixed(1)}pp spread`
              }
            </p>
            {stopped && (
              <div className="mt-2">
                <CollectionStoppedNote asOf={asOf} />
              </div>
            )}
          </div>

          {/* Branch on type — the live calculator, real bid/ask, ROI and
              step-by-step guide all derive from the same redacted field set,
              so free tier gets one panel rather than ~40 individually-blurred
              numbers (which would be unreadable in a dense calculator like this). */}
          {stopped ? (
            <div className="mt-4 px-4 py-4 border border-line bg-surface rounded-card">
              <CollectionStoppedNote asOf={asOf} />
              <p className="font-body text-[10px] text-muted leading-relaxed mt-3">
                La raccolta dati è ferma — prezzi, ROI e la guida di esecuzione non vengono più
                aggiornati. Non sono mostrati per non presentare numeri congelati come se fossero
                attuali. Torneranno quando la raccolta riprende.
              </p>
            </div>
          ) : isRedacted ? (
            <RedactedPanel
              label="The live calculator, real prices, ROI, and step-by-step execution guide are available on Pro"
              className="mt-4"
            />
          ) : opp.type === 'cashable' ? (
            <CashableDetail opp={opp as PaidOpportunity} capital={capital} setCapital={setCapital} />
          ) : (
            <SignalDetail opp={opp as PaidOpportunity} capital={capital} setCapital={setCapital} />
          )}

          {/* Disclaimer */}
          <div className="px-4 py-3 border border-line/30 bg-bg-soft/10 rounded-card font-body text-[9px] text-muted/50 leading-relaxed">
            Educational only. Not financial advice. Numbers are derived from a live data snapshot and will change.
            Resolution-criteria matching is AI-assisted and may be incorrect — verify both market descriptions on each platform
            before committing capital. Execution is entirely at your own risk.
          </div>
        </>
      )}
    </div>
  );
}
