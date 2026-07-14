'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { ChevronRight, Lock } from 'lucide-react';
import EdgeChip from '@/app/components/ui/EdgeChip';
import InfoDot from '@/app/components/ui/InfoDot';
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
// arbProfitPct is a FRACTION (0.02 = 2%), unlike edgePct which is already a percent.
const fmtGuar = (frac: number | null | undefined): string =>
  frac == null || !isFinite(frac) ? '—' : `+${(frac * 100).toFixed(2)}%`;
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

// Parent sport category from the REAL `sport` key prefix (soccer_usa_mls →
// Soccer, basketball_wnba → Basketball, …). No brand logos invented — emoji
// only, with a neutral fallback for any unmapped sport.
type SportCat = { key: string; label: string; emoji: string };
const SPORT_CATS: { key: string; label: string; emoji: string; pfx: string }[] = [
  { key: 'soccer',           label: 'Soccer',        emoji: '⚽', pfx: 'soccer' },
  { key: 'basketball',       label: 'Basketball',    emoji: '🏀', pfx: 'basketball' },
  { key: 'tennis',           label: 'Tennis',        emoji: '🎾', pfx: 'tennis' },
  { key: 'baseball',         label: 'Baseball',      emoji: '⚾', pfx: 'baseball' },
  { key: 'americanfootball', label: 'Am. Football',  emoji: '🏈', pfx: 'americanfootball' },
  { key: 'icehockey',        label: 'Ice Hockey',    emoji: '🏒', pfx: 'icehockey' },
];
const OTHER_CAT: SportCat = { key: 'other', label: 'Other', emoji: '🏆' };
function sportCat(sport: string): SportCat {
  const m = SPORT_CATS.find(c => (sport ?? '').startsWith(c.pfx));
  return m ? { key: m.key, label: m.label, emoji: m.emoji } : OTHER_CAT;
}
function leagueEmoji(sport: string): string {
  return sportCat(sport).emoji;
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

// ── three-tier kind → chip / color / label (honest reliability split) ────────
// cashable  = real arb WITH a Pinnacle covering leg  → strong green (most reliable)
// arb_soft  = real arb, all soft books (no sharp leg) → amber (real but fragile)
// signal    = value vs Pinnacle fair, arbSum ≥ 1      → blue/violet
type Tier = 'cashable' | 'arb_soft' | 'signal';
const tierOf = (ev: ScannedEvent): Tier =>
  ev.kind === 'cashable' ? 'cashable' : ev.kind === 'arb_soft' ? 'arb_soft' : 'signal';
const isArbTier = (t: Tier) => t === 'cashable' || t === 'arb_soft';
// number color per arb tier (mint for cashable, gold for arb_soft)
const tierNumClass = (t: Tier) => (t === 'cashable' ? 'text-mint-deep' : t === 'arb_soft' ? 'text-gold' : 'text-violet');

// Arb-soft chip mirrors EdgeChip's shape (no EdgeChip variant exists for it).
function ArbSoftChip() {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-[3px] rounded-md font-body font-semibold text-[9.5px] tracking-wide uppercase bg-gold-tint text-gold">
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-gold" aria-hidden />ARB · SOFT
    </span>
  );
}
function KindChip({ tier }: { tier: Tier }) {
  if (tier === 'cashable') return <EdgeChip variant="cashable" />;
  if (tier === 'arb_soft') return <ArbSoftChip />;
  return <EdgeChip variant="signal" />;
}

