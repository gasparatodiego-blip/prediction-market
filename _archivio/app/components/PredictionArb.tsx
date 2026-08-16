'use client';

import { useEffect, useState } from 'react';
import { Redacted } from './ui/Redacted';
import { Card, ScoreboardHeader, LegBox, ProgressBar, MetricValue, Chip, EmptyState } from './ds';
import CollectionStoppedNote from '@/app/components/CollectionStoppedNote';

/**
 * Cross-venue prediction-market arbitrage cards.
 *
 * HONEST-ENGINE — three things this tab deliberately does NOT do:
 *
 *  1. NO ANNUALIZED FIGURE, AND NO RISK-FREE COMPARISON. /api/prediction hardcodes
 *     annualizedROI: null with the comment "prediction pairs settle once at resolution,
 *     never recurring — so a future change can never leak a fabricated annualized/per-day
 *     figure". Computing roi x 365/daysToResolution here is exactly the number that guard
 *     blocks: a 5% return resolving in 3 days would print ~608%/yr, which is meaningless
 *     because the position cannot be repeated on demand. The card states the settlement
 *     shape instead, via a "one-time settlement · not annualizable" chip.
 *
 *  2. NO EXECUTABLE FIGURES ON MID-PRICE VENUES. Manifold, PredictIt and Futuur expose a
 *     mid/AMM price with no executable book, so a "net %" or a stake against them would be
 *     a price nobody can actually fill. Those rows render as SIGNAL ONLY — no net, no
 *     stake — with an amber chip saying why. The API's own tier/executable/depth fields
 *     drive this; the venue-name list is only a fallback.
 *
 *  3. NO SILENT SUPPRESSION OF OUTLIERS. A cashable row above 15% net is flagged for
 *     review with a red card and a QUARANTINE chip, not hidden — a genuine 20% cross-venue
 *     spread is nearly always a stale leg or a resolution-terms mismatch, and the honest
 *     move is to show it labelled rather than to quietly drop it or present it as ready.
 *
 * The convergence bar reads 0% by design: it represents how much of the capital lock-up
 * has elapsed, and for a position you have not entered yet that is zero. There is no
 * elapsed-progress denominator in this lane (data/history/predarb carries 0 rows because
 * `valid` has been empty), so the caption states the lock LENGTH rather than inventing a
 * fraction.
 */

const QUARANTINE_PCT = 15;
/** Fallback only — the API's tier/executable/depth fields are the primary signal. */
const MID_PRICE_VENUES = new Set(['manifold', 'predictit', 'futuur']);

interface Mkt {
  platform: string;
  probability: number | null;
  yesBid: number | null;
  yesAsk: number | null;
  depth: unknown[] | null;
  capacityUsd: number | null;
  fee?: number | null;
}
interface Row {
  id: string;
  question: string;
  lowMarket: Mkt;
  highMarket: Mkt;
  spread: number | null;
  roi: number | null;
  category: string | null;
  type: 'cashable' | 'signal';
  cashable?: boolean;
  annualizedROI: null;
  daysToResolution: number | null;
  resolutionDate: string | null;
  settlementType: string | null;
  capacityUsd: number | null;
  nonCashableReason?: string | null;
}
interface Payload {
  valid: Row[];
  stats: { validCount: number; cashableCount: number; signalCount: number; updatedAt?: number | null };
  isPaid?: boolean;
  // When the re-pricer/discovery agent is stopped its /tmp file freezes; these flags let the UI
  // stop presenting the frozen numbers as current (see lib/collection-status.js).
  freshness?: { repriceStale?: boolean; discoveryStale?: boolean };
}

const isMidPrice = (m: Mkt) =>
  MID_PRICE_VENUES.has(String(m.platform ?? '').toLowerCase()) ||
  (m.yesBid == null && m.yesAsk == null && m.probability != null);

const fmtUsd = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `$${(n / 1_000).toFixed(0)}k` : `$${n.toFixed(0)}`;
const fmtPrice = (n: number | null) => (n == null ? '—' : n.toFixed(3));

