'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Redacted } from './ui/Redacted';
import { Card, ScoreboardHeader, LegBox, ProgressBar, MetricValue, Chip, RiskFreeChip, EmptyState } from './ds';

/**
 * Cash & Carry (basis) tab.
 *
 * Buy spot, short the dated future, hold to expiry, capture the basis.
 *
 * HONEST-ENGINE, on the face of the card:
 *  - PRIMARY metric is net $/day at a stated $1,000 basis. Annualized is demoted to the
 *    data row, capped and labelled "run-rate, not guaranteed" — because at the measured
 *    ceiling of ~4.1%/yr, leading with the percentage dresses up $0.11/day as something
 *    it is not.
 *  - Annualized below the 4%/yr risk-free reference renders AMBER with a "< risk-free"
 *    chip. 35 of 37 live rows are below it. The tab says so instead of letting a green
 *    number imply edge that a T-bill would beat.
 *  - Prices shown are the EXECUTABLE legs (spot ask / future bid), never mid.
 *  - Capacity is real order-book depth with its binding leg named; unknown depth is "—".
 *  - This is a SIGNAL surface. There is no auto-fire here and no order path: execution is
 *    the user's call, and holding to expiry is a multi-month commitment.
 */

interface BasisCard {
  id: string;
  asset: string | null;
  venue: string | null;
  contract: string | null;
  expiryDate: string | null;
  daysToExpiry: number | null;
  tenorDays: number | null;
  elapsedDays: number | null;
  convergenceFraction: number | null;
  spotAsk: number | null;
  futureBid: number | null;
  executableBasisPct: number | null;
  annualizedPct: number | null;
  annualizedCapped: boolean | null;
  annualizedLabel: string | null;
  belowRiskFree: boolean | null;
  riskFreePct: number;
  netUsdPerDay: number | null;
  capitalBasisUsd: number;
  capacityUsd: number | null;
  bindingLeg: string | null;
  direction: string | null;
  coinMargined: boolean;
}

interface CarryMeta {
  riskFreePct: number;
  capitalBasisUsd: number;
  bestApyPct: number | null;
  bestBeatsRiskFree: boolean | null;
  convergenceObserved: boolean;
  convergenceNote: string;
}

interface Payload {
  agentStatus: string;
  updatedAt: string | null;
  basisCards: BasisCard[];
  carryMeta: CarryMeta;
  isPaid?: boolean;
}

