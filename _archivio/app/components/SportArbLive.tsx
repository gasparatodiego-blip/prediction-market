'use client';

import { useEffect, useRef, useState } from 'react';
import { Redacted } from './ui/Redacted';
import { Card, ScoreboardHeader, LegBox, ProgressBar, MetricValue, Chip, ArmToggle, EmptyState } from './ds';

/**
 * Live sport arbitrage tab.
 *
 * Renders ONLY crossings the server verified as live-vs-live (both legs fresher than
 * 90s). Phantoms — a live leg paired against a stale one — are counted in the header as
 * "stale traps blocked" and are never rendered as an opportunity, because that pairing
 * is exactly how a frozen book price masquerades as free money.
 *
 * AUTO-FIRE is a LOCAL VISUAL STATE ONLY. It is wired to nothing: no account is linked,
 * no order is ever placed. It exists to show what an armed state would look like.
 */

interface Leg {
  side: string;
  venue: string;
  price: number | null;
  type: 'exch' | 'pred';
  ageSec: number | null;
}

interface Crossing {
  id: string;
  match: string;
  league: string;
  clock: string | null;
  legA: Leg;
  legB: Leg;
  netPct: number | null;
  netProfitEur: number | null;
  maxStakeEur: number | null;
  bindingLeg: string | null;
  sizeUnverifiable: boolean;
  windowSecs: number | null;
  jurisdictionTag: string;
  jurisdictionOpenableBoth: boolean | null;
  executable: boolean;
}

interface Payload {
  updatedAt: string;
  source: string;
  sourceNote: string | null;
  liveGames: number;
  crossings: Crossing[];
  counts: { liveGames: number; crossings: number; phantomsBlocked: number };
  maxAgeSec: number;
  disclaimer: string;
  isPaid: boolean;
}

const REFRESH_MS = 4000;