export default function PredictionArb() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch('/api/prediction', { cache: 'no-store' });
        const j = await r.json();
        if (!alive) return;
        setData(j); setErr(null);
      } catch (e: any) {
        if (alive) setErr(e?.message ?? 'fetch failed');
      }
    }
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const isPaid = data?.isPaid ?? false;
  const rows = data?.valid ?? [];
  // Collection stopped = the producing agent's file has frozen. Never present frozen numbers as
  // current: show the note near the header and dash the numeric values below.
  const stopped = Boolean(data?.freshness?.repriceStale || data?.freshness?.discoveryStale);
  const asOf = data?.stats?.updatedAt ?? null;

  return (
    <div className="prediction">
      <div className="cc-shell">

        <header className="cc-head">
          <h1 className="cc-title">
            <span className="cc-title-dim">Edgeradar /</span> prediction
            <span className="cc-title-accent"> · cross-venue</span>
          </h1>
          <p className="cc-sub">
            buy the cheap side on one venue, the other side on another — hold to resolution
          </p>
        </header>

        {stopped && (
          <div className="cc-stopped-note" style={{ marginBottom: '0.75rem' }}>
            <CollectionStoppedNote asOf={asOf} />
          </div>
        )}

        {err && <EmptyState prefix="cc" title="Prediction feed unavailable" sub={err} />}
        {!err && !data && <EmptyState prefix="cc" sub="Loading prediction book…" />}
        {!err && data && rows.length === 0 && (
          <EmptyState prefix="cc" title="No prediction crossings clear fees right now." />
        )}

        {!err && data && rows.map((r) => {
          const signalOnly = r.type === 'signal' || r.cashable === false
            || isMidPrice(r.lowMarket) || isMidPrice(r.highMarket);
          const net = signalOnly ? null : r.roi;
          const quarantined = !stopped && !signalOnly && typeof net === 'number' && net > QUARANTINE_PCT;
          const days = r.daysToResolution;
          const resolves = r.resolutionDate ? String(r.resolutionDate).slice(0, 10) : '—';
          // Binding leg = the thinner book. Only meaningful when both sides publish depth.
          const lowCap = r.lowMarket.capacityUsd, highCap = r.highMarket.capacityUsd;
          const binding = lowCap != null && highCap != null
            ? (lowCap <= highCap ? r.lowMarket.platform : r.highMarket.platform)
            : null;

          return (
            <Card key={r.id} prefix="cc" className={quarantined ? 'is-quarantine' : ''}>

              <ScoreboardHeader
                prefix="cc"
                left={
                  <span className="cc-ident">
                    {r.category ?? '—'} <span className="cc-dot">·</span> resolves {resolves}
                  </span>
                }
                right={
                  <span className="cc-dte">{days == null ? '—' : `${days}d to resolve`}</span>
                }
              />

              <h2 className="cc-match">{r.question}</h2>

              <div className="cc-legs">
                <LegBox
                  prefix="cc"
                  accent="spot"
                  slots={[
                    { cls: 'label', text: r.lowMarket.platform },
                    { cls: 'price', text: stopped ? '—' : fmtPrice(r.lowMarket.yesAsk ?? r.lowMarket.probability) },
                    { cls: 'tag',   text: isMidPrice(r.lowMarket) ? 'mid' : 'ask' },
                  ]}
                />
                <LegBox
                  prefix="cc"
                  accent="future"
                  slots={[
                    { cls: 'label', text: r.highMarket.platform },
                    { cls: 'price', text: stopped ? '—' : fmtPrice(r.highMarket.yesBid ?? r.highMarket.probability) },
                    { cls: 'tag',   text: isMidPrice(r.highMarket) ? 'mid' : 'bid' },
                  ]}
                />

                <MetricValue
                  prefix="cc"
                  value={
                    stopped || signalOnly
                      ? <span className="cc-dim">—</span>
                      : <Redacted value={net} isPaid={isPaid}>{(v) => <>+{Number(v).toFixed(2)}%</>}</Redacted>
                  }
                  caption={stopped ? 'collection stopped' : signalOnly ? 'signal only' : 'net · post-fee'}
                />
              </div>

              <ProgressBar prefix="cc" pct={0} mode="fill" active={false} />
              <p className="cc-bar-cap">
                capital locked to resolution{days == null ? '' : ` · ${days}d`}
              </p>

              <div className="cc-figs">
                <span>
                  max stake{' '}
                  {stopped || signalOnly
                    ? <strong className="cc-dim">—</strong>
                    : <Redacted value={r.capacityUsd} isPaid={isPaid}>{(v) => <strong>{fmtUsd(Number(v))}</strong>}</Redacted>}
                  {binding && !signalOnly && !stopped && <span className="cc-dim"> · {binding} binds</span>}
                </span>
                <span>
                  spread{' '}
                  {stopped
                    ? <strong className="cc-dim">—</strong>
                    : <Redacted value={r.spread} isPaid={isPaid}>{(v) => <strong>{Number(v).toFixed(3)}</strong>}</Redacted>}
                </span>
              </div>

              <div className="cc-foot">
                <Chip prefix="cc">one-time settlement · not annualizable</Chip>
                <Chip prefix="cc">{r.lowMarket.platform} / {r.highMarket.platform}</Chip>
                {signalOnly && <Chip prefix="cc" amber>signal · mid-price, not cashable</Chip>}
                {quarantined && (
                  <span className="cc-chip is-danger">⚠ QUARANTINE · &gt;{QUARANTINE_PCT}% auto-review</span>
                )}
              </div>
            </Card>
          );
        })}

        {data && (
          <p className="cc-note">
            Prediction pairs settle once at resolution, so no annualized figure is shown —
            a one-time return cannot honestly be projected to a yearly rate. Mid-price venues
            (Manifold, PredictIt, Futuur) publish no executable book and are marked signal only.
          </p>
        )}
      </div>
    </div>
  );
}