const fmtUsd = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M`
  : n >= 1_000   ? `$${(n / 1_000).toFixed(0)}k`
  : `$${n.toFixed(0)}`;

const fmtPrice = (n: number) =>
  n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
            : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function CashCarryBasis() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch('/api/carry', { cache: 'no-store' });
        const j = await r.json();
        if (!alive) return;
        setData(j);
        setErr(null);
      } catch (e: any) {
        if (alive) setErr(e?.message ?? 'fetch failed');
      }
    }
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const meta = data?.carryMeta;
  const isPaid = data?.isPaid ?? false;
  const cards = data?.basisCards ?? [];
  const riskFree = meta?.riskFreePct ?? 4.0;

  return (
    <div className="cashcarry">
      <div className="cc-shell">

        {/* ── header ─────────────────────────────────────────────── */}
        <header className="cc-head">
          <h1 className="cc-title">
            <span className="cc-title-dim">Edgeradar /</span> cash &amp; carry
            <span className="cc-title-accent"> · basis</span>
          </h1>
          <p className="cc-sub">
            buy spot, short the dated future, hold to expiry — capture the basis
          </p>
        </header>

        {/* ── signal banner (NOT auto-fire) ──────────────────────── */}
        <div className="cc-signal">
          <span className="cc-signal-txt">
            <span className="cc-diamond" aria-hidden>◆</span> carry signal · hold-to-expiry · execution is your call
          </span>
          {meta && (
            <span className={`cc-ceiling ${meta.bestBeatsRiskFree === false ? 'is-amber' : ''}`}>
              ceiling{' '}
              <Redacted value={meta.bestApyPct} isPaid={isPaid}>
                {(v) => <>{Number(v).toFixed(2)}%/yr</>}
              </Redacted>
              {meta.bestBeatsRiskFree === false ? ` < risk-free ${riskFree}%` : ` vs risk-free ${riskFree}%`}
            </span>
          )}
        </div>

        {/* ── persistent honest note ─────────────────────────────── */}
        {meta && !meta.convergenceObserved && (
          <p className="cc-note">{meta.convergenceNote}</p>
        )}

        {/* ── body ───────────────────────────────────────────────── */}
        {err && (
          <EmptyState prefix="cc" title="Basis feed unavailable" sub={err} />
        )}

        {!err && !data && (
          <EmptyState prefix="cc" sub="Loading basis book…" />
        )}

        {!err && data && cards.length === 0 && (
          <EmptyState
            prefix="cc"
            title="No basis rows right now"
            sub="The carry scanner found nothing that clears fees."
          />
        )}

        {!err && data && cards.map((c) => {
          const frac = c.convergenceFraction ?? 0;
          const pct = Math.max(0, Math.min(100, frac * 100));
          const nearExpiry = c.daysToExpiry != null && c.daysToExpiry <= 10;
          const maturing = pct >= 50;
          const backward = (c.direction ?? '').toLowerCase().includes('backward');

          return (
            <Link key={c.id} href={`/dashboard/carry/${encodeURIComponent(c.id.replace('|', '-'))}`} className="cc-card-link">
            <Card prefix="cc">

              <ScoreboardHeader
                prefix="cc"
                left={
                  <span className="cc-ident">
                    {c.asset ?? '—'} <span className="cc-dot">·</span> {c.venue ?? '—'}{' '}
                    <span className="cc-dot">·</span> exp {c.expiryDate ?? '—'}
                  </span>
                }
                right={
                  <span className={`cc-dte ${nearExpiry ? 'is-near' : ''}`}>
                    {c.daysToExpiry == null ? '—' : `${c.daysToExpiry}d to settle`}
                  </span>
                }
              />

              <div className="cc-legs">
                <LegBox
                  prefix="cc"
                  accent="spot"
                  slots={[
                    { cls: 'label', text: 'BUY spot' },
                    { cls: 'price', text: c.spotAsk == null ? '—' : fmtPrice(c.spotAsk) },
                    { cls: 'tag',   text: 'ask' },
                  ]}
                />

                <LegBox
                  prefix="cc"
                  accent="future"
                  slots={[
                    { cls: 'label', text: 'SHORT fut' },
                    { cls: 'price', text: c.futureBid == null ? '—' : fmtPrice(c.futureBid) },
                    { cls: 'tag',   text: 'bid' },
                  ]}
                />

                <MetricValue
                  prefix="cc"
                  value={
                    <Redacted value={c.netUsdPerDay} isPaid={isPaid}>
                      {(v) => <>${Number(v).toFixed(2)}</>}
                    </Redacted>
                  }
                  caption={<>net · per day / ${c.capitalBasisUsd.toLocaleString()}</>}
                />
              </div>

              <ProgressBar prefix="cc" pct={pct} mode="fill" active={maturing} />
              <p className="cc-bar-cap">
                {c.tenorDays == null
                  ? 'converges at expiry · elapsed unknown (contract not in recorded history)'
                  : `converges at expiry · ${c.elapsedDays}/${c.tenorDays}d elapsed since first observed`}
              </p>

              <div className="cc-figs">
                <span>
                  executable basis{' '}
                  <Redacted value={c.executableBasisPct} isPaid={isPaid}>
                    {(v) => <strong>{Number(v) >= 0 ? '+' : ''}{Number(v).toFixed(2)}%</strong>}
                  </Redacted>
                </span>
                <span>
                  annualized{' '}
                  <Redacted value={c.annualizedPct} isPaid={isPaid}>
                    {(v) => (
                      <strong className={c.belowRiskFree ? 'cc-amber' : ''}>
                        {Number(v).toFixed(2)}%/yr
                      </strong>
                    )}
                  </Redacted>
                </span>
                <span>
                  capacity{' '}
                  <Redacted value={c.capacityUsd} isPaid={isPaid}>
                    {(v) => <strong>{fmtUsd(Number(v))}</strong>}
                  </Redacted>
                  {c.bindingLeg && <span className="cc-dim"> · {c.bindingLeg} binds</span>}
                </span>
              </div>

              <div className="cc-foot">
                <Chip prefix="cc">hold to expiry</Chip>
                <Chip prefix="cc">{backward ? 'backwardation' : 'contango'}</Chip>
                <Chip prefix="cc">{c.annualizedLabel ?? 'run-rate, not guaranteed'}</Chip>
                {c.belowRiskFree && <RiskFreeChip prefix="cc" riskFreePct={riskFree} />}
                {c.coinMargined && <Chip prefix="cc">coin-settled · USD return not locked</Chip>}
              </div>
            </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