export default function SportArbLive() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  // Remaining verified-live seconds per crossing, decayed locally between refetches.
  const [remaining, setRemaining] = useState<Record<string, number>>({});
  const initialRef = useRef<Record<string, number>>({});

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch('/api/sport-arb/live', { cache: 'no-store' });
        const j = await r.json();
        if (!alive) return;
        setData(j);
        setErr(null);
        const next: Record<string, number> = {};
        for (const c of j.crossings ?? []) {
          if (c.windowSecs == null) continue;
          next[c.id] = c.windowSecs;
          // Remember the largest window seen for this crossing so the bar drains from a
          // stable denominator instead of snapping to 100% on every refetch.
          initialRef.current[c.id] = Math.max(initialRef.current[c.id] ?? 0, c.windowSecs);
        }
        setRemaining(next);
      } catch (e: any) {
        if (alive) setErr(e?.message ?? 'fetch failed');
      }
    }
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Local 1s decay so the bar moves smoothly between 4s refetches.
  useEffect(() => {
    const t = setInterval(() => {
      setRemaining((prev) => {
        const next: Record<string, number> = {};
        for (const k of Object.keys(prev)) next[k] = Math.max(0, prev[k] - 1);
        return next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const counts = data?.counts ?? { liveGames: 0, crossings: 0, phantomsBlocked: 0 };
  const isPaid = data?.isPaid ?? false;

  return (
    <div className="sportarb">
      <div className="sportarb-shell">

        {/* ── header ─────────────────────────────────────────────── */}
        <header className="sa-head">
          <div className="sa-head-row">
            <h1 className="sa-title">
              <span className="sa-title-dim">Edgeradar /</span> sport arbitrage
              <span className="sa-title-live"> · live</span>
            </h1>

            <ArmToggle
              prefix="sa"
              armed={armed}
              onToggle={() => setArmed((a) => !a)}
              onLabel="AUTO-FIRE ARMED"
              offLabel="AUTO-FIRE OFF"
              title="connect account to enable real fills"
            />
          </div>

          <p className="sa-scanline">
            scanning {counts.liveGames} live game{counts.liveGames === 1 ? '' : 's'}
            <span className="sa-sep"> · </span>
            {counts.crossings} crossing{counts.crossings === 1 ? '' : 's'}
            <span className="sa-sep"> · </span>
            {counts.phantomsBlocked} stale trap{counts.phantomsBlocked === 1 ? '' : 's'} blocked
          </p>
        </header>

        {/* ── body ───────────────────────────────────────────────── */}
        {err && (
          <EmptyState prefix="sa" title="Live feed unavailable" sub={err} />
        )}

        {!err && data && counts.crossings === 0 && (
          <EmptyState
            prefix="sa"
            title={<>No live crossing right now — scanning {counts.liveGames} live game{counts.liveGames === 1 ? '' : 's'}.</>}
            sub="Stale-leg traps are filtered out."
          />
        )}

        {!err && !data && (
          <EmptyState prefix="sa" sub="Loading live book…" />
        )}

        {!err && data && data.crossings.map((c) => {
          const init = initialRef.current[c.id] ?? c.windowSecs ?? 0;
          const left = remaining[c.id] ?? c.windowSecs ?? 0;
          const pct = init > 0 ? Math.max(0, Math.min(100, (left / init) * 100)) : 0;
          const dying = pct < 35;
          const urgent = left < 12;

          return (
            <Card key={c.id} prefix="sa">

              <ScoreboardHeader
                prefix="sa"
                left={
                  <div className="sa-card-head-l">
                    <span className="sa-pulse" aria-hidden />
                    <span className="sa-league">{c.league}</span>
                    <span className="sa-clock">{c.clock ?? '—'}</span>
                  </div>
                }
                right={
                  <span className={`sa-window ${urgent ? 'is-urgent' : ''}`}>
                    {c.windowSecs == null ? '—' : `${left}s window`}
                  </span>
                }
              />

              <h2 className="sa-match">{c.match}</h2>

              <div className="sa-legs">
                {[c.legA, c.legB].map((leg, i) => (
                  <LegBox
                    key={i}
                    prefix="sa"
                    accent={leg.type === 'exch' ? 'exch' : 'pred'}
                    slots={[
                      { cls: 'venue', text: leg.venue },
                      { cls: 'side',  text: leg.side },
                      { cls: 'price', text: leg.price == null ? '—' : leg.price },
                    ]}
                  />
                ))}

                <MetricValue
                  prefix="sa"
                  value={
                    <Redacted value={c.netPct} isPaid={isPaid}>
                      {(v) => <>+{Number(v).toFixed(2)}%</>}
                    </Redacted>
                  }
                  caption="net · post-fee"
                />
              </div>

              <ProgressBar prefix="sa" pct={pct} mode="drain" active={dying} />

              <div className="sa-figs">
                <span>
                  max stake{' '}
                  <Redacted value={c.maxStakeEur} isPaid={isPaid}>
                    {(v) => <strong>€{Number(v).toLocaleString()}</strong>}
                  </Redacted>
                  {c.bindingLeg && <span className="sa-dim"> · {c.bindingLeg} binds</span>}
                </span>
                <span>
                  net profit ≈{' '}
                  <Redacted value={c.netProfitEur} isPaid={isPaid}>
                    {(v) => <strong className="sa-green">€{Number(v).toLocaleString()}</strong>}
                  </Redacted>
                </span>
              </div>

              <div className="sa-foot">
                <Chip prefix="sa">{c.jurisdictionTag}</Chip>
                <Chip prefix="sa">{c.executable ? 'executable bid/ask' : 'size unverifiable'}</Chip>
                <span className={`sa-fire ${armed ? (dying ? 'is-firing' : 'is-armed') : ''}`}>
                  {armed ? (dying ? '⚡ FIRING' : 'auto-fill armed') : 'arm to fill'}
                </span>
              </div>
            </Card>
          );
        })}

        {data?.sourceNote && (
          <p className="sa-note">{data.sourceNote}</p>
        )}
        {data && (
          <p className="sa-note sa-note-dim">{data.disclaimer}</p>
        )}
      </div>
    </div>
  );
}
