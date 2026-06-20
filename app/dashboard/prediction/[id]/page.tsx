'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Leg {
  platform:    string;
  probability: number;     // 0–100 (mid-price in cents)
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
  spread:           number;
  roi:              number;        // net ROI % after fees (authoritative)
  earnPer100:       number | null;
  confidence:       number;
  category:         string;
  type:             'cashable' | 'signal';
  annualizedROI?:   number | null;
  daysToResolution?: number | null;
  resolutionDate?:  string | null;
  confirmReason?:   string | null;
  lockupFlag?:      string | null;
}

interface ApiResponse {
  valid:     Opportunity[];
  rejected:  number;
  stats:     unknown;
  freshness: { isFresh: boolean; ageMinutes: number | null; label: string | null };
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
        if (/kalshi\.com\/markets\/.+/.test(leg.url) && leg.url !== 'https://kalshi.com') return { url: leg.url, verified: true };
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
    <h2 className="font-mono text-[9px] uppercase tracking-widest text-text-muted mb-3 mt-6 border-b border-border/30 pb-1.5">
      {title}
    </h2>
  );
}

function StepLabel({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex items-start gap-3 mb-4">
      <span className="font-mono text-[9px] px-1.5 py-[2px] border border-border text-text-muted shrink-0 mt-0.5">
        {String(n).padStart(2, '0')}
      </span>
      <span className="font-mono text-[11px] text-text-secondary font-medium">{text}</span>
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
  opp:        Opportunity;
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
      <div className="mb-5 px-4 py-3 bg-bg-panel border border-border font-mono text-[11px]">
        <div className="font-mono text-[9px] uppercase tracking-widest text-text-muted mb-2">Current prices (snapshot)</div>
        <div className="flex flex-wrap gap-x-8 gap-y-1.5">
          <span>
            <span className="text-text-muted">YES on {platformLabel(low.platform)}: </span>
            <span className="text-positive font-medium tabular-nums">
              {(priceYES * 100).toFixed(1)}¢
            </span>
            {usingLiveYES && (
              <span className="text-text-muted/60 text-[9px] ml-1">
                (ask · mid {low.probability}¢)
              </span>
            )}
          </span>
          <span>
            <span className="text-text-muted">NO on {platformLabel(high.platform)}: </span>
            <span className="text-accent font-medium tabular-nums">
              {(priceNO * 100).toFixed(1)}¢
            </span>
            {usingLiveNO && (
              <span className="text-text-muted/60 text-[9px] ml-1">
                (1 − bid · mid {(100 - high.probability)}¢)
              </span>
            )}
          </span>
          <span>
            <span className="text-text-muted">Cost per contract pair: </span>
            <span className="text-text-primary tabular-nums font-medium">{(costPerPair * 100).toFixed(1)}¢</span>
          </span>
          <span>
            <span className="text-text-muted">Net ROI: </span>
            <span className="text-positive font-medium tabular-nums">{fmtPct(netROI, 2)}</span>
            <span className="text-text-muted/60 text-[9px] ml-1">(real fee model · matcher: {fmtPct(opp.roi, 2)})</span>
          </span>
        </div>
        {!usingLiveYES && !usingLiveNO && (
          <p className="font-mono text-[9px] text-warning/60 mt-1.5">
            No order-book data — prices shown are mid-market. Actual executable prices may differ.
          </p>
        )}
      </div>

      {/* Capital input */}
      <div className="mb-5 px-4 py-3 bg-bg-panel border border-border">
        <div className="font-mono text-[9px] uppercase tracking-widest text-text-muted mb-2">Your capital</div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-text-muted">$</span>
          <input
            type="number" min={0} step={100} value={capital}
            onChange={e => setCapital(Math.max(0, parseFloat(e.target.value) || 0))}
            className="w-[5rem] px-1.5 py-0.5 font-mono text-[11px] bg-bg-panel border border-border text-text-primary focus:border-accent/50 focus:outline-none tabular-nums"
          />
        </div>
      </div>

      {/* P&L estimate */}
      {capital > 0 && N > 0 && (
        <div className="mb-6 px-4 py-4 border border-positive/25 bg-positive/5">
          <div className="font-mono text-[9px] uppercase tracking-widest text-text-muted mb-2">
            Estimated outcome at ${capital.toLocaleString()}
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-1.5 font-mono text-[11px] mb-4">
            <span>
              <span className="text-text-muted">Contracts: </span>
              <span className="text-text-primary font-medium tabular-nums">{N} pairs</span>
              <span className="text-text-muted/60 text-[9px] ml-1">({N} YES + {N} NO)</span>
            </span>
            <span>
              <span className="text-text-muted">Total deployed: </span>
              <span className="text-text-primary tabular-nums font-medium">{fmtUsd(totalCost)}</span>
              <span className="text-text-muted/60 text-[9px] ml-1">({fmtUsd(capital - totalCost)} undeployed)</span>
            </span>
            <span>
              <span className="text-positive font-bold text-[14px] tabular-nums">{fmtUsd(netProfit)} locked profit</span>
              <span className="text-text-muted/60 text-[9px] ml-1">(net, at resolution)</span>
            </span>
            {opp.annualizedROI != null && opp.daysToResolution != null && (
              <span>
                <span className="text-text-muted">Annualized: </span>
                <span className="text-positive tabular-nums">{fmtPct(opp.annualizedROI, 1)}/yr</span>
                <span className="text-text-muted/60 text-[9px] ml-1">({opp.daysToResolution}d lock)</span>
              </span>
            )}
          </div>

          {/* Fee breakdown */}
          <div className="border-t border-border/30 pt-3">
            <div className="font-mono text-[9px] uppercase tracking-widest text-text-muted mb-2">Fee breakdown</div>
            <div className="space-y-[3px] font-mono text-[10px]">
              <div className="flex gap-2">
                <span className="text-text-muted w-[120px] shrink-0">Gross profit</span>
                <span className="text-text-muted/60 text-[9px]">{N} × {(grossProfitPerPair * 100).toFixed(2)}¢</span>
                <span className="text-text-primary tabular-nums ml-auto">{fmtUsd(grossProfit)}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-text-muted w-[120px] shrink-0">{platformLabel(low.platform)} fee</span>
                <span className="text-text-muted/60 text-[9px]">
                  {low.platform?.toLowerCase() === 'polymarket' ? '0% · no trading fee'
                   : low.platform?.toLowerCase() === 'kalshi'
                     ? `7%×${(priceYES*100).toFixed(1)}¢×${((1-priceYES)*100).toFixed(1)}¢`
                     : `${(low.fee*100).toFixed(0)}% on winnings`}
                </span>
                <span className={`tabular-nums ml-auto ${totalFeeOnLow === 0 ? 'text-text-muted/50' : 'text-negative/80'}`}>
                  {fmtUsd(-totalFeeOnLow)}
                </span>
              </div>
              <div className="flex gap-2">
                <span className="text-text-muted w-[120px] shrink-0">{platformLabel(high.platform)} fee</span>
                <span className="text-text-muted/60 text-[9px]">
                  {high.platform?.toLowerCase() === 'polymarket' ? '0% · no trading fee'
                   : high.platform?.toLowerCase() === 'kalshi'
                     ? `7%×${(highYesDec*100).toFixed(1)}¢×${((1-highYesDec)*100).toFixed(1)}¢`
                     : `${(high.fee*100).toFixed(0)}% on winnings`}
                </span>
                <span className={`tabular-nums ml-auto ${totalFeeOnHigh === 0 ? 'text-text-muted/50' : 'text-negative/80'}`}>
                  {fmtUsd(-totalFeeOnHigh)}
                </span>
              </div>
              <div className="flex gap-2 border-t border-border/30 pt-1.5 mt-1">
                <span className="text-text-secondary font-medium">Net profit</span>
                <span className="text-text-muted/50 text-[9px] ml-1">({netROI.toFixed(2)}% ROI on deployed)</span>
                <span className="text-positive font-medium tabular-nums ml-auto">{fmtUsd(netProfit)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
      {capital > 0 && N === 0 && (
        <div className="mb-6 px-4 py-3 border border-border bg-bg-panel font-mono text-[10px] text-warning/70">
          Capital too low to buy even one contract pair at {(costPerPair * 100).toFixed(1)}¢/pair cost.
        </div>
      )}

      {/* Step-by-step guide */}
      <SectionTitle title="Step-by-step execution guide" />
      <div className="space-y-0 mb-6">

        <div className="border-b border-border/20 pb-4 mb-4">
          <StepLabel n={1} text={`Buy YES on ${platformLabel(low.platform)}`} />
          <div className="ml-[42px] font-mono text-[10px] text-text-muted leading-relaxed space-y-1">
            <p>
              Market: <span className="text-text-secondary">{opp.question}</span>
            </p>
            <p>
              Outcome to buy: <span className="text-positive font-medium">YES</span>
              {' '} · Price: <span className="text-positive tabular-nums font-medium">{(priceYES * 100).toFixed(1)}¢ per share</span>
              {usingLiveYES && <span className="text-text-muted/60"> (order-book ask)</span>}
            </p>
            {capital > 0 && N > 0 && (
              <p>
                Quantity: <span className="text-text-primary tabular-nums">{N} shares</span>
                {' '}· Cost: <span className="tabular-nums text-text-primary">{fmtUsd(N * priceYES)}</span>
              </p>
            )}
            <p className="text-[9px] text-text-muted/60 border-l border-border/30 pl-2 mt-1">
              {(() => { const { url: lu, verified: lv } = getMarketUrl(low); return (
                <a href={lu} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-accent hover:text-accent-bright">
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

        <div className="border-b border-border/20 pb-4 mb-4">
          <StepLabel n={2} text={`Buy NO on ${platformLabel(high.platform)}`} />
          <div className="ml-[42px] font-mono text-[10px] text-text-muted leading-relaxed space-y-1">
            <p>
              Market: <span className="text-text-secondary">{opp.question}</span>
            </p>
            <p>
              Outcome to buy: <span className="text-accent font-medium">NO</span>
              {' '}· Price: <span className="text-accent tabular-nums font-medium">{(priceNO * 100).toFixed(1)}¢ per share</span>
              {usingLiveNO && <span className="text-text-muted/60"> (1 − YES bid)</span>}
            </p>
            {capital > 0 && N > 0 && (
              <p>
                Quantity: <span className="text-text-primary tabular-nums">{N} shares</span>
                {' '}· Cost: <span className="tabular-nums text-text-primary">{fmtUsd(N * priceNO)}</span>
              </p>
            )}
            <p className="text-[9px] text-text-muted/60 border-l border-border/30 pl-2 mt-1">
              {(() => { const { url: hu, verified: hv } = getMarketUrl(high); return (
                <a href={hu} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-accent hover:text-accent-bright">
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

        <div className="border-b border-border/20 pb-4 mb-4">
          <StepLabel n={3} text="Why equal contract count (not equal dollar size)" />
          <div className="ml-[42px] font-mono text-[10px] text-text-muted leading-relaxed space-y-1.5">
            <p>
              You buy the same number of shares ({N > 0 ? N : 'N'}) on each side — not equal dollars.
              Each share resolves to exactly $1 (win) or $0 (loss).
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 my-2 text-[9px]">
              <div className="text-text-secondary font-medium">If YES resolves:</div>
              <div className="text-text-secondary font-medium">If NO resolves:</div>
              <div className="text-positive">YES shares → $1/share × {N > 0 ? N : 'N'} = ${N > 0 ? N : 'N'}</div>
              <div className="text-text-muted">YES shares → $0/share × {N > 0 ? N : 'N'} = $0</div>
              <div className="text-text-muted">NO shares → $0/share × {N > 0 ? N : 'N'} = $0</div>
              <div className="text-positive">NO shares → $1/share × {N > 0 ? N : 'N'} = ${N > 0 ? N : 'N'}</div>
              <div className="text-text-secondary font-medium pt-0.5">Net received: ${N > 0 ? N : 'N'}</div>
              <div className="text-text-secondary font-medium pt-0.5">Net received: ${N > 0 ? N : 'N'}</div>
            </div>
            <p>
              In both cases you receive ${N > 0 ? N.toLocaleString() : 'N'}.
              You paid {fmtUsd(totalCost > 0 ? totalCost : costPerPair)}{N > 0 ? ` total` : ` per pair`}.
              Gross profit = ${N > 0 ? N : 'N'} − {fmtUsd(totalCost > 0 ? totalCost : costPerPair)} = {fmtUsd(N > 0 ? (N - totalCost) : grossProfitPerPair)}.
            </p>
            <p className="text-[9px] text-warning/70">
              This only holds if both platforms resolve identically (same real-world outcome, same criteria, same date).
              See the resolution-risk warning below.
            </p>
          </div>
        </div>

        <div className="border-b border-border/20 pb-4 mb-4">
          <StepLabel n={4} text="Open both legs as simultaneously as possible" />
          <div className="ml-[42px] font-mono text-[10px] text-text-muted leading-relaxed">
            <p>
              Between your first fill and your second, the price can move on either platform.
              An unhedged leg is a directional bet on the event. Minimize the time between clicks.
            </p>
          </div>
        </div>

        <div className="border-b border-border/20 pb-4 mb-4">
          <StepLabel n={5} text="Hold to resolution — no active management needed" />
          <div className="ml-[42px] font-mono text-[10px] text-text-muted leading-relaxed space-y-1">
            <p>
              Shares are non-fungible claims — they cannot be transferred between platforms.
              Once bought, hold both legs until the market resolves. You can sell early on each platform&apos;s
              own secondary market if prices move, but the locked profit only materialises at resolution.
            </p>
            {opp.resolutionDate && (
              <p>
                <span className="text-text-secondary">Resolution date: </span>
                <span className="text-text-primary font-medium">{fmtDate(opp.resolutionDate)}</span>
                {opp.daysToResolution != null && (
                  <span className="text-text-muted/60"> · {opp.daysToResolution} days from now</span>
                )}
              </p>
            )}
            {opp.lockupFlag && (
              <p className="text-warning/70 text-[9px]">⚠ {opp.lockupFlag}</p>
            )}
          </div>
        </div>

        <div className="border-b border-border/20 pb-4 mb-4">
          <StepLabel n={6} text="At resolution — collect payout" />
          <div className="ml-[42px] font-mono text-[10px] text-text-muted leading-relaxed space-y-1">
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
      <div className="mb-6 px-4 py-4 bg-bg-panel border border-border">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-4 mb-4">
          <div>
            <div className="font-mono text-[9px] uppercase tracking-widest text-text-muted mb-1">Net ROI at current price</div>
            <div className="font-mono text-[18px] font-bold text-positive tabular-nums">{fmtPct(netROI, 2)}</div>
            <div className="font-mono text-[9px] text-text-muted/70 mt-0.5">real fee model · matcher stored {fmtPct(opp.roi, 2)}</div>
          </div>
          {opp.annualizedROI != null && (
            <div>
              <div className="font-mono text-[9px] uppercase tracking-widest text-text-muted mb-1">Annualized ROI</div>
              <div className="font-mono text-[18px] font-bold text-positive/80 tabular-nums">{fmtPct(opp.annualizedROI, 1)}/yr</div>
              <div className="font-mono text-[9px] text-text-muted/70 mt-0.5">capital locked {opp.daysToResolution ?? '?'}d to resolution</div>
            </div>
          )}
          <div>
            <div className="font-mono text-[9px] uppercase tracking-widest text-text-muted mb-1">Spread</div>
            <div className="font-mono text-[18px] font-bold text-text-primary tabular-nums">{opp.spread.toFixed(1)}pp</div>
            <div className="font-mono text-[9px] text-text-muted/70 mt-0.5">YES price difference between platforms</div>
          </div>
        </div>
        <div className="font-mono text-[9px] text-text-muted leading-relaxed space-y-1">
          <p>
            <span className="text-text-secondary">Exit early when: </span>
            spread narrows to near-zero (most edge is captured) OR one platform changes its resolution criteria
            OR you need liquidity before resolution.
          </p>
          <p>
            <span className="text-text-secondary">Early exit cost: </span>
            selling early on each platform incurs spread + fees a second time, reducing net profit.
            Compare early-exit prices carefully before acting.
          </p>
        </div>
      </div>

      {/* RESOLUTION RISK — PROMINENT */}
      <div className="mb-6 px-4 py-4 border-2 border-negative/40 bg-negative/5">
        <div className="font-mono text-[11px] font-bold text-negative uppercase tracking-widest mb-3">
          ⚠ Resolution-risk warning — read before trading
        </div>
        <div className="font-mono text-[10px] text-text-muted leading-relaxed space-y-2">
          <p>
            <span className="text-text-secondary font-medium">This is only a locked arb if both platforms resolve on the exact same real-world criteria, source, and date.</span>
            {' '}If they diverge — one says YES, one says NO — you lose on both legs simultaneously.
          </p>
          {opp.confirmReason && (
            <p>
              <span className="text-text-secondary">AI confirmation: </span>
              <span className="text-text-muted/80 italic">&quot;{opp.confirmReason}&quot;</span>
              <span className="text-text-muted/50"> — AI-generated, not guaranteed to be correct.</span>
            </p>
          )}
          <ul className="list-none space-y-1 ml-3 text-[9px]">
            <li>· <span className="text-text-secondary">Criteria risk:</span> each platform writes its own resolution rules. Read both market descriptions carefully. Words like &quot;wins&quot; or &quot;elected&quot; can differ in edge cases.</li>
            <li>· <span className="text-text-secondary">Date risk:</span> if one platform resolves early (e.g. on election night) and the other waits for official certification, you carry a one-sided open position in between.</li>
            <li>· <span className="text-text-secondary">Void / cancel risk:</span> if either market is voided or cancelled, that leg reverts to cost price while the other leg may already have resolved. This leaves you with a one-sided directional position you did not intend to hold.</li>
            <li>· <span className="text-text-secondary">Fill risk:</span> prices shown are snapshots. The order book may have moved or dried up by the time you execute. Partial fills create uncovered directional exposure.</li>
          </ul>
          <p className="text-text-muted/60 text-[9px] mt-1">
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
            className="inline-flex items-center gap-1.5 font-mono text-[10px] px-3 py-1.5 border border-positive/30 text-positive/70 hover:border-positive hover:text-positive transition-colors duration-100">
            <ExternalLink size={10} />
            {platformLabel(low.platform)} — YES market{!lv && ' (search)'}
          </a>
        ); })()}
        {(() => { const { url: hu, verified: hv } = getMarketUrl(high); return (
          <a href={hu} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-mono text-[10px] px-3 py-1.5 border border-accent/30 text-accent/70 hover:border-accent hover:text-accent transition-colors duration-100">
            <ExternalLink size={10} />
            {platformLabel(high.platform)} — NO market{!hv && ' (search)'}
          </a>
        ); })()}
      </div>
    </>
  );
}

// ── SIGNAL detail ─────────────────────────────────────────────────────────────

function SignalDetail({ opp }: { opp: Opportunity }) {
  const low  = opp.lowMarket;
  const high = opp.highMarket;

  return (
    <>
      {/* What this is */}
      <div className="mb-5 px-4 py-4 bg-bg-panel border border-warning/30">
        <div className="font-mono text-[11px] font-semibold text-warning uppercase tracking-widest mb-2">
          Signal only — not a cashable arbitrage
        </div>
        <div className="font-mono text-[10px] text-text-muted leading-relaxed space-y-2">
          <p>
            At least one leg of this opportunity is on a platform that does not use real money.
            You cannot exchange positions between these platforms, so the shown price divergence
            cannot be captured as guaranteed profit.
          </p>
          <p>
            <span className="text-text-secondary">What it means instead: </span>
            the {platformLabel(low.platform)} crowd prices this event at {low.probability}¢
            while {platformLabel(high.platform)} prices it at {high.probability}¢ — a {opp.spread.toFixed(1)}pp
            divergence. This is directional information, not a risk-free arb.
          </p>
          <p>
            If you believe one platform&apos;s crowd is correct and the other is wrong, you can trade
            the mispriced side on whichever executable platform is involved — accepting full
            directional risk.
          </p>
        </div>
      </div>

      {/* Price comparison */}
      <SectionTitle title="Price comparison (informational only)" />
      <div className="mb-6 px-4 py-4 bg-bg-panel border border-border font-mono text-[10px]">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-[9px] uppercase tracking-widest text-text-muted mb-1">{platformLabel(low.platform)}</div>
            <div className="text-[18px] font-bold text-text-primary tabular-nums">{low.probability}¢ YES</div>
            <div className="text-[9px] text-text-muted/70 mt-0.5">
              {['manifold'].includes(low.platform?.toLowerCase())
                ? 'Play-money (MANA) — not convertible to cash'
                : 'Real-money market'
              }
            </div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-widest text-text-muted mb-1">{platformLabel(high.platform)}</div>
            <div className="text-[18px] font-bold text-text-primary tabular-nums">{high.probability}¢ YES</div>
            <div className="text-[9px] text-text-muted/70 mt-0.5">
              {['manifold'].includes(high.platform?.toLowerCase())
                ? 'Play-money (MANA) — not convertible to cash'
                : 'Real-money market'
              }
            </div>
          </div>
        </div>
        <div className="mt-3 pt-3 border-t border-border/30">
          <span className="text-text-muted">Spread: </span>
          <span className="text-warning font-medium">{opp.spread.toFixed(1)}pp</span>
          <span className="text-text-muted ml-2">· Conf {Math.round(opp.confidence * 100)}%</span>
        </div>
        {opp.confirmReason && (
          <p className="text-[9px] text-text-muted/60 mt-2 italic">&quot;{opp.confirmReason}&quot;</p>
        )}
      </div>

      {/* Why non-executable explainer */}
      <SectionTitle title="Why this cannot be executed as an arbitrage" />
      <div className="mb-6 space-y-2 font-mono text-[10px] text-text-muted leading-relaxed">
        {[
          {
            label: 'Play-money platform',
            body: 'Manifold Markets uses MANA, a non-transferable play currency. You cannot deposit or withdraw real money. A "price" on Manifold represents community belief, not an executable bid or offer.',
          },
          {
            label: 'No cross-platform settlement',
            body: 'Prediction market shares are platform-specific tokens. There is no mechanism to move a YES share from one platform to another. Each platform resolves independently.',
          },
          {
            label: 'What you can do',
            body: 'If the real-money side (e.g. Kalshi or Polymarket) is priced very differently from the crowd wisdom shown on Manifold, and you trust the Manifold crowd, you can trade the real-money side accepting full directional risk.',
          },
        ].map(({ label, body }) => (
          <div key={label} className="flex items-start gap-3">
            <span className="text-warning/60 shrink-0 mt-px">▸</span>
            <span>
              <span className="text-text-secondary font-medium">{label}: </span>
              {body}
            </span>
          </div>
        ))}
      </div>

      {/* Links for reference */}
      <SectionTitle title="Market links (reference only)" />
      <div className="mb-6 flex flex-wrap gap-3">
        {(() => { const { url: lu, verified: lv } = getMarketUrl(low); return (
          <a href={lu} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-mono text-[10px] px-3 py-1.5 border border-border text-text-muted hover:border-text-secondary hover:text-text-primary transition-colors duration-100">
            <ExternalLink size={10} />
            {platformLabel(low.platform)} market{!lv && ' (search)'}
          </a>
        ); })()}
        {(() => { const { url: hu, verified: hv } = getMarketUrl(high); return (
          <a href={hu} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-mono text-[10px] px-3 py-1.5 border border-border text-text-muted hover:border-text-secondary hover:text-text-primary transition-colors duration-100">
            <ExternalLink size={10} />
            {platformLabel(high.platform)} market{!hv && ' (search)'}
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

  return (
    <div className="max-w-[860px] mx-auto px-4 py-6">

      {/* Back nav */}
      <div className="mb-5">
        <Link
          href="/dashboard/prediction"
          className="font-mono text-[10px] text-text-muted hover:text-text-primary transition-colors duration-100"
        >
          ← Back to Prediction Markets
        </Link>
      </div>

      {loading ? (
        <div className="py-20 text-center font-mono text-[10px] uppercase tracking-widest text-text-muted animate-pulse">
          Loading…
        </div>
      ) : !data?.valid ? (
        <div className="py-20 text-center font-mono text-[10px] text-negative">
          Data unavailable — matcher pipeline not running.
        </div>
      ) : !opp ? (
        <div className="py-20 text-center space-y-2">
          <div className="font-mono text-[11px] text-text-muted">
            Opportunity not found — it may have expired or the spread closed.
          </div>
          <div className="mt-4">
            <Link href="/dashboard/prediction" className="font-mono text-[10px] text-accent">
              ← Return to list
            </Link>
          </div>
        </div>
      ) : (
        <>
          {/* Header */}
          <div className="mb-5">
            <div className="flex items-center gap-3 mb-2">
              {opp.type === 'cashable' ? (
                <span className="font-mono text-[10px] uppercase tracking-widest px-1.5 py-[2px] bg-positive/10 text-positive border border-positive/25">
                  CASHABLE ARB
                </span>
              ) : (
                <span className="font-mono text-[10px] uppercase tracking-widest px-1.5 py-[2px] bg-warning/10 text-warning border border-warning/25">
                  SIGNAL ONLY
                </span>
              )}
              <span className="font-mono text-[9px] text-text-muted uppercase tracking-widest">{opp.category}</span>
            </div>
            <h1 className="font-mono text-[17px] font-bold text-text-primary leading-snug mb-1">
              {opp.question}
            </h1>
            <p className="font-mono text-[11px] text-text-muted">
              {platformLabel(opp.lowMarket.platform)} × {platformLabel(opp.highMarket.platform)}
              {' · '}{fmtPct(opp.roi, 2)} net ROI
              {opp.annualizedROI != null && ` · ${opp.annualizedROI.toFixed(1)}%/yr annualized`}
            </p>
          </div>

          {/* Branch on type */}
          {opp.type === 'cashable' ? (
            <CashableDetail opp={opp} capital={capital} setCapital={setCapital} />
          ) : (
            <SignalDetail opp={opp} />
          )}

          {/* Disclaimer */}
          <div className="px-4 py-3 border border-border/30 bg-bg-elevated/10 font-mono text-[9px] text-text-muted/50 leading-relaxed">
            Educational only. Not financial advice. Numbers are derived from a live data snapshot and will change.
            Resolution-criteria matching is AI-assisted and may be incorrect — verify both market descriptions on each platform
            before committing capital. Execution is entirely at your own risk.
          </div>
        </>
      )}
    </div>
  );
}
