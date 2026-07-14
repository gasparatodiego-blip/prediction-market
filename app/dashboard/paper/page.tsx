'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { ChevronRight, X, Lock } from 'lucide-react';
import EdgeChip from '@/app/components/ui/EdgeChip';
import InfoDot from '@/app/components/ui/InfoDot';
import { Redacted } from '@/app/components/ui/Redacted';

// ─────────────────────────────────────────────────────────────────────────────
// Unified Paper-Book — one honest view across every simulated strategy.
// L1 unified · L2 strategy expand (inline) · L3 full position detail (modal).
//
// HONEST-ENGINE (client side): unknown = "—" (never zero-filled), THIN shown
// separately & labelled, unrealized ≠ realized, annualized capped, non-paid →
// derived-edge is null server-side → <Redacted> lock/"—" (never a blur over a
// real value). Zero/negative shown calmly, never as an error.
// ─────────────────────────────────────────────────────────────────────────────

// ── types (loose — the API is the source of truth) ──────────────────────────
interface Mark { asOf: string; netUsd?: number | null; unrealizedUsd?: number | null; cumFundingUsd?: number | null; currentBasisPct?: number | null; liveRoi?: number | null; note?: string | null; [k: string]: unknown }
interface ExitInfo { asOf?: string | null; reason?: string | null; markPx?: number | null; trailingNetPerDay?: number | null; [k: string]: unknown }
interface Position {
  id: string; category: string; label: string; status: string; metricKind: string;
  thin: boolean; value: number | null;
  exit: ExitInfo | null; realizedUsd: number | null;
  entry: Record<string, any> | null; lastMark: Record<string, any> | null; marks: Mark[];
  contractKey: string | null; fundingCursorT: number | null; cumFundingUsd: number | null;
}
interface Strategy {
  key: string; label: string; metric: string | null; chip: string;
  open: number; matured: number; closed: number; execOpen: number; execNotionalUsd: number | null;
  execPnlUsd: number | null; thinOpen: number; thinPnlUsd: number | null;
  realizedPnlUsd: number | null; positions: Position[];
}
interface PaperBook {
  ok: boolean; simulated: boolean; isPaid: boolean;
  meta: { entryAsOf: string | null; updatedAt: string | null; simDays: number | null; dayIndex: number; notionalUsd: number | null };
  headline: { executablePnlUsd: number | null; executablePnlHas: boolean; thinPnlUsd: number | null; thinOpen: number; ticketCount: number; ticketSizeUsd: number | null; totalNotionalUsd: number | null; openTicketCountAll: number; openNotionalUsdAll: number | null; closedRealizedUsd: number | null; closedCount: number; maturedCount: number };
  equityCurve: { asOf: string; netUsd: number | null }[];
  strategies: Strategy[];
  copy: { sleeveCount: number; openLegs: number; pnlUsd: number | null; sleeves: any[] };
  liquidity: any;
  signalOnly: { label: string; venues: string[]; note: string };
  excluded: { category: string; reason: string; value: string }[];
  annualizedCapNote: string;
}

// ── format helpers (honest: null → "—", never fabricated) ────────────────────
const fmtUsd = (n: number | null | undefined, dp = 2): string =>
  n == null || !isFinite(n) ? '—' : `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(dp)}`;
const fmtUsdPlain = (n: number | null | undefined, dp = 2): string =>
  n == null || !isFinite(n) ? '—' : `$${n.toFixed(dp)}`;
const fmtK = (n: number | null | undefined): string => {
  if (n == null || !isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
};
const fmtPct = (n: number | null | undefined, dp = 2): string =>
  n == null || !isFinite(n) ? '—' : `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(dp)}%`;
// annualized cap — never show >200%/yr as a guarantee (honest-engine).
const fmtAnn = (pctYr: number | null | undefined): { text: string; capped: boolean } => {
  if (pctYr == null || !isFinite(pctYr)) return { text: '—', capped: false };
  if (pctYr > 200) return { text: '>200%/yr', capped: true };
  return { text: `${pctYr >= 0 ? '+' : '−'}${Math.abs(pctYr).toFixed(2)}%/yr`, capped: false };
};
const fmtAge = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};
const fmtWhen = (iso: string | null | undefined): string =>
  !iso ? '—' : new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const pnlColor = (n: number | null | undefined): string =>
  n == null ? 'text-muted' : n > 0 ? 'text-mint-deep' : n < 0 ? 'text-coral-ink' : 'text-ink-2';