// ── scrollable sport filter pill (active = dark filled, inactive = outlined) ──
function FilterPill({ emoji, label, count, active, onClick }: { emoji?: string; label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full font-body text-[12px] font-medium transition-colors ${
        active ? 'bg-ink text-white' : 'bg-surface text-ink-2 border border-line hover:border-ink/30'
      }`}
    >
      {emoji && <span className="text-[13px]" aria-hidden>{emoji}</span>}
      {label}
      <span className={`tabular-nums ${active ? 'text-white/70' : 'text-muted'}`}>{count}</span>
    </button>
  );
}

// ── labelled stat (paper style) ──────────────────────────────────────────────
function Stat({ label, children, demoted }: { label: React.ReactNode; children: React.ReactNode; demoted?: string }) {
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

// ── Suggested placement — one honest "Bet {outcome} @ {odds} on {book}" line
// per leg, reusing the already-visible outcome/book plus the (gated) odds. Arb
// tiers list every covering leg (with the paid-only stake split); signal lists
// the single value leg. No actionable leg (none / no-sharp / suppressed / no
// comparable) → nothing rendered — never an invented bet. Purely additive: the
// bottom "Signal only — indicative" caveat still covers the whole block.
function PlacementHint({ ev, isPaid }: { ev: ScannedEvent; isPaid: boolean }) {
  const tier = tierOf(ev);
  const e = ev.edgeVsSharp;
  const arbLegs = ev.arbLegs ?? [];
  type HintLine = { outcome: string; book: string; odd: number | null; stakePct: number | null };
  let lines: HintLine[] = [];
  if (isArbTier(tier) && arbLegs.length) {
    // cashable / arb_soft → the legs to cover (odds + stake both gated)
    lines = arbLegs.map(l => ({ outcome: l.outcome, book: l.bookmaker, odd: l.odd, stakePct: l.stakePct }));
  } else if (e?.status === 'signal' && e.outcome && e.softBook) {
    // signal → the single value leg vs Pinnacle fair (softOdd gated)
    lines = [{ outcome: e.outcome, book: e.softBook, odd: e.softOdd ?? null, stakePct: null }];
  }
  if (!lines.length) return null; // no actionable leg → no fabricated bet
  const num = tierNumClass(tier);
  return (
    <div className="rounded-lg bg-bg-soft/60 px-3 py-2.5 mt-3">
      <p className="font-body text-[10px] uppercase tracking-wide text-muted mb-1.5">Suggested placement</p>
      <div className="space-y-1">
        {lines.map((l, i) => (
          <p key={`${l.outcome}-${i}`} className="font-body text-[11.5px] text-ink leading-snug">
            Bet <b>{l.outcome || '—'}</b> @{' '}
            <span className={`tabular-nums font-semibold ${num}`}>
              <Redacted value={l.odd} isPaid={isPaid}>{v => fmtOdd(v as number)}</Redacted>
            </span>{' '}
            on <b>{l.book || '—'}</b>
            {/* stake split is a paid-only field (null on free tier) — never fabricated */}
            {l.stakePct != null && (
              <span className="text-muted"> · stake{' '}
                <Redacted value={l.stakePct} isPaid={isPaid}>{v => `${(v as number).toFixed(1)}%`}</Redacted>
              </span>
            )}
          </p>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Expanded event detail — per-outcome sharp table + honest caveat
// ══════════════════════════════════════════════════════════════════════════════
function EventDetail({ ev, isPaid }: { ev: ScannedEvent; isPaid: boolean }) {
  const sr: SharpReference | null | undefined = ev.sharpReference;
  const e = ev.edgeVsSharp;
  const view = edgeView(e);
  const tier = tierOf(ev);
  const isCashable = tier === 'cashable';
  const isArb = isArbTier(tier);
  const arbLegs = ev.arbLegs ?? [];
  const outcomes = ev.bestLegs.map(l => l.outcome);
  const dash = <span className="text-muted">—</span>;

  // tier-specific styling for the arb block
  const ac = isCashable
    ? { border: 'border-mint-deep/30', bg: 'bg-mint-tint/30', head: 'text-mint-deep', tblBorder: 'border-mint-deep/20', tblHead: 'bg-mint-tint/50 text-mint-deep', num: 'text-mint-deep', title: 'Locked-in arbitrage' }
    : { border: 'border-gold/40', bg: 'bg-gold-tint/40', head: 'text-gold', tblBorder: 'border-gold/25', tblHead: 'bg-gold-tint/60 text-gold', num: 'text-gold', title: 'Soft-book arbitrage' };

  return (
    <div className="px-4 pb-4 pt-1 border-t border-line/70 bg-bg-soft/30">
      {/* status line */}
      <div className="flex items-center gap-2 my-3 flex-wrap">
        <KindChip tier={tier} />
        <InfoDot term={tier} />
        {isCashable && <Tag text="Pinnacle leg" tone="mint" />}
        {tier === 'arb_soft' && <Tag text="no sharp leg" tone="gold" />}
        {tier === 'signal' && <Tag text={view.label} tone={view.tone} />}
        {ev.settlement?.crossSettlementRisk && <Tag text="settlement risk" tone="coral" />}
      </div>

      {/* CASHABLE / ARB_SOFT — true arbitrage (arbSum < 1). Covering legs + guaranteed profit. */}
      {isArb && (
        <div className={`rounded-lg border ${ac.border} ${ac.bg} px-3 py-3 mb-3`}>
          <div className="flex items-baseline justify-between mb-2">
            <p className={`font-body text-[10px] uppercase tracking-widest ${ac.head}`}>{ac.title}</p>
            <p className={`font-display font-bold ${ac.num} text-[18px] tabular-nums`}>
              <Redacted value={ev.arbProfitPct} isPaid={isPaid}>{v => fmtGuar(v as number)}</Redacted>
              <span className="font-body text-[10px] font-medium text-muted ml-1">guaranteed</span>
            </p>
          </div>
          {tier === 'arb_soft' && (
            <p className="font-body text-[10.5px] text-gold mt-0.5 mb-2 leading-snug">
              <b>Soft-book arb — no sharp (Pinnacle) leg.</b> Mathematically an arb, but higher execution risk: soft books limit/ban arb winners and move lines fast. Less reliable than a Pinnacle-anchored arb.
            </p>
          )}
          {/* covering legs table */}
          <div className={`rounded-md overflow-hidden border ${ac.tblBorder} bg-surface/70`}>
            <div className={`grid grid-cols-[1.2fr_1.3fr_0.9fr_0.9fr] gap-1 px-2.5 py-1.5 ${ac.tblHead} font-body text-[9px] uppercase tracking-wide`}>
              <span>Outcome</span><span>Book</span><span className="text-right">Odds</span><span className="text-right">Stake</span>
            </div>
            {arbLegs.map(l => {
              const isSharpLeg = l.bookmakerId === 'pinnacle';
              return (
                <div key={l.outcome} className={`grid grid-cols-[1.2fr_1.3fr_0.9fr_0.9fr] gap-1 px-2.5 py-2 items-center border-t border-line/50 ${isSharpLeg ? 'bg-mint-tint/40' : ''}`}>
                  <span className="font-body text-[11px] text-ink truncate">{l.outcome}</span>
                  <span className="font-body text-[11px] text-ink-2 flex items-center gap-1.5 min-w-0">
                    <Lettermark name={l.bookmaker} /><span className="truncate">{l.bookmaker}</span>
                    {isSharpLeg && <span className="font-body text-[8.5px] font-bold text-mint-deep uppercase tracking-wide shrink-0">sharp ◆</span>}
                  </span>
                  <span className="text-right font-body text-[11px] tabular-nums text-ink font-semibold">
                    <Redacted value={l.odd} isPaid={isPaid}>{v => fmtOdd(v as number)}</Redacted>
                  </span>
                  <span className="text-right font-body text-[11px] tabular-nums text-ink-2">
                    <Redacted value={l.stakePct} isPaid={isPaid}>{v => `${(v as number).toFixed(1)}%`}</Redacted>
                  </span>
                </div>
              );
            })}
          </div>
          <p className="font-body text-[10px] text-muted mt-2 leading-snug">
            Σ implied prob <Redacted value={ev.impliedSum} isPaid={isPaid}>{v => <b className={ac.num}>{(v as number).toFixed(4)}</b>}</Redacted> &lt; 1 at snapshot — a guaranteed profit whatever the result, stakes split for equal payout.
          </p>
          <p className="font-body text-[10px] text-coral-ink mt-1.5 leading-snug">
            <b>Arb indicative — verify before placing.</b> Odds move in seconds, books limit/void winning arbs, and a leg can fail. Not a guarantee of execution.
          </p>
        </div>
      )}

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
              <span className="text-right inline-flex items-center justify-end gap-0.5">No-vig fair <InfoDot term="no_vig_fair" size={11} /></span>
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
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-3">
            <Stat label={<>Sharp book <InfoDot term="sharp_book" size={11} /></>} demoted="only verified/sharp reference">Pinnacle</Stat>
            <Stat label={<>Pinnacle vig <InfoDot term="vig" size={11} /></>} demoted="overround stripped for fair line">
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

      {/* Suggested placement — tier-aware, near the best-edge data. Reuses the
          already-visible outcome/book/odds; no bet line on no-sharp/suppressed. */}
      <PlacementHint ev={ev} isPaid={isPaid} />

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
  const tier = tierOf(ev);
  const isArb = isArbTier(tier);
  const view = edgeView(ev.edgeVsSharp);
  const muted = !isArb && view.status !== 'signal';
  const ring = tier === 'cashable' ? 'ring-1 ring-mint-deep/30' : tier === 'arb_soft' ? 'ring-1 ring-gold/40' : '';
  return (
    <div className={`rounded-card bg-surface shadow-card overflow-hidden ${ring} ${muted ? 'opacity-[0.92]' : ''}`}>
      <button onClick={onToggle} className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-bg-soft/40 transition-colors">
        <span className="text-[15px] shrink-0" aria-hidden>{leagueEmoji(ev.sport)}</span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2 mb-1">
            <span className="font-display font-semibold text-ink text-[14px] truncate">{ev.eventName}</span>
            <KindChip tier={tier} />
          </span>
          <span className="font-body text-[11px] text-muted">{ev.sportLabel} · {fmtWhen(ev.commenceTime)}</span>
        </span>
        <span className="text-right shrink-0">
          {isArb ? (
            <span className={`block font-body text-[15px] font-semibold tabular-nums ${tierNumClass(tier)}`}>
              <Redacted value={ev.arbProfitPct} isPaid={isPaid}>{v => fmtGuar(v as number)}</Redacted>
            </span>
          ) : view.hasNumber ? (
            <span className="block font-body text-[15px] font-semibold tabular-nums text-violet">
              <Redacted value={ev.edgeVsSharp?.edgePct} isPaid={isPaid}>{v => fmtEdge(v as number)}</Redacted>
            </span>
          ) : (
            <span className="block font-body text-[11px] text-muted">{view.label}</span>
          )}
          <span className="block font-body text-[9.5px] text-muted uppercase tracking-wide">
            {tier === 'cashable' ? 'guaranteed arb' : tier === 'arb_soft' ? 'soft-book arb' : view.status === 'signal' ? 'vs sharp fair' : ev.sharpReference?.present ? 'sharp quoted' : 'no sharp ref'}
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
  const [sportFilter, setSportFilter] = useState<string>('all');

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/sports-snapshot', { cache: 'no-store' });
      const j: SnapshotResponse = await r.json();
      setData(j); setErr(null);
    } catch (e: any) { setErr(e?.message || 'failed to load'); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 5 * 60_000); return () => clearInterval(t); }, [load]);

  const isPaid = data?.isPaid ?? false;

  // Sort: cashable → arb_soft → signal → sharp-quoted → no-sharp/suppressed.
  // Within a tier: arbs by profit desc, signals by edge desc, else soonest.
  const events = useMemo(() => {
    const evs = [...(data?.scannedEvents ?? [])];
    const rank = (ev: ScannedEvent) => {
      const t = tierOf(ev);
      if (t === 'cashable') return -2;              // Pinnacle-anchored arb — top
      if (t === 'arb_soft') return -1;              // soft-only arb — second
      const st = ev.edgeVsSharp?.status;
      if (st === 'signal') return 0;
      if (st === 'suppressed_outlier') return 3;
      if (ev.sharpReference?.present) return 1;
      return 2; // no_sharp_reference
    };
    const sortVal = (ev: ScannedEvent) =>
      isArbTier(tierOf(ev)) ? (ev.arbProfitPct ?? 0) * 100 : (ev.edgeVsSharp?.edgePct ?? null);
    return evs.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      const va = sortVal(a), vb = sortVal(b);
      if (va != null && vb != null && va !== vb) return vb - va;
      return new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime();
    });
  }, [data]);

  const counts = useMemo(() => {
    const c = { cashable: 0, arbSoft: 0, signal: 0, sharp: 0, noSharp: 0 };
    for (const ev of data?.scannedEvents ?? []) {
      const t = tierOf(ev);
      if (t === 'cashable') c.cashable++;
      else if (t === 'arb_soft') c.arbSoft++;
      if (ev.edgeVsSharp?.status === 'signal') c.signal++;
      if (ev.sharpReference?.present) c.sharp++; else c.noSharp++;
    }
    return c;
  }, [data]);

  // Hero priority: cashable → arb_soft → top edge. Paid sees the number; free a lock.
  const topCashable = useMemo(() => events.find(e => tierOf(e) === 'cashable'), [events]);
  const topArbSoft = useMemo(() => events.find(e => tierOf(e) === 'arb_soft'), [events]);
  const topSignal = useMemo(() => events.find(e => e.edgeVsSharp?.status === 'signal'), [events]);

  // Group the ALREADY-sorted `events` by parent sport category (order within
  // each category is inherited: cashable → arb_soft → signal → edge desc).
  // Category order: those containing a real arb (cashable/arb_soft) first, then
  // by event count desc. Purely a display regroup — no event/number is changed.
  const categories = useMemo(() => {
    const map = new Map<string, { cat: SportCat; evs: ScannedEvent[] }>();
    for (const ev of events) {
      const c = sportCat(ev.sport);
      if (!map.has(c.key)) map.set(c.key, { cat: c, evs: [] });
      map.get(c.key)!.evs.push(ev);
    }
    return Array.from(map.values()).sort((a, b) => {
      const aArb = a.evs.some(e => isArbTier(tierOf(e))) ? 1 : 0;
      const bArb = b.evs.some(e => isArbTier(tierOf(e))) ? 1 : 0;
      if (aArb !== bArb) return bArb - aArb;         // categories with real arbs first
      return b.evs.length - a.evs.length;            // then by event count
    });
  }, [events]);

  const visibleCategories = sportFilter === 'all'
    ? categories
    : categories.filter(c => c.cat.key === sportFilter);

  return (
    <main className="dash-container px-4 pb-24 pt-5 font-body">
      {/* header */}
      <div className="flex items-center justify-between mb-1">
        <h1 className="font-display font-bold text-ink text-[22px] tracking-tight">Edgeradar · Sports</h1>
        <EdgeChip variant="signal" />
      </div>
      <p className="font-body text-[12px] text-muted mb-3">
        Three tiers by reliability
        {data && <> · {data.stale ? 'stale' : `updated ${fmtAge(data.ageMinutes)}`}</>}
      </p>

      {/* tier legend */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-5">
        <span className="inline-flex items-center gap-1.5"><EdgeChip variant="cashable" /><span className="font-body text-[10px] text-muted">arb w/ Pinnacle leg</span></span>
        <span className="inline-flex items-center gap-1.5"><ArbSoftChip /><span className="font-body text-[10px] text-muted">soft-only arb · fragile</span></span>
        <span className="inline-flex items-center gap-1.5"><EdgeChip variant="signal" /><span className="font-body text-[10px] text-muted">value vs Pinnacle</span></span>
      </div>

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
          {/* hero — cashable arb (if any), else top sharp edge, else calm state */}
          <div className="rounded-card bg-surface shadow-card px-5 py-5 mb-3">
            {topCashable ? (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <p className="font-body text-[11px] uppercase tracking-wide text-muted">Best locked-in arbitrage</p>
                  <EdgeChip variant="cashable" />
                </div>
                <span className="font-display font-bold leading-none tracking-tight tabular-nums text-mint-deep" style={{ fontSize: 40 }}>
                  <Redacted value={topCashable.arbProfitPct} isPaid={isPaid}>{v => fmtGuar(v as number)}</Redacted>
                </span>
                <p className="font-body text-[12px] text-ink-2 mt-2.5 leading-snug">
                  {topCashable.eventName} · guaranteed profit across {topCashable.arbLegs?.length ?? '—'} legs · <span className="text-coral-ink">indicative, verify before placing</span>
                </p>
              </>
            ) : topArbSoft ? (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <p className="font-body text-[11px] uppercase tracking-wide text-muted">Best soft-book arbitrage</p>
                  <ArbSoftChip />
                </div>
                <span className="font-display font-bold leading-none tracking-tight tabular-nums text-gold" style={{ fontSize: 40 }}>
                  <Redacted value={topArbSoft.arbProfitPct} isPaid={isPaid}>{v => fmtGuar(v as number)}</Redacted>
                </span>
                <p className="font-body text-[12px] text-ink-2 mt-2.5 leading-snug">
                  {topArbSoft.eventName} · all-soft arb, no sharp leg · <span className="text-gold">higher execution risk</span> · <span className="text-coral-ink">verify before placing</span>
                </p>
              </>
            ) : topSignal ? (
              <>
                <p className="font-body text-[11px] uppercase tracking-wide text-muted mb-2">Top edge vs Pinnacle sharp fair</p>
                <span className="font-display font-bold leading-none tracking-tight tabular-nums text-violet" style={{ fontSize: 40 }}>
                  <Redacted value={topSignal.edgeVsSharp?.edgePct} isPaid={isPaid}>{v => fmtEdge(v as number)}</Redacted>
                </span>
                <p className="font-body text-[12px] text-ink-2 mt-2.5 leading-snug">
                  {topSignal.eventName} · {topSignal.edgeVsSharp?.outcome} @ {topSignal.edgeVsSharp?.softBook} · <span className="text-muted">Signal, not cashable</span>
                </p>
              </>
            ) : (
              <>
                <p className="font-body text-[11px] uppercase tracking-wide text-muted mb-2">Sports arbitrage &amp; sharp edge</p>
                <span className="font-display font-bold leading-none tracking-tight text-ink-2" style={{ fontSize: 26 }}>No arb right now</span>
                <p className="font-body text-[12px] text-ink-2 mt-2.5 leading-snug">A calm, valid state — 0 cashable and 0 soft-book arbs is the correct, expected result almost always. Books sit at or inside Pinnacle's fair line.</p>
              </>
            )}
            {/* summary strip */}
            <div className="grid grid-cols-4 gap-2 mt-4">
              <Stat label="Cashable">{counts.cashable}</Stat>
              <Stat label="Arb soft">{counts.arbSoft}</Stat>
              <Stat label="Signal">{counts.signal}</Stat>
              <Stat label="No sharp">{counts.noSharp}</Stat>
            </div>
          </div>

          {/* sport filter pills — horizontal scroll */}
          <div className="flex gap-2 overflow-x-auto md:flex-wrap md:overflow-x-visible pb-1 -mx-4 px-4 mb-4 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
            <FilterPill label="All" count={events.length} active={sportFilter === 'all'} onClick={() => setSportFilter('all')} />
            {categories.map(({ cat, evs }) => (
              <FilterPill key={cat.key} emoji={cat.emoji} label={cat.label} count={evs.length}
                active={sportFilter === cat.key} onClick={() => setSportFilter(cat.key)} />
            ))}
          </div>

          {/* grouped by sport category */}
          {visibleCategories.map(({ cat, evs }) => (
            <section key={cat.key} className="mb-5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[14px]" aria-hidden>{cat.emoji}</span>
                <h2 className="font-display font-semibold text-ink text-[13px] tracking-tight">{cat.label}</h2>
                <span className="font-body text-[11px] text-muted">{evs.length}</span>
                <span className="flex-1 h-px bg-line ml-1" aria-hidden />
              </div>
              <div className="space-y-2 lg:grid lg:grid-cols-2 lg:gap-2 lg:space-y-0 lg:items-start">
                {evs.map(ev => {
                  const key = `${ev.sport}:${ev.eventName}:${ev.commenceTime}`;
                  return (
                    <EventRow key={key} ev={ev} isPaid={isPaid}
                      open={expanded === key} onToggle={() => setExpanded(expanded === key ? null : key)} />
                  );
                })}
              </div>
            </section>
          ))}

          {/* footer honesty */}
          <p className="font-body text-[10px] text-muted mt-5 leading-snug text-center">
            All three from the same arb math (Σ 1/odds &lt; 1 across ≥2 books, guarded): <b className="text-mint-deep">Cashable</b> has a Pinnacle leg (sharp, high limits); <b className="text-gold">Arb soft</b> is all-soft (real but fragile — limits/bans/line-moves); <b className="text-violet">Signal</b> is value vs Pinnacle's fair line (arbSum ≥ 1, single-leg, not guaranteed). Suppressed outliers shown, never hidden · unknown = "—" · 0 cashable/arb-soft is calm &amp; expected.
            {!isPaid && <> Profit %, odds &amp; stakes are null on the free tier — <a href="/dashboard/upgrade" className="text-violet">upgrade →</a></>}
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
