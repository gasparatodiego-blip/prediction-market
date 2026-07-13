'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { ChevronRight, Lock } from 'lucide-react';
import EdgeChip from '@/app/components/ui/EdgeChip';
import { Redacted } from '@/app/components/ui/Redacted';
import type {
  SnapshotResponse,
  ScannedEvent,
  SharpReference,
  EdgeVsSharp,
} from '@/app/api/sports-snapshot/route';

// ─────────────────────────────────────────────────────────────────────────────
// Sports — SIGNAL intelligence. Pinnacle (the only sharp book on our roster) is
// the reference: its de-vigged "no-vig fair" line is the anchor, and soft-book
// prices are measured against it. Every number here is SIGNAL, never cashable —
// no leg is click-guaranteed. Matches the /dashboard/paper design language.
//
// HONEST-ENGINE (client): free tier → edge/odds are null server-side →
// <Redacted> lock, never a blur over a real value. suppressed_outlier shown
// MUTED with reason (never hidden). no_sharp_reference shown with its label.
// Unknown = "—", never fabricated. Zero sharp edges = a calm, valid state.
// Logos: lettermark placeholders + league emoji — the site has no real brand
// SVGs for sportsbooks, so nothing is invented.
// ─────────────────────────────────────────────────────────────────────────────

// ── format helpers (null → "—", never fabricated) ───────────────────────────
const fmtEdge = (n: number | null | undefined): string =>
  n == null || !isFinite(n) ? '—' : `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}%`;
const fmtOdd = (n: number | null | undefined): string =>
  n == null || !isFinite(n) ? '—' : n.toFixed(2);
const fmtProb = (n: number | null | undefined): string =>
  n == null || !isFinite(n) ? '—' : `${(n * 100).toFixed(1)}%`;
const fmtAge = (mins: number | null | undefined): string => {
  if (mins == null || !isFinite(mins)) return '—';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.round(mins)}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};
const fmtWhen = (iso: string | null | undefined): string =>
  !iso ? '—' : new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function leagueEmoji(sport: string): string {
  if (sport.startsWith('soccer'))           return '⚽';
  if (sport.startsWith('basketball'))       return '🏀';
  if (sport.startsWith('americanfootball')) return '🏈';
  if (sport.startsWith('icehockey'))        return '🏒';
  if (sport.startsWith('baseball'))         return '⚾';
  if (sport.startsWith('tennis'))           return '🎾';
  return '🏆';
}

// ── lettermark placeholder (no real brand SVGs on the site — honest stand-in) ─
const MARK_TONES = [
  'bg-violet-tint text-violet', 'bg-mint-tint text-mint-deep',
  'bg-gold-tint text-gold', 'bg-coral-tint text-coral-ink',
];
function Lettermark({ name }: { name: string }) {
  const initials = (name || '?').replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const tone = MARK_TONES[h % MARK_TONES.length];
  return (
    <span className={`inline-flex items-center justify-center w-5 h-5 rounded-md font-body font-bold text-[9px] shrink-0 ${tone}`} aria-hidden title={name}>
      {initials}
    </span>
  );
}