// ── design-system chip (extends EdgeChip labels the page needs) ──────────────
function PaperTag({ text, tone }: { text: string; tone: 'mint' | 'violet' | 'coral' | 'gold' }) {
  const cls = {
    mint: 'bg-mint-tint text-mint-deep', violet: 'bg-violet-tint text-violet',
    coral: 'bg-coral-tint text-coral-ink', gold: 'bg-gold-tint text-gold',
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-[3px] rounded-md font-body font-semibold text-[9.5px] tracking-wide uppercase ${cls}`}>
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-current opacity-70" aria-hidden />{text}
    </span>
  );
}
function StrategyChip({ s }: { s: Strategy }) {
  if (s.key === 'copy') return <EdgeChip variant="copy_trader" />;
  if (s.thinOpen > 0 && s.execOpen > 0) return <PaperTag text="Mixed" tone="gold" />;
  if (s.thinOpen > 0 && s.execOpen === 0) return <PaperTag text="Not exec. at size" tone="coral" />;
  return <EdgeChip variant="cashable" />;
}

// ── stored-marks area chart (NO interpolation — stepwise real points only) ───
function StoredArea({ points, locked, height = 56 }: { points: { x: number; y: number | null }[]; locked: boolean; height?: number }) {
  const vals = points.filter(p => p.y != null) as { x: number; y: number }[];
  if (locked) {
    return (
      <div className="rounded-lg bg-line/40 flex items-center justify-center gap-1.5 text-muted text-[11px]" style={{ height }}>
        <Lock className="w-3 h-3" strokeWidth={2.5} /> equity curve on Pro
      </div>
    );
  }
  if (vals.length < 2) {
    return <div className="rounded-lg bg-line/30 flex items-center justify-center text-muted text-[11px]" style={{ height }}>not enough stored marks yet — "—"</div>;
  }
  const w = 320, pad = 4;
  const xs = vals.map(p => p.x), ys = vals.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(0, ...ys), maxY = Math.max(0, ...ys);
  const sx = (x: number) => pad + ((x - minX) / (maxX - minX || 1)) * (w - 2 * pad);
  const sy = (y: number) => pad + (1 - (y - minY) / (maxY - minY || 1)) * (height - 2 * pad);
  // stepwise (no interpolation): hold each value until the next stored mark.
  let d = `M ${sx(vals[0].x)} ${sy(vals[0].y)}`;
  for (let i = 1; i < vals.length; i++) { d += ` L ${sx(vals[i].x)} ${sy(vals[i - 1].y)} L ${sx(vals[i].x)} ${sy(vals[i].y)}`; }
  const last = vals[vals.length - 1].y;
  const stroke = last >= 0 ? '#0A9D6B' : '#D5552F';
  const fill = last >= 0 ? 'rgba(15,190,130,.12)' : 'rgba(255,122,89,.12)';
  const area = `${d} L ${sx(vals[vals.length - 1].x)} ${sy(minY)} L ${sx(vals[0].x)} ${sy(minY)} Z`;
  const zeroY = sy(0);
  return (
    <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} preserveAspectRatio="none" aria-label="stored-marks equity curve">
      <line x1={0} y1={zeroY} x2={w} y2={zeroY} stroke="#E3ECE7" strokeWidth={1} strokeDasharray="3 3" />
      <path d={area} fill={fill} stroke="none" />
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.75} strokeLinejoin="round" />
      {vals.map((p, i) => <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={1.6} fill={stroke} />)}
    </svg>
  );
}

// ── small labelled stat ──────────────────────────────────────────────────────
function Stat({ label, children, demoted }: { label: React.ReactNode; children: React.ReactNode; demoted?: string }) {
  return (
    <div className="rounded-lg bg-bg-soft/60 px-3 py-2.5">
      <p className="font-body text-[10px] uppercase tracking-wide text-muted mb-1">{label}</p>
      <p className="font-body text-[13px] text-ink font-medium tabular-nums leading-tight">{children}</p>
      {demoted && <p className="font-body text-[10px] text-muted mt-0.5 leading-snug">{demoted}</p>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// L3 — full position detail (modal)
// ══════════════════════════════════════════════════════════════════════════════
function PositionModal({ pos, isPaid, onClose }: { pos: Position; isPaid: boolean; onClose: () => void }) {
  const [showRaw, setShowRaw] = useState(false);
  const e = pos.entry || {};
  const lm = pos.lastMark || {};
  const x = pos.exit || {};
  const legs: any[] = Array.isArray(e.legs) ? e.legs : [];
  const open = pos.status === 'open';
  const dash = <span className="text-muted">—</span>;

  // mark-over-time series (stored marks only, no interpolation)
  const markPts = pos.marks.map(m => ({
    x: new Date(m.asOf).getTime(),
    y: (m.netUsd ?? m.unrealizedUsd ?? null) as number | null,
  }));
  const marksLocked = !isPaid; // values are server-nulled for free tier

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="mb-4">
      <p className="font-body text-[10px] uppercase tracking-widest text-muted mb-2">{title}</p>
      <div className="grid grid-cols-2 gap-2">{children}</div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-ink/40 backdrop-blur-sm p-0 sm:p-4" onClick={onClose}>
      <div className="bg-surface w-full sm:max-w-[470px] sm:rounded-card rounded-t-card shadow-card max-h-[92vh] overflow-y-auto" onClick={ev => ev.stopPropagation()}>
        {/* header */}
        <div className="sticky top-0 bg-surface/95 backdrop-blur px-5 py-4 border-b border-line flex items-start justify-between gap-3 z-10">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              {pos.thin ? <PaperTag text="Not exec. at size" tone="coral" /> : <EdgeChip variant="cashable" />}
              <span className="font-body text-[10px] uppercase tracking-wide text-muted">{pos.status}</span>
            </div>
            <p className="font-display font-bold text-ink text-[15px] leading-tight truncate">{pos.label}</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink shrink-0 -mr-1"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-4">
          {/* headline value */}
          <div className="rounded-card bg-bg-soft/60 px-4 py-3 mb-4">
            <p className="font-body text-[10px] uppercase tracking-wide text-muted mb-1">Paper P&L (this position)</p>
            <p className={`font-display font-bold text-[26px] leading-none tabular-nums ${pnlColor(pos.value)}`}>
              <Redacted value={pos.value} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted>
            </p>
            {pos.thin && <p className="font-body text-[11px] text-coral-ink mt-1.5">THIN — excluded from the headline, shown on its own.</p>}
          </div>

          {/* Pair & venues */}
          <Section title="Pair & venues">
            <Stat label="Coin / pair">{e.coin || e.asset || pos.label?.split(' ')[0] || dash}</Stat>
            <Stat label="Metric">{pos.metricKind || dash}</Stat>
            {legs.map((lg, i) => (
              <Stat key={i} label={lg.side || `leg ${i + 1}`}>
                {lg.venue || dash}
                {lg.price != null && <span className="text-muted"> · {fmtUsdPlain(lg.price, 2)}</span>}
                {lg.settledRate != null && <span className="text-muted"> · settled {(lg.settledRate * 100).toFixed(4)}%</span>}
              </Stat>
            ))}
          </Section>

          {/* Sizing & capacity */}
          <Section title="Sizing & capacity">
            <Stat label="Ticket notional">{e.notionalUsd != null ? fmtUsdPlain(e.notionalUsd, 0) : dash}</Stat>
            <Stat label="Sized down from">{e.sizedDownFrom != null ? fmtUsdPlain(e.sizedDownFrom, 0) : dash}</Stat>
            <Stat label={<>Capacity (real book) <InfoDot term="capacity" size={11} /></>}>{e.capacityUsd != null ? fmtK(e.capacityUsd) : dash}</Stat>
            <Stat label="Capacity source">{e.capacitySource || dash}</Stat>
          </Section>

          {/* Entry */}
          <Section title="Entry">
            <Stat label="Entered">{fmtWhen(e.asOf)}</Stat>
            <Stat label="Verdict">{e.verdict || dash}</Stat>
            <Stat label={<>Est net/day @ entry <InfoDot term="net_per_day" size={11} /></>}>
              <Redacted value={e.estNetPerDayAtEntry} isPaid={isPaid}>{v => fmtUsd(v as number, 4)}</Redacted>
            </Stat>
            <Stat label="Fees (one-time)">
              <Redacted value={e.feesUsd} isPaid={isPaid}>{v => fmtUsdPlain(v as number, 2)}</Redacted>
            </Stat>
            {e.entryBasisPct != null || pos.category === 'basis' ? (
              <Stat label="Entry basis" demoted="one-time unlock at expiry, not per-day">
                <Redacted value={e.entryBasisPct} isPaid={isPaid}>{v => `${((v as number) * 100).toFixed(3)}%`}</Redacted>
              </Stat>
            ) : null}
            {e.netAnnualizedAtEntry != null && (
              <Stat label={<>Net annualized @ entry <InfoDot term="run_rate" size={11} /></>} demoted="run-rate, not guaranteed">
                <Redacted value={e.netAnnualizedAtEntry} isPaid={isPaid}>{v => fmtAnn(v as number).text}</Redacted>
              </Stat>
            )}
            {e.liveRoiAtEntry != null && (
              <Stat label="Live ROI @ entry"><Redacted value={e.liveRoiAtEntry} isPaid={isPaid}>{v => fmtPct(v as number, 2)}</Redacted></Stat>
            )}
          </Section>

          {/* Live now */}
          <Section title="Live · now">
            <Stat label="Last mark">{fmtWhen(lm.asOf)}{lm.asOf && <span className="text-muted"> · {fmtAge(lm.asOf)}</span>}</Stat>
            <Stat label="Funding pts added">{lm.realFundingPointsAdded ?? dash}</Stat>
            <Stat label="Cum. funding"><Redacted value={pos.cumFundingUsd} isPaid={isPaid}>{v => fmtUsdPlain(v as number, 2)}</Redacted></Stat>
            <Stat label="Current basis"><Redacted value={lm.currentBasisPct} isPaid={isPaid}>{v => `${((v as number) * 100).toFixed(3)}%`}</Redacted></Stat>
          </Section>

          {/* P&L split — unrealized ≠ realized */}
          <Section title="P&L split (unrealized ≠ realized)">
            <Stat label={<>Unrealized <InfoDot term="unrealized" size={11} /></>} demoted="marked at real live/settled data">
              <Redacted value={lm.unrealizedUsd ?? (lm.netUsd != null ? lm.netUsd : null)} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted>
            </Stat>
            <Stat label={<>Realized <InfoDot term="realized" size={11} /></>} demoted={open ? 'nothing realized while open' : 'frozen at close'}>
              {open ? dash : <Redacted value={pos.realizedUsd} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted>}
            </Stat>
          </Section>

          {/* Exit / close — real stored close data once closed, "—" while open */}
          <Section title="Exit · close">
            <Stat label="Exit mark">{open ? dash : <Redacted value={x.markPx} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted>}</Stat>
            <Stat label="Closed at">{open ? dash : fmtWhen(x.asOf)}</Stat>
            <Stat label="Close reason">{open ? dash : (x.reason || dash)}</Stat>
            <Stat label="Unlock / expiry">{e.expiry || e.unlockDate || dash}</Stat>
          </Section>

          {/* Flags & integrity */}
          <Section title="Flags & integrity">
            <Stat label="Executable">{pos.thin ? 'THIN — not at size' : 'yes, at size'}</Stat>
            <Stat label="Status">{pos.status}</Stat>
            <Stat label="Mark note">{lm.note || (lm.error ? `error: ${lm.error}` : 'ok')}</Stat>
            <Stat label="Marks stored">{pos.marks.length}</Stat>
          </Section>

          {/* mark-over-time chart */}
          <div className="mb-4">
            <p className="font-body text-[10px] uppercase tracking-widest text-muted mb-2">Mark over time <span className="normal-case tracking-normal">· stored marks, no interpolation</span></p>
            <StoredArea points={markPts} locked={marksLocked} height={64} />
          </div>

          {/* raw stored fields */}
          <button onClick={() => setShowRaw(s => !s)} className="font-body text-[11px] text-violet hover:underline mb-2">
            {showRaw ? 'Hide' : 'Show'} raw stored fields (JSON)
          </button>
          {showRaw && (
            <pre className="text-[10px] leading-snug bg-ink/[.04] rounded-lg p-3 overflow-x-auto text-ink-2 max-h-64">
              {JSON.stringify(pos, null, 2)}
            </pre>
          )}
          {!isPaid && <p className="font-body text-[10px] text-muted mt-2">Locked figures are null server-side on the free tier — real numbers are never sent, never blurred over. <a href="/dashboard/upgrade" className="text-violet">Upgrade →</a></p>}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// L2 — strategy expand (inline)
// ══════════════════════════════════════════════════════════════════════════════
function honestNote(s: Strategy): string {
  if (s.key === 'cross-venue-funding' && s.thinOpen > 0) return `${s.thinOpen} THIN "not executable at size" tickets are excluded from the headline and shown on their own line.`;
  if (s.key === 'basis') return 'Basis is a one-time unlock captured as it converges at expiry — not a per-day yield. Marked at real executable book.';
  if (s.key === 'prediction-arb') return s.execOpen === 0 ? '0 cashable prediction arbs expected right now — a calm, valid state (no mid-price venues counted).' : 'Cashable only; realizes at the real market resolution.';
  if (s.key === 'copy') return 'Mirror sleeve — mirrors only real observed fills forward at their real fill prices. No backfill.';
  return 'Marked from real settled/live data only. Unmarked legs render "—", never zero-filled.';
}

function StrategyBlock({ s, isPaid, onOpenPos }: { s: Strategy; isPaid: boolean; onOpenPos: (p: Position) => void }) {
  const openPositions = s.positions.filter(p => p.status === 'open');
  return (
    <div className="px-4 pb-4 pt-1 border-t border-line/70 bg-bg-soft/30">
      <p className="font-body text-[12px] text-ink-2 mb-3 leading-snug">{honestNote(s)}</p>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <Stat label="Executable P&L" demoted={`${s.execOpen} tickets · ${fmtK(s.execNotionalUsd)}`}>
          <span className={pnlColor(s.execPnlUsd)}>
            <Redacted value={s.execPnlUsd} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted>
          </span>
        </Stat>
        <Stat label={<>THIN (excluded) <InfoDot term="thin" size={11} /></>} demoted={s.thinOpen ? `${s.thinOpen} not-exec-at-size` : 'none'}>
          {s.thinOpen ? (
            <span className={pnlColor(s.thinPnlUsd)}><Redacted value={s.thinPnlUsd} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted></span>
          ) : <span className="text-muted">—</span>}
        </Stat>
        <Stat label="Metric">{s.metric || '—'}</Stat>
        <Stat label="Open / matured">{s.open} / {s.matured}</Stat>
      </div>

      {s.key === 'basis' && (
        <div className="rounded-lg bg-violet-tint/60 px-3 py-2 mb-3">
          <p className="font-body text-[11px] text-violet leading-snug">
            <Lock className="w-3 h-3 inline mr-1 -mt-0.5" strokeWidth={2.5} />
            Basis pays a <b>one-time</b> unlock at expiry (not per-day). Net annualized is a run-rate, capped at &gt;200%/yr — never guaranteed.
          </p>
        </div>
      )}

      {openPositions.length > 0 && (
        <>
          <p className="font-body text-[10px] uppercase tracking-widest text-muted mb-2">Positions ({openPositions.length})</p>
          <div className="space-y-1.5">
            {openPositions.slice(0, 60).map(p => (
              <button key={p.id} onClick={() => onOpenPos(p)}
                className="w-full flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-left hover:bg-mint-tint/30 transition-colors">
                <span className="flex-1 min-w-0">
                  <span className="font-body text-[12px] text-ink truncate block">{p.label}</span>
                  <span className="font-body text-[10px] text-muted">{p.thin ? 'THIN · not exec at size' : 'executable'} · {p.marks.length} marks</span>
                </span>
                <span className={`font-body text-[12px] tabular-nums shrink-0 ${pnlColor(p.value)}`}>
                  <Redacted value={p.value} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted>
                </span>
                <ChevronRight className="w-4 h-4 text-muted shrink-0" />
              </button>
            ))}
            {openPositions.length > 60 && <p className="font-body text-[10px] text-muted px-1">+{openPositions.length - 60} more (capped for render)</p>}
          </div>
        </>
      )}
    </div>
  );
}

// ── Balance frame — honest account framing around the headline. The book is N
// INDEPENDENT $1,000 tickets, NOT one starting bankroll, so we never invent a
// single "starting balance": we state the notional scale, then net P&L split
// into realized (closed) + unrealized (open), then an account-value line whose
// arithmetic is shown in full. Realized and unrealized are NEVER merged.
// Notional + ticket counts are public; the $ P&L are server-gated (locked/"—"
// on free tier → account value can't be formed, shown locked, never fabricated).
function BalanceFrame({ h, isPaid }: { h: PaperBook['headline']; isPaid: boolean }) {
  const notional = h.totalNotionalUsd;
  const realized = h.closedRealizedUsd;       // closed book (gated → null on free)
  const unreal   = h.executablePnlUsd;         // open exec book (gated → null on free)
  // account value = notional + realized + unrealized — only formable when both P&L
  // legs are present (paid). Any null leg → null (locked), never a partial guess.
  const acct = (notional != null && realized != null && unreal != null)
    ? notional + realized + unreal : null;
  const acctPct = (acct != null && notional) ? ((acct - notional) / notional) * 100 : null;
  const Row = ({ label, children, sign }: { label: string; children: React.ReactNode; sign?: string }) => (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="font-body text-[11.5px] text-ink-2">{sign && <span className="text-muted mr-1">{sign}</span>}{label}</span>
      <span className="font-body text-[12px] tabular-nums">{children}</span>
    </div>
  );
  return (
    <div className="rounded-card bg-surface shadow-card px-5 py-4 mb-3">
      <p className="font-body text-[11px] uppercase tracking-wide text-muted mb-2">Account frame · paper</p>
      {/* notional scale — public */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-body text-[12px] text-ink-2">Total notional <span className="text-muted">(scale)</span></span>
        <span className="font-display font-semibold text-ink text-[18px] tabular-nums">{fmtK(notional)}</span>
      </div>
      <p className="font-body text-[10.5px] text-muted mt-0.5 leading-snug">
        ~{h.ticketCount} independent ${h.ticketSizeUsd?.toLocaleString()} tickets · <span className="text-muted">not one ${h.ticketSizeUsd?.toLocaleString()} book</span>
      </p>

      {/* net P&L split — realized (closed) SEPARATE from unrealized (open) */}
      <div className="mt-3 pt-3 border-t border-line/70">
        <Row label={`Realized · closed (${h.closedCount})`} sign="+">
          <span className={pnlColor(realized)}><Redacted value={realized} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted></span>
        </Row>
        <Row label={`Unrealized · open exec (${h.ticketCount})`} sign="+">
          <span className={pnlColor(unreal)}><Redacted value={unreal} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted></span>
        </Row>
        {h.thinOpen ? (
          <p className="font-body text-[10px] text-muted mt-0.5 leading-snug">
            THIN <Redacted value={h.thinPnlUsd} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted> ({h.thinOpen} not-exec-at-size) is shown separately — not in this line.
          </p>
        ) : null}
      </div>

      {/* account value = notional + realized + unrealized, arithmetic stated */}
      <div className="mt-3 pt-3 border-t border-line/70 flex items-baseline justify-between gap-3">
        <span className="font-body text-[12px] text-ink">Account value <span className="text-muted">= notional + realized + unrealized</span></span>
        <span className={`font-display font-semibold text-[18px] tabular-nums ${acct == null ? 'text-muted' : 'text-ink'}`}>
          <Redacted value={acct} isPaid={isPaid}>{v => fmtUsdPlain(v as number, 2)}</Redacted>
          {acctPct != null && isPaid && <span className={`ml-1.5 text-[12px] ${pnlColor(acctPct)}`}>{fmtPct(acctPct)}</span>}
        </span>
      </div>
      {isPaid && acct != null && notional != null && realized != null && unreal != null && (
        <p className="font-body text-[10px] text-muted mt-1 leading-snug tabular-nums">
          {fmtUsdPlain(notional, 0)} + ({fmtUsd(realized)}) + ({fmtUsd(unreal)}) = {fmtUsdPlain(acct, 2)}. Realized is booked from now-closed tickets; unrealized marks the {h.ticketCount} open exec tickets.
        </p>
      )}
    </div>
  );
}

// ── Closed / matured section — 229 closed positions exist in the store but were
// never surfaced. Real stored data only: realizedUsd frozen at close, exit reason,
// closedAt. REALIZED is its own labelled column — never merged with open unrealized.
// Counts + reason labels are public; $ figures are server-gated. Losses shown calmly.
const CLOSE_REASONS: { key: string; label: string }[] = [
  { key: 'carry<=fees', label: 'Carry ≤ fees' },
  { key: 'source_gone', label: 'Source gone' },
  { key: 'unlock',      label: 'Unlocked / expiry' },
  { key: 'resolved',    label: 'Resolved' },
];
function ClosedSection({ strategies, headline, isPaid, onOpenPos }: {
  strategies: Strategy[]; headline: PaperBook['headline']; isPaid: boolean; onOpenPos: (p: Position) => void;
}) {
  const closed = strategies.flatMap(s => s.positions.filter(p => p.status === 'closed' || p.status === 'matured'));
  if (closed.length === 0) return null;
  // reason counts — public (counts, not edge). Canonical four always shown (0 if
  // absent); any other reason that appears is appended so nothing is hidden.
  const counts = new Map<string, number>();
  for (const p of closed) { const r = String(p.exit?.reason ?? 'unknown'); counts.set(r, (counts.get(r) ?? 0) + 1); }
  const shown = new Set(CLOSE_REASONS.map(r => r.key));
  const extraReasons = Array.from(counts.keys()).filter(k => !shown.has(k)).map(k => ({ key: k, label: k }));
  const reasonRows = [...CLOSE_REASONS, ...extraReasons];
  const sorted = [...closed].sort((a, b) => Date.parse(b.exit?.asOf ?? '') - Date.parse(a.exit?.asOf ?? ''));
  const CAP = 40;

  return (
    <div className="rounded-card bg-surface shadow-card overflow-hidden">
      <div className="px-4 py-3.5 border-b border-line/70">
        <div className="flex items-center gap-3">
          <span className="flex-1 min-w-0">
            <span className="flex items-center gap-2 mb-1">
              <span className="font-display font-semibold text-ink text-[14px]">Closed / matured</span>
              <PaperTag text={`${headline.closedCount} closed`} tone="violet" />
            </span>
            <span className="font-body text-[11px] text-muted">Realized book · frozen at close · separate from open unrealized</span>
          </span>
          <span className="text-right shrink-0">
            <span className={`block font-body text-[15px] font-semibold tabular-nums ${pnlColor(headline.closedRealizedUsd)}`}>
              <Redacted value={headline.closedRealizedUsd} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted>
            </span>
            <span className="block font-body text-[10px] text-muted uppercase tracking-wide">realized</span>
          </span>
        </div>
        {/* reason breakdown — counts public */}
        <div className="grid grid-cols-2 gap-1.5 mt-3">
          {reasonRows.map(r => (
            <div key={r.key} className="flex items-baseline justify-between gap-2 rounded-lg bg-bg-soft/60 px-2.5 py-1.5">
              <span className="font-body text-[11px] text-ink-2 truncate">{r.label}</span>
              <span className="font-body text-[12px] tabular-nums text-ink font-semibold">{counts.get(r.key) ?? 0}</span>
            </div>
          ))}
        </div>
      </div>

      {/* closed rows — REALIZED labelled column, calm losses, entry → exit mark */}
      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <span className="font-body text-[10px] uppercase tracking-widest text-muted">Closed positions ({closed.length})</span>
          <span className="font-body text-[10px] text-muted uppercase tracking-wide">realized · reason · closed</span>
        </div>
        <div className="space-y-1.5">
          {sorted.slice(0, CAP).map(p => (
            <button key={p.id} onClick={() => onOpenPos(p)}
              className="w-full flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-left hover:bg-violet-tint/25 transition-colors border border-line/50">
              <span className="flex-1 min-w-0">
                <span className="font-body text-[12px] text-ink truncate block">{p.label}</span>
                <span className="font-body text-[10px] text-muted">
                  {p.exit?.reason ?? '—'} · closed {fmtWhen(p.exit?.asOf)}
                </span>
              </span>
              <span className="text-right shrink-0">
                <span className={`block font-body text-[12px] tabular-nums ${pnlColor(p.realizedUsd)}`}>
                  <Redacted value={p.realizedUsd} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted>
                </span>
                <span className="block font-body text-[9px] text-muted uppercase tracking-wide">realized</span>
              </span>
              <ChevronRight className="w-4 h-4 text-muted shrink-0" />
            </button>
          ))}
          {closed.length > CAP && (
            <p className="font-body text-[10px] text-muted px-1 pt-1">
              +{closed.length - CAP} more closed (showing latest {CAP} by close time) · full realized total ${' '}
              <Redacted value={headline.closedRealizedUsd} isPaid={isPaid}>{v => fmtUsd(v as number).replace('$', '')}</Redacted> above.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// L1 — unified page
// ══════════════════════════════════════════════════════════════════════════════
export default function PaperBookPage() {
  const [data, setData] = useState<PaperBook | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [modalPos, setModalPos] = useState<Position | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/paper-book', { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || 'paper book not initialized'); return; }
      setData(j); setErr(null);
    } catch (e: any) { setErr(e?.message || 'failed to load'); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  const isPaid = data?.isPaid ?? false;
  const h = data?.headline;
  const pnlPct = useMemo(() => {
    if (!h || h.executablePnlUsd == null || !h.totalNotionalUsd) return null;
    return (h.executablePnlUsd / h.totalNotionalUsd) * 100;
  }, [h]);
  const equityPts = useMemo(() => (data?.equityCurve ?? []).map(p => ({ x: new Date(p.asOf).getTime(), y: p.netUsd })), [data]);
  const equityLocked = !isPaid || (data?.equityCurve ?? []).every(p => p.netUsd == null);

  return (
    <main className="max-w-[470px] mx-auto px-4 pb-24 pt-5 font-body">
      {/* header */}
      <div className="flex items-center justify-between mb-1">
        <h1 className="font-display font-bold text-ink text-[22px] tracking-tight">Edgeradar · Paper book</h1>
        <PaperTag text="Simulated" tone="violet" />
      </div>
      <p className="font-body text-[12px] text-muted mb-5">
        {data ? `Day ${data.meta.dayIndex}/${data.meta.simDays ?? 7} · forward paper sim · marked from real data · updated ${fmtAge(data.meta.updatedAt)}` : 'Loading…'}
      </p>

      {err && (
        <div className="rounded-card bg-surface shadow-card px-5 py-6 text-center">
          <p className="font-body text-[13px] text-ink-2">{err}</p>
          <p className="font-body text-[11px] text-muted mt-1">The paper book freezes its first snapshot on the next agent32 cycle.</p>
        </div>
      )}

      {data && (
        <>
          {/* hero */}
          <div className="rounded-card bg-surface shadow-card px-5 py-5 mb-3">
            <p className="font-body text-[11px] uppercase tracking-wide text-muted mb-2">Total executable paper P&L</p>
            <div className="flex items-baseline gap-2.5">
              <span className={`font-display font-bold leading-none tracking-tight tabular-nums ${pnlColor(h?.executablePnlUsd)}`} style={{ fontSize: 40 }}>
                <Redacted value={h?.executablePnlUsd} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted>
              </span>
              {pnlPct != null && isPaid && (
                <span className={`font-body text-[14px] font-semibold ${pnlColor(pnlPct)}`}>{pnlPct >= 0 ? '▲' : '▼'} {Math.abs(pnlPct).toFixed(2)}%</span>
              )}
            </div>
            <p className="font-body text-[12px] text-ink-2 mt-2.5 leading-snug">
              on ~{fmtK(h?.totalNotionalUsd)} paper notional · ~{h?.ticketCount} independent ${h?.ticketSizeUsd?.toLocaleString()} tickets · <span className="text-muted">not one ${h?.ticketSizeUsd?.toLocaleString()} book</span>
            </p>
            {h?.thinOpen ? (
              <p className="font-body text-[11px] text-coral-ink mt-1.5">
                + <Redacted value={h?.thinPnlUsd} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted> on {h.thinOpen} THIN "not executable at size" tickets — excluded from headline, shown separately.
              </p>
            ) : null}

            {/* mini equity area */}
            <div className="mt-4">
              <div className="flex items-center justify-between mb-1.5">
                <span className="font-body text-[10px] uppercase tracking-wide text-muted">Equity · stored marks</span>
                <span className="font-body text-[9.5px] text-muted">no interpolation</span>
              </div>
              <StoredArea points={equityPts} locked={equityLocked} />
            </div>
          </div>

          {/* account frame — notional scale + net P&L split (realized ≠ unrealized) */}
          {h && <BalanceFrame h={h} isPaid={isPaid} />}

          {/* strategy rows */}
          <div className="space-y-2">
            {data.strategies.map(s => {
              const isOpen = expanded === s.key;
              return (
                <div key={s.key} className="rounded-card bg-surface shadow-card overflow-hidden">
                  <button onClick={() => setExpanded(isOpen ? null : s.key)} className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-bg-soft/40 transition-colors">
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-2 mb-1">
                        <span className="font-display font-semibold text-ink text-[14px] truncate">{s.label}</span>
                        <StrategyChip s={s} />
                      </span>
                      <span className="font-body text-[11px] text-muted">{s.metric || '—'} · {s.execOpen} open{s.thinOpen ? ` · ${s.thinOpen} THIN` : ''}</span>
                    </span>
                    <span className="text-right shrink-0">
                      <span className={`block font-body text-[15px] font-semibold tabular-nums ${pnlColor(s.execPnlUsd)}`}>
                        <Redacted value={s.execPnlUsd} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted>
                      </span>
                      <span className="block font-body text-[10px] text-muted">{fmtK(s.execNotionalUsd)}</span>
                    </span>
                    <ChevronRight className={`w-4 h-4 text-muted shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                  </button>
                  {isOpen && <StrategyBlock s={s} isPaid={isPaid} onOpenPos={setModalPos} />}
                </div>
              );
            })}

            {/* closed / matured — realized book, surfaced below the open strategies */}
            {h && <ClosedSection strategies={data.strategies} headline={h} isPaid={isPaid} onOpenPos={setModalPos} />}

            {/* copy mirror row */}
            {data.copy.sleeveCount > 0 && (
              <div className="rounded-card bg-surface shadow-card px-4 py-3.5 flex items-center gap-3">
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2 mb-1">
                    <span className="font-display font-semibold text-ink text-[14px]">Copy mirror</span>
                    <EdgeChip variant="copy_trader" />
                  </span>
                  <span className="font-body text-[11px] text-muted">{data.copy.sleeveCount} sleeve(s) · {data.copy.openLegs} open legs</span>
                </span>
                <span className="text-right shrink-0">
                  <span className={`block font-body text-[15px] font-semibold tabular-nums ${pnlColor(data.copy.pnlUsd)}`}>
                    <Redacted value={data.copy.pnlUsd} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted>
                  </span>
                  <span className="block font-body text-[10px] text-muted">realized + unrealized</span>
                </span>
              </div>
            )}

            {/* liquidity rewards — LIVE (not paper) */}
            {data.liquidity && (
              <div className="rounded-card bg-surface shadow-card px-4 py-3.5">
                <div className="flex items-center gap-3">
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-2 mb-1">
                      <span className="font-display font-semibold text-ink text-[14px]">{data.liquidity.label}</span>
                      <PaperTag text="Live" tone="mint" />
                      <EdgeChip variant="signal" />
                    </span>
                    <span className="font-body text-[11px] text-muted">{data.liquidity.platform} · {data.liquidity.estRunRate?.eligibleCount ?? 0} reward markets{data.liquidity.stale ? ' · stale' : ''}</span>
                  </span>
                  <span className="text-right shrink-0">
                    <span className="block font-body text-[13px] font-semibold text-muted">excluded from P&L</span>
                    <span className="block font-body text-[10px] text-muted">realized —</span>
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-3">
                  <Stat label="Realized / accrued" demoted="no orders placed">—</Stat>
                  <Stat label="Forward reward" demoted="not deterministic">—</Stat>
                  <Stat label={<>{data.liquidity.estRunRate?.label || 'est net/day per $1k'} <InfoDot term="run_rate" size={11} /></>} demoted="run-rate, not guaranteed">
                    <Redacted value={data.liquidity.estRunRate?.bestNetPerDay1k} isPaid={isPaid}>{v => `$${(v as number).toFixed(2)}/day`}</Redacted>
                  </Stat>
                  <Stat label="Sanity gate">2%/day thin-book</Stat>
                </div>
                <p className="font-body text-[10.5px] text-muted mt-2 leading-snug">{data.liquidity.forwardNote}</p>
              </div>
            )}

            {/* signal-only venues */}
            {data.signalOnly && (
              <div className="rounded-card bg-surface shadow-card px-4 py-3.5">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="font-display font-semibold text-ink text-[14px]">{data.signalOnly.label}</span>
                  <EdgeChip variant="signal" />
                  <InfoDot term="signal_only_venue" />
                </div>
                <p className="font-body text-[11px] text-ink-2 leading-snug">{data.signalOnly.venues.join(' · ')}</p>
                <p className="font-body text-[10.5px] text-muted mt-1.5 leading-snug">{data.signalOnly.note}</p>
              </div>
            )}
          </div>

          {/* footer honesty */}
          <p className="font-body text-[10px] text-muted mt-5 leading-snug text-center">
            Real marks only · executable headline · THIN &amp; signal-only never merged into P&L · annualized capped {data.annualizedCapNote} · unknown = "—", never fabricated.
            {!isPaid && <> Derived edge is null on the free tier — <a href="/dashboard/upgrade" className="text-violet">upgrade →</a></>}
          </p>
        </>
      )}

      {modalPos && <PositionModal pos={modalPos} isPaid={isPaid} onClose={() => setModalPos(null)} />}
    </main>
  );
}
