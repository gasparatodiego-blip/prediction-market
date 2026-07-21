'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Redacted } from './ui/Redacted';
import { CardSection, LegBox, ArmToggle, EmptyState } from './ds';

/**
 * Cash & carry position calculator — "if I enter now, exactly how much do I net?"
 *
 * SCALES, NEVER RE-DERIVES. Every rate on this screen (executable basis %, each fee leg %,
 * capacity, risk-free %) arrives from /api/carry/[id], which reads the same shared carry
 * math the tab and agent19 use. This component multiplies those percentages by the user's
 * capital and divides by days. It computes no basis, invents no fee, and hardcodes no price.
 *
 * HONEST-ENGINE
 *  - Basis is the EXECUTABLE figure (from real bid/ask), never mid.
 *  - Capital is hard-clamped to the row's real order-book capacity. You cannot model a
 *    size the book cannot fill.
 *  - Fees are itemised per leg and flagged as a base-tier estimate: no venue in the
 *    official table publishes dated-futures taker fees without auth, so these are
 *    unverified against the user's actual tier and the screen says so.
 *  - The screen shows ONLY the carry's own result (net after fees, net $/day, annualized
 *    run-rate). The risk-free comparison was removed by owner product decision — the
 *    annualized figure renders in neutral colour and is not judged against a T-bill here.
 *  - AUTO-EXECUTE is an armed VISUAL state only. There is no order path, no account
 *    linking, and no credential is read anywhere in this file.
 */

const EXECUTION_ENABLED = false;   // never flip without the separate security project

interface FeeLeg { label: string | null; pct: number | null }
interface FeeModel {
  legs: FeeLeg[] | null;
  totalPct: number | null;
  verified: boolean;
  isAssumption: boolean;
  source: string;
  note: string;
}
interface Card {
  id: string;
  asset: string | null;
  venue: string | null;
  contract: string | null;
  expiryDate: string | null;
  daysToExpiry: number | null;
  spotAsk: number | null;
  futureBid: number | null;
  executableBasisPct: number | null;
  annualizedPct: number | null;
  annualizedLabel: string | null;
  belowRiskFree: boolean | null;
  riskFreePct: number;
  capacityUsd: number | null;
  bindingLeg: string | null;
  direction: string | null;
  coinMargined: boolean;
  feeModel: FeeModel | null;
}
interface Payload { card: Card; isPaid: boolean; updatedAt: string | null; error?: string }

const PRESETS = [1_000, 10_000, 50_000, 250_000];
const DEFAULT_CAPITAL = 10_000;

const money = (n: number, dp = 2) =>
  n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const compact = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `$${(n / 1_000).toFixed(0)}k` : `$${n.toFixed(0)}`;