// ── small status tag (design-system tones, mirrors paper's PaperTag) ─────────
function Tag({ text, tone }: { text: string; tone: 'mint' | 'violet' | 'coral' | 'gold' | 'muted' }) {
  const cls = {
    mint: 'bg-mint-tint text-mint-deep', violet: 'bg-violet-tint text-violet',
    coral: 'bg-coral-tint text-coral-ink', gold: 'bg-gold-tint text-gold',
    muted: 'bg-line/60 text-muted',
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-[3px] rounded-md font-body font-semibold text-[9.5px] tracking-wide uppercase ${cls}`}>
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-current opacity-70" aria-hidden />{text}
    </span>
  );
}

// ── labelled stat (paper style) ──────────────────────────────────────────────
function Stat({ label, children, demoted }: { label: string; children: React.ReactNode; demoted?: string }) {
  return (
    <div className="rounded-lg bg-bg-soft/60 px-3 py-2.5">
      <p className="font-body text-[10px] uppercase tracking-wide text-muted mb-1">{label}</p>
      <p className="font-body text-[13px] text-ink font-medium tabular-nums leading-tight">{children}</p>
      {demoted && <p className="font-body text-[10px] text-muted mt-0.5 leading-snug">{demoted}</p>}
    </div>
  );
}

// ── edge status → label/tone (honest; never cashable) ────────────────────────
type EdgeView = { status: string; tone: 'violet' | 'muted'; label: string; hasNumber: boolean };
function edgeView(e: EdgeVsSharp | undefined): EdgeView {
  const st = e?.status;
  if (st === 'signal')                return { status: st, tone: 'violet', label: 'signal edge', hasNumber: true };
  if (st === 'none')                  return { status: st, tone: 'muted', label: 'no edge vs fair', hasNumber: false };
  if (st === 'suppressed_outlier')    return { status: st, tone: 'muted', label: 'suppressed · outlier', hasNumber: false };
  if (st === 'no_comparable_outcome') return { status: st, tone: 'muted', label: 'no comparable line', hasNumber: false };
  return { status: 'no_sharp_reference', tone: 'muted', label: 'no sharp reference', hasNumber: false };
}

const findLeg = <T extends { outcome: string }>(arr: T[] | null | undefined, outcome: string): T | undefined =>
  (arr ?? []).find(l => l.outcome === outcome);

// ══════════════════════════════════════════════════════════════════════════════
// Expanded event detail — per-outcome sharp table + honest caveat
// ══════════════════════════════════════════════════════════════════════════════
function EventDetail({ ev, isPaid }: { ev: ScannedEvent; isPaid: boolean }) {
  const sr: SharpReference | null | undefined = ev.sharpReference;
  const e = ev.edgeVsSharp;
  const view = edgeView(e);
  const outcomes = ev.bestLegs.map(l => l.outcome);
  const dash = <span className="text-muted">—</span>;

  return (
    <div className="px-4 pb-4 pt-1 border-t border-line/70 bg-bg-soft/30">
      {/* status line */}
      <div className="flex items-center gap-2 my-3 flex-wrap">
        <EdgeChip variant="signal" />
        <Tag text={view.label} tone={view.tone} />
        {ev.settlement?.crossSettlementRisk && <Tag text="settlement risk" tone="coral" />}
      </div>

      {sr?.present ? (
        <>
          {/* per-outcome sharp table */}
          <p className="font-body text-[10px] uppercase tracking-widest text-muted mb-2">
            Pinnacle sharp anchor · de-vigged fair line vs best book
          </p>
          <div className="rounded-lg overflow-hidden border border-line/70">
            {/* header */}
            <div className="grid grid-cols-[1.3fr_1fr_1fr_1.4fr] gap-1 px-2.5 py-1.5 bg-bg-soft/70 font-body text-[9px] uppercase tracking-wide text-muted">
              <span>Outcome</span>
              <span className="text-right">Pinnacle ◆</span>
              <span className="text-right">No-vig fair</span>
              <span className="text-right">Best book</span>
            </div>
            {outcomes.map((oc) => {
              const pin  = findLeg(sr.raw, oc);
              const nv   = findLeg(sr.noVig, oc);
              const best = findLeg(ev.bestLegs, oc);
              const isEdgeRow = e?.status === 'signal' && e.outcome === oc;
              return (
                <div key={oc} className={`grid grid-cols-[1.3fr_1fr_1fr_1.4fr] gap-1 px-2.5 py-2 items-center border-t border-line/50 ${isEdgeRow ? 'bg-violet-tint/30' : ''}`}>
                  <span className="font-body text-[11px] text-ink truncate flex items-center gap-1">
                    {oc}
                    {isEdgeRow && (
                      <span className="font-semibold text-violet text-[10px] tabular-nums">
                        <Redacted value={e?.edgePct} isPaid={isPaid}>{v => fmtEdge(v as number)}</Redacted>
                      </span>
                    )}
                  </span>
                  {/* Pinnacle = sharp anchor, highlighted */}
                  <span className="text-right font-body text-[11px] tabular-nums text-violet font-semibold">
                    <Redacted value={pin?.odd} isPaid={isPaid}>{v => fmtOdd(v as number)}</Redacted>
                  </span>
                  <span className="text-right font-body text-[11px] tabular-nums text-ink-2">
                    <Redacted value={nv?.fairOdds} isPaid={isPaid}>{v => fmtOdd(v as number)}</Redacted>
                    {nv?.fairProb != null && isPaid && <span className="text-muted"> · {fmtProb(nv.fairProb)}</span>}
                  </span>
                  <span className="text-right font-body text-[11px] tabular-nums text-ink flex items-center justify-end gap-1.5 min-w-0">
                    {best ? (
                      <>
                        <Lettermark name={best.bookmaker} />
                        <Redacted value={best.odd} isPaid={isPaid}>{v => <b className="font-semibold">{fmtOdd(v as number)}</b>}</Redacted>
                      </>
                    ) : dash}
                  </span>
                </div>
              );
            })}
          </div>

          {/* sharp meta + best-edge detail */}
          <div className="grid grid-cols-2 gap-2 mt-3">
            <Stat label="Sharp book" demoted="only verified/sharp reference">Pinnacle</Stat>
            <Stat label="Pinnacle vig" demoted="overround stripped for fair line">
              <Redacted value={sr.marginPct} isPaid={isPaid}>{v => `${(v as number).toFixed(2)}%`}</Redacted>
            </Stat>
            {view.status === 'signal' && (
              <>
                <Stat label="Best edge vs fair" demoted={`${e?.softBook ?? '—'} · ${e?.outcome ?? '—'}`}>
                  <span className="text-violet font-semibold"><Redacted value={e?.edgePct} isPaid={isPaid}>{v => fmtEdge(v as number)}</Redacted></span>
                </Stat>
                <Stat label="That book" demoted={e?.softClass === 'exchange' ? 'exchange · Signal' : 'soft book · Signal'}>
                  {e?.softBook ?? dash}
                </Stat>
              </>
            )}
            <Stat label="Book max / limit" demoted="not tracked by source">—</Stat>
            <Stat label="Books quoting">{ev.booksCount}</Stat>
          </div>
        </>
      ) : (
        <div className="rounded-lg bg-bg-soft/60 px-3 py-3">
          <p className="font-body text-[12px] text-ink-2 leading-snug">
            <b>No sharp reference.</b> Pinnacle didn't quote every outcome for this event, so there's no de-vigged fair line to anchor an edge. Soft-book prices are shown as reference only — no signal is derived.
          </p>
        </div>
      )}

      {view.status === 'suppressed_outlier' && (
        <div className="rounded-lg bg-coral-tint/40 px-3 py-2.5 mt-3">
          <p className="font-body text-[11px] text-coral-ink leading-snug">
            Suppressed — a soft book deviated implausibly from Pinnacle's fair line (&gt;10%). Treated as a stale/erroneous quote, not real value.
            {isPaid && e?.reason ? <span className="text-muted"> · {e.reason}</span> : <span className="text-muted"> · magnitude hidden</span>}
          </p>
        </div>
      )}

      {/* settlement + mandatory caveat */}
      {ev.settlement?.basis && (
        <p className="font-body text-[10.5px] text-muted mt-3 leading-snug"><b className="text-ink-2">Settlement:</b> {ev.settlement.basis}</p>
      )}
      <p className="font-body text-[10.5px] text-muted mt-2 leading-snug">
        <b className="text-violet">Signal only — indicative, not click-guaranteed.</b> No leg here is cashable; sportsbooks limit winners and lines move in seconds. Pinnacle is the sharp anchor; every other book is Signal.
      </p>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Event row
// ══════════════════════════════════════════════════════════════════════════════
function EventRow({ ev, isPaid, open, onToggle }: { ev: ScannedEvent; isPaid: boolean; open: boolean; onToggle: () => void }) {
  const view = edgeView(ev.edgeVsSharp);
  const muted = view.status !== 'signal';
  return (
    <div className={`rounded-card bg-surface shadow-card overflow-hidden ${muted ? 'opacity-[0.92]' : ''}`}>
      <button onClick={onToggle} className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-bg-soft/40 transition-colors">
        <span className="text-[15px] shrink-0" aria-hidden>{leagueEmoji(ev.sport)}</span>
        <span className="flex-1 min-w-0">
          <span className="font-display font-semibold text-ink text-[14px] truncate block">{ev.eventName}</span>
          <span className="font-body text-[11px] text-muted">{ev.sportLabel} · {fmtWhen(ev.commenceTime)}</span>
        </span>
        <span className="text-right shrink-0">
          {view.hasNumber ? (
            <span className="block font-body text-[15px] font-semibold tabular-nums text-violet">
              <Redacted value={ev.edgeVsSharp?.edgePct} isPaid={isPaid}>{v => fmtEdge(v as number)}</Redacted>
            </span>
          ) : (
            <span className="block font-body text-[11px] text-muted">{view.label}</span>
          )}
          <span className="block font-body text-[9.5px] text-muted uppercase tracking-wide">
            {view.status === 'signal' ? 'vs sharp fair' : ev.sharpReference?.present ? 'sharp quoted' : 'no sharp ref'}
          </span>
        </span>
        <ChevronRight className={`w-4 h-4 text-muted shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && <EventDetail ev={ev} isPaid={isPaid} />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Page
// ══════════════════════════════════════════════════════════════════════════════
export default function SportsPage() {
  const [data, setData] = useState<SnapshotResponse | null>(null);
  const [err, setErr]   = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/sports-snapshot', { cache: 'no-store' });
      const j: SnapshotResponse = await r.json();
      setData(j); setErr(null);
    } catch (e: any) { setErr(e?.message || 'failed to load'); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 5 * 60_000); return () => clearInterval(t); }, [load]);

  const isPaid = data?.isPaid ?? false;

  // Sort: signal edges first (by edge desc when visible), then sharp-quoted,
  // then no-sharp / suppressed. Within a tier, soonest kick-off first.
  const events = useMemo(() => {
    const evs = [...(data?.scannedEvents ?? [])];
    const rank = (ev: ScannedEvent) => {
      const st = ev.edgeVsSharp?.status;
      if (st === 'signal') return 0;
      if (st === 'suppressed_outlier') return 3;
      if (ev.sharpReference?.present) return 1;
      return 2; // no_sharp_reference
    };
    return evs.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      const ea = a.edgeVsSharp?.edgePct, eb = b.edgeVsSharp?.edgePct;
      if (ea != null && eb != null && ea !== eb) return eb - ea;
      return new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime();
    });
  }, [data]);

  const counts = useMemo(() => {
    const c = { signal: 0, sharp: 0, noSharp: 0, suppressed: 0 };
    for (const ev of data?.scannedEvents ?? []) {
      const st = ev.edgeVsSharp?.status;
      if (st === 'signal') c.signal++;
      if (st === 'suppressed_outlier') c.suppressed++;
      if (ev.sharpReference?.present) c.sharp++; else c.noSharp++;
    }
    return c;
  }, [data]);

  // Top surfaced edge (paid sees the number; free sees a locked hero).
  const topSignal = useMemo(() => events.find(e => e.edgeVsSharp?.status === 'signal'), [events]);

  return (
    <main className="max-w-[470px] mx-auto px-4 pb-24 pt-5 font-body">
      {/* header */}
      <div className="flex items-center justify-between mb-1">
        <h1 className="font-display font-bold text-ink text-[22px] tracking-tight">Edgeradar · Sports</h1>
        <EdgeChip variant="signal" />
      </div>
      <p className="font-body text-[12px] text-muted mb-5">
        Signal intelligence · <span className="text-violet font-medium">indicative, not click-guaranteed</span>
        {data && <> · {data.stale ? 'stale' : `updated ${fmtAge(data.ageMinutes)}`}</>}
      </p>

      {err && (
        <div className="rounded-card bg-surface shadow-card px-5 py-6 text-center">
          <p className="font-body text-[13px] text-ink-2">{err}</p>
        </div>
      )}

      {data && (data.missing || (data.scannedEvents?.length ?? 0) === 0) && !err && (
        <div className="rounded-card bg-surface shadow-card px-5 py-8 text-center">
          <p className="font-body text-[14px] text-ink font-medium">No events scanned right now</p>
          <p className="font-body text-[11px] text-muted mt-1.5 leading-snug">The snapshot scanner runs once daily (06:00 UTC, credit-budgeted). A calm, valid state — nothing to act on.</p>
        </div>
      )}

      {data && !data.missing && (data.scannedEvents?.length ?? 0) > 0 && (
        <>
          {/* hero — top sharp edge or calm state */}
          <div className="rounded-card bg-surface shadow-card px-5 py-5 mb-3">
            <p className="font-body text-[11px] uppercase tracking-wide text-muted mb-2">Top edge vs Pinnacle sharp fair</p>
            {topSignal ? (
              <>
                <div className="flex items-baseline gap-2.5">
                  <span className="font-display font-bold leading-none tracking-tight tabular-nums text-violet" style={{ fontSize: 40 }}>
                    <Redacted value={topSignal.edgeVsSharp?.edgePct} isPaid={isPaid}>{v => fmtEdge(v as number)}</Redacted>
                  </span>
                </div>
                <p className="font-body text-[12px] text-ink-2 mt-2.5 leading-snug">
                  {topSignal.eventName} · {topSignal.edgeVsSharp?.outcome} @ {topSignal.edgeVsSharp?.softBook} · <span className="text-muted">Signal, not cashable</span>
                </p>
              </>
            ) : (
              <>
                <span className="font-display font-bold leading-none tracking-tight text-ink-2" style={{ fontSize: 30 }}>No sharp edge right now</span>
                <p className="font-body text-[12px] text-ink-2 mt-2.5 leading-snug">A calm, valid state — soft books are at or inside Pinnacle's fair line. Nothing to signal.</p>
              </>
            )}
            {/* summary strip */}
            <div className="grid grid-cols-4 gap-2 mt-4">
              <Stat label="Events">{data.summary?.totalEvents ?? data.scannedEvents.length}</Stat>
              <Stat label="Signal">{counts.signal}</Stat>
              <Stat label="Sharp ref">{counts.sharp}</Stat>
              <Stat label="No sharp">{counts.noSharp}</Stat>
            </div>
          </div>

          {/* event list */}
          <div className="space-y-2">
            {events.map(ev => {
              const key = `${ev.sport}:${ev.eventName}:${ev.commenceTime}`;
              return (
                <EventRow key={key} ev={ev} isPaid={isPaid}
                  open={expanded === key} onToggle={() => setExpanded(expanded === key ? null : key)} />
              );
            })}
          </div>

          {/* footer honesty */}
          <p className="font-body text-[10px] text-muted mt-5 leading-snug text-center">
            Pinnacle = sharp anchor (de-vigged fair line) · every other book = Signal, never cashable · suppressed outliers shown, never hidden · unknown = "—", never fabricated · zero edges is a calm state.
            {!isPaid && <> Edge &amp; odds are null on the free tier — <a href="/dashboard/upgrade" className="text-violet">upgrade →</a></>}
          </p>
          {!isPaid && (
            <p className="font-body text-[10px] text-muted mt-2 leading-snug text-center inline-flex items-center gap-1 justify-center w-full">
              <Lock className="w-2.5 h-2.5" strokeWidth={2.5} /> Locked numbers are null server-side — real values are never sent, never blurred over.
            </p>
          )}
        </>
      )}
    </main>
  );
}
