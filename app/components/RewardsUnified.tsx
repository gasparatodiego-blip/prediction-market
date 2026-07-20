'use client';

import { useEffect, useMemo, useState } from 'react';
import { Redacted } from './ui/Redacted';
import { Card, ScoreboardHeader, MetricValue, Chip, EmptyState } from './ds';
import { estimateReward, type MarketSnapshot, type Venue } from '@/lib/rewards-estimate';

/**
 * Liquidity rewards — CONTINUOUS-YIELD lane.
 *
 * Deliberately has NO ProgressBar. Sport drains toward a quote expiring and Carry fills
 * toward settlement; a reward pool has neither. Rendering a convergence bar here would
 * imply a countdown that does not exist.
 *
 * HONEST-ENGINE
 *  - PRIMARY figure is net $/day at a stated $1,000 basis, straight from
 *    lib/rewards-estimate (the existing SSOT this lane already used) — not recomputed here.
 *    That estimator subtracts adverse-selection cost from the gross reward, so the headline
 *    is net, and it WITHHOLDS net entirely (null) when the implied run-rate breaches the
 *    200%/yr ceiling rather than printing a number it does not believe.
 *  - Annualized is demoted to the data row, capped and labelled by that same module.
 *  - Capacity is real book depth at the reward band; unknown renders "—".
 *  - Risk flags are the API's OWN flags (TRAP, THIN_CAP, SHORT_BURST, ONE_SIDED, …), not a
 *    label invented here. There is no "promo" flag in this feed, so none is shown.
 *  - Rewards are not a promise: a pool can be re-weighted or end, and SHORT_BURST marks the
 *    ones already known to be transient.
 */

const CAPITAL_BASIS = 1000;

interface Side { midpoint: number | null; qualifyingLiquidity: number | null; bookDepthAtBand: number | null; bookSpread: number | null; volatilityStdev: number | null }
interface Market {
  venue: Venue;
  marketId: string;
  title: string;
  groupItemTitle?: string | null;
  category?: string | null;
  midpoint: number | null;
  maxSpread: number | null;
  minSize: number | null;
  dailyPool: number | null;
  qualifyingLiquidity: number | null;
  bookDepthAtBand: number | null;
  volatilityStdev: number | null;
  bookSpread: number | null;
  hoursToResolution: number | null;
  volatilityRisk?: string | null;
  flags?: string[] | null;
  sides?: { yes?: Side; no?: Side } | null;
}
interface Payload { meta: any; markets: Market[]; stale: boolean; isPaid?: boolean }

const fmtUsd = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `$${(n / 1_000).toFixed(0)}k` : `$${n.toFixed(0)}`;

// Mirrors the snapshot + distance convention the rewards page already used, so this card
// surface and the previous desk view feed the estimator identically.
function toSnapshot(m: Market): MarketSnapshot {
  return {
    venue:               m.venue,
    midpoint:            m.midpoint,
    maxSpread:           m.maxSpread,
    minSize:             m.minSize,
    dailyPool:           m.dailyPool,
    qualifyingLiquidity: m.qualifyingLiquidity,
    bookDepthAtBand:     m.bookDepthAtBand,
    volatilityStdev:     m.volatilityStdev,
    twoSidedRequired:    (m as any).twoSidedRequired,
    sides:               (m.sides as any) ?? null,
  };
}
/** distance from mid where the order rests — half the reward band, as the desk view used. */
const distOf = (m: Market) => (m.maxSpread ?? 2) / 2;