// `embedded` renders the same calculator inline inside a list row instead of as a full
// page: it drops the back link and the full-viewport wrapper. The math, fetch, fees and
// armed-only auto-execute state are IDENTICAL — nothing about the numbers changes with
// the flag.
export default function CarryPositionCalculator({ id, embedded = false }: { id: string; embedded?: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [capital, setCapital] = useState(DEFAULT_CAPITAL);
  const [armed, setArmed] = useState(false);
  const [autoRoll, setAutoRoll] = useState(false);
  const [feeOpen, setFeeOpen] = useState(false);   // fee breakdown collapsed by default

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch(`/api/carry/${encodeURIComponent(id)}`, { cache: 'no-store' });
        const j = await r.json();
        if (!alive) return;
        if (!r.ok) { setErr(j?.error ?? `HTTP ${r.status}`); return; }
        setData(j); setErr(null);
      } catch (e: any) {
        if (alive) setErr(e?.message ?? 'fetch failed');
      }
    }
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [id]);

  const card = data?.card ?? null;
  const isPaid = data?.isPaid ?? false;
  const capacity = card?.capacityUsd ?? null;
  const days = card?.daysToExpiry ?? null;
  const riskFree = card?.riskFreePct ?? 4;

  // Hard clamp: you cannot model a size the book cannot fill.
  const cappedCapital = capacity != null ? Math.min(capital, capacity) : capital;

  const calc = useMemo(() => {
    const basisPct = card?.executableBasisPct ?? null;
    const legs = card?.feeModel?.legs ?? null;
    if (basisPct == null || days == null || days <= 0) return null;

    const gross = (cappedCapital * basisPct) / 100;
    const feeRows = (legs ?? []).map((l) => ({
      label: l.label ?? '—',
      pct: l.pct,
      usd: l.pct == null ? null : (cappedCapital * l.pct) / 100,
    }));
    // A leg whose rate is unknown is EXCLUDED from the total and shown as "—" — never
    // treated as zero, which would silently overstate net.
    const known = feeRows.filter((f) => f.usd != null);
    const anyUnknown = feeRows.some((f) => f.usd == null);
    const totalFees = known.reduce((a, f) => a + (f.usd ?? 0), 0);
    const net = gross - totalFees;
    const netPerDay = net / days;
    const netApy = cappedCapital > 0 ? (net / cappedCapital) * (365 / days) * 100 : 0;
    const riskFreeGain = (cappedCapital * riskFree * days) / (100 * 365);
    const diff = net - riskFreeGain;

    return { gross, feeRows, totalFees, anyUnknown, net, netPerDay, netApy, riskFreeGain, diff };
  }, [card, cappedCapital, days, riskFree]);

  if (err) {
    return (
      <div className={`carrydetail${embedded ? ' is-embedded' : ''}`}>
        <div className="cd-shell">
          {!embedded && <Link href="/dashboard/carry" className="cd-back">‹ back to basis</Link>}
          <EmptyState prefix="cd" title="Position unavailable" sub={err} />
        </div>
      </div>
    );
  }

  return (
    <div className={`carrydetail${embedded ? ' is-embedded' : ''}`}>
      <div className="cd-shell">

        {!embedded && <Link href="/dashboard/carry" className="cd-back">‹ back to basis</Link>}

        {!card && <EmptyState prefix="cd" sub="Loading position…" />}

        {card && (
          <>
            {/* 1. position header */}
            <header className="cd-head">
              <h1 className="cd-title">{card.asset ?? '—'} <span className="cd-dot">·</span> {card.venue ?? '—'}</h1>
              <p className="cd-meta">
                <span className="cd-expchip">
                  <span className="cd-expchip-days">{days ?? '—'}d</span>
                  <span className="cd-expchip-label">to expiry</span>
                </span>
                <span className="cd-exp-date">exp {card.expiryDate ?? '—'}</span>
                <span className="cd-dot">·</span>
                <span className="cd-exp-dir">{card.direction ?? '—'}</span>
              </p>
            </header>

            {/* 2. legs — buy spot / short future, side by side */}
            <div className="cd-legs">
              <LegBox
                prefix="cd"
                accent="spot"
                slots={[
                  { cls: 'label', text: 'BUY spot' },
                  { cls: 'price', text: card.spotAsk == null ? '—' : money(card.spotAsk, 2) },
                  { cls: 'tag',   text: 'ask' },
                ]}
              />
              <LegBox
                prefix="cd"
                accent="future"
                slots={[
                  { cls: 'label', text: 'SHORT fut' },
                  { cls: 'price', text: card.futureBid == null ? '—' : money(card.futureBid, 2) },
                  { cls: 'tag',   text: 'bid' },
                ]}
              />
            </div>

            {/* 3. capital input */}
            <CardSection prefix="cd">
              <div className="cd-cap-row">
                <label className="cd-label" htmlFor="cd-capital">How much do you want to deploy?</label>
                <span className="cd-cap-max">
                  max {capacity == null ? '—' : compact(capacity)}
                  {card.bindingLeg ? ` · ${card.bindingLeg}` : ''} · book depth
                </span>
              </div>
              <input
                id="cd-capital"
                type="number"
                className="cd-input"
                value={cappedCapital}
                min={0}
                max={capacity ?? undefined}
                step={1000}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isFinite(v) || v < 0) { setCapital(0); return; }
                  setCapital(capacity != null ? Math.min(v, capacity) : v);
                }}
              />
              <input
                type="range"
                className="cd-range"
                min={0}
                max={capacity ?? 250_000}
                step={1000}
                value={cappedCapital}
                onChange={(e) => setCapital(Number(e.target.value))}
                aria-label="capital"
              />
              <div className="cd-presets">
                {PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`cd-preset ${cappedCapital === p ? 'is-on' : ''}`}
                    onClick={() => setCapital(capacity != null ? Math.min(p, capacity) : p)}
                  >
                    {p >= 1000 ? `$${p / 1000}k` : `$${p}`}
                  </button>
                ))}
              </div>
            </CardSection>

            {/* 4. THE ANSWER — dominant, alone in its own green card */}
            <CardSection prefix="cd" className="is-answer">
              <span className="cd-answer-label">IF YOU ENTER NOW, HELD TO EXPIRY</span>
              <div className="cd-answer-row">
                <span className="cd-answer-net">
                  <Redacted value={calc?.net} isPaid={isPaid}>{(v) => <>+${money(Number(v))}</>}</Redacted>
                </span>
                <span className="cd-answer-side">
                  <span className="cd-answer-sub">
                    <Redacted value={calc?.netPerDay} isPaid={isPaid}>{(v) => <>${money(Number(v))}</>}</Redacted> / day
                  </span>
                  <span className="cd-answer-sub">
                    <Redacted value={calc?.netApy} isPaid={isPaid}>{(v) => <>{Number(v).toFixed(2)}%/yr</>}</Redacted>
                  </span>
                </span>
              </div>
              <span className="cd-answer-cap">
                on ${money(cappedCapital, 0)} · net of all fees · {card.annualizedLabel ?? 'run-rate, not guaranteed'}
              </span>
            </CardSection>

            {/* 6. fee breakdown — collapsed accordion, fees in $ */}
            <CardSection prefix="cd">
              <button
                type="button"
                className="cd-acc-head"
                onClick={() => setFeeOpen((o) => !o)}
                aria-expanded={feeOpen}
              >
                <span className="cd-acc-title">
                  Fee breakdown · total{' '}
                  <Redacted value={calc?.totalFees} isPaid={isPaid}>{(v) => <>${money(Number(v))}</>}</Redacted>
                </span>
                <span className="cd-acc-caret" aria-hidden>{feeOpen ? '▾' : '▸'}</span>
              </button>

              {feeOpen && (
                <div className="cd-acc-body">
                  <div className="cd-brk-row">
                    <span>gross basis{card.executableBasisPct != null ? ` (+${card.executableBasisPct.toFixed(2)}%)` : ''}</span>
                    <strong className="cd-green">
                      <Redacted value={calc?.gross} isPaid={isPaid}>{(v) => <>+${money(Number(v))}</>}</Redacted>
                    </strong>
                  </div>

                  {(calc?.feeRows ?? []).filter((f) => f.usd !== 0).map((f, i) => (
                    <div className="cd-brk-row is-fee" key={i}>
                      <span>{f.label}{f.pct != null ? ` (${f.pct.toFixed(3)}%)` : ' (—)'}</span>
                      <strong className="cd-danger">
                        {f.usd == null ? '—' : <>−${money(f.usd)}</>}
                      </strong>
                    </div>
                  ))}
                  {!calc?.feeRows?.length && (
                    <div className="cd-brk-row is-fee">
                      <span>fees</span>
                      <strong className="cd-danger">
                        <Redacted value={null} isPaid={isPaid}>{() => <>—</>}</Redacted>
                      </strong>
                    </div>
                  )}

                  <div className="cd-brk-row is-total">
                    <span>total fees{card.feeModel?.totalPct != null ? ` (${card.feeModel.totalPct.toFixed(3)}%)` : ''}</span>
                    <strong className="cd-danger">
                      <Redacted value={calc?.totalFees} isPaid={isPaid}>{(v) => <>−${money(Number(v))}</>}</Redacted>
                    </strong>
                  </div>

                  {calc?.anyUnknown && (
                    <p className="cd-warn">one or more legs has no published rate — excluded from net, shown as “—”</p>
                  )}
                  {card.feeModel?.isAssumption && (
                    <p className="cd-warn">{card.feeModel.note}</p>
                  )}
                </div>
              )}
            </CardSection>

            {/* 7. auto-execute — armed visual state only */}
            <CardSection prefix="cd">
              <ArmToggle
                prefix="cd"
                armed={armed}
                onToggle={() => setArmed((a) => !a)}
                onLabel="AUTO-EXECUTE ARMED"
                offLabel="AUTO-EXECUTE OFF"
              />
              <p className="cd-caveat cd-dim">connect an account to enable — execution stays your call</p>

              {armed && (
                <div className="cd-arm-body">
                  <button
                    type="button"
                    className={`cd-roll ${autoRoll ? 'is-on' : ''}`}
                    onClick={() => setAutoRoll((r) => !r)}
                    aria-pressed={autoRoll}
                  >
                    auto-roll at expiry: {autoRoll ? 'ON' : 'OFF'}
                  </button>

                  <p className="cd-caveat">
                    Capital is locked for {days ?? '—'} days until settlement and the basis is
                    thin — size against the book depth above, not the slider maximum.
                  </p>

                  <button type="button" className="cd-connect" disabled={!EXECUTION_ENABLED}>
                    connect account to enable fills
                  </button>
                  <p className="cd-caveat cd-dim">
                    no account is linked and no order is placed — this is a signal surface
                  </p>
                </div>
              )}
            </CardSection>
          </>
        )}
      </div>
    </div>
  );
}