export default function RewardsUnified() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch('/api/rewards-unified', { cache: 'no-store' });
        const j = await r.json();
        if (!alive) return;
        setData(j); setErr(null);
      } catch (e: any) {
        if (alive) setErr(e?.message ?? 'fetch failed');
      }
    }
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const isPaid = data?.isPaid ?? false;

  // Rank by the primary metric so the strongest net $/day sits first. Rows the estimator
  // withheld (null net) sort last rather than being dropped — they are still real markets.
  const rows = useMemo(() => {
    const ms = data?.markets ?? [];
    return ms
      .map((m) => ({ m, est: estimateReward({ venue: m.venue, capital: CAPITAL_BASIS, twoSided: true, distanceCents: distOf(m), market: toSnapshot(m) }) }))
      .sort((a, b) => (b.est.netPerDay ?? -Infinity) - (a.est.netPerDay ?? -Infinity));
  }, [data]);

  return (
    <div className="rewards">
      <div className="cc-shell">

        <header className="cc-head">
          <h1 className="cc-title">
            <span className="cc-title-dim">Edgeradar /</span> liquidity rewards
            <span className="cc-title-accent"> · maker</span>
          </h1>
          <p className="cc-sub">
            quote both sides inside the reward band — earn the pool share, net of adverse selection
          </p>
        </header>

        {err && <EmptyState prefix="cc" title="Rewards feed unavailable" sub={err} />}
        {!err && !data && <EmptyState prefix="cc" sub="Loading reward markets…" />}
        {!err && data && rows.length === 0 && (
          <EmptyState prefix="cc" title="No reward markets clear the sanity gate right now" />
        )}

        {!err && data && rows.map(({ m, est }) => {
          const depth = m.bookDepthAtBand;
          const flags = (m.flags ?? []).filter(Boolean);
          const transient = flags.some((f) => /SHORT_BURST/i.test(f));

          return (
            <Card key={`${m.venue}-${m.marketId}`} prefix="cc">

              <ScoreboardHeader
                prefix="cc"
                left={
                  <span className="cc-ident">
                    {m.venue} <span className="cc-dot">·</span> liquidity reward
                  </span>
                }
                right={<span className="cc-dte">{m.category ?? '—'}</span>}
              />

              <h2 className="cc-match">{m.groupItemTitle || m.title}</h2>

              <div className="cc-legs">
                <div className="cc-leg is-spot">
                  <span className="cc-leg-label">pool / day</span>
                  <span className="cc-leg-price">
                    <Redacted value={m.dailyPool} isPaid={isPaid}>{(v) => <>{fmtUsd(Number(v))}</>}</Redacted>
                  </span>
                  <span className="cc-leg-tag">venue</span>
                </div>

                <div className="cc-leg is-future">
                  <span className="cc-leg-label">your share</span>
                  <span className="cc-leg-price">
                    <Redacted value={m.qualifyingLiquidity} isPaid={isPaid}>{(v) => <>{fmtUsd(Number(v))}</>}</Redacted>
                  </span>
                  <span className="cc-leg-tag">qualifying</span>
                </div>

                <MetricValue
                  prefix="cc"
                  value={
                    <Redacted value={est.netPerDay} isPaid={isPaid}>
                      {(v) => <>${Number(v).toFixed(2)}</>}
                    </Redacted>
                  }
                  caption={<>net · per day / ${CAPITAL_BASIS.toLocaleString()}</>}
                />
              </div>

              <div className="cc-figs">
                <span>
                  APR{' '}
                  <Redacted value={est.annualizedPct} isPaid={isPaid}>
                    {(v) => <strong>{Number(v).toFixed(1)}%</strong>}
                  </Redacted>
                </span>
                <span>
                  capacity{' '}
                  <Redacted value={depth} isPaid={isPaid}>
                    {(v) => <strong>{fmtUsd(Number(v))}</strong>}
                  </Redacted>
                  <span className="cc-dim"> · book depth at band</span>
                </span>
              </div>

              <div className="cc-foot">
                <Chip prefix="cc">rewards</Chip>
                <Chip prefix="cc">{m.venue}</Chip>
                {est.annualizedLabel && <Chip prefix="cc">{est.annualizedLabel}</Chip>}
                {transient && <Chip prefix="cc" amber>transient — may not persist</Chip>}
                {flags.filter((f) => !/SHORT_BURST/i.test(f)).map((f) => (
                  <Chip key={f} prefix="cc" amber>{f}</Chip>
                ))}
              </div>
            </Card>
          );
        })}

        {data && (
          <p className="cc-note">
            Net is after estimated adverse selection, at ${CAPITAL_BASIS.toLocaleString()} deployed.
            A reward pool can be re-weighted or end at any time — these are not promised yields.
          </p>
        )}
      </div>
    </div>
  );
}
