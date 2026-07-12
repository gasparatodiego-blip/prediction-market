'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// lib/paper-book-assemble.js — SINGLE SOURCE OF TRUTH for paper-book aggregation.
//
// This is the ONE place the forward-paper-trade store (data/paper-trades.json,
// written by agent32-paper-trader) is aggregated into headline / per-strategy /
// per-position numbers. Both consumers use it so the numbers can never diverge:
//   • agent32-paper-trader.js  dailySummary()  → the 22:00 Telegram report text
//   • app/api/paper-book/route.ts               → the unified dashboard payload
//
// HONEST-ENGINE (absolute). Every rule below is copied verbatim from the math
// agent32.dailySummary already ships — this module changes the SHAPE of the
// output (structured object instead of Telegram text), never a NUMBER:
//   • Per-trade value  v = lastMark.netUsd ?? lastMark.unrealizedUsd ?? null.
//     A null mark is NOT summed — it renders "—", never zero-filled.
//   • Within-capacity clamp: |v| can never exceed the real book depth the ticket
//     was sized into (structural guard; a no-op today since |P&L| ≪ capacityUsd).
//   • THIN "not executable at size" rows (verdict matches /thin|not executable/i)
//     are kept but held OFF the executable headline and reported on their own
//     THIN line — never merged into the headline, never silently dropped.
//   • Copy sleeves contribute realized + (real-marked) unrealized only.
//   • Notional framing: N independent $1,000 tickets on ~totalNotional of paper
//     capital — never a "% on one $1,000 book".
//   • This module only RE-AGGREGATES marks agent32 already wrote from real
//     source data. It never re-derives a price or funding rate from raw history
//     (that is the Paradex-overcount trap the marker itself guards against).
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60_000;

// A position is "not executable at size" (THIN) when its own verdict says so —
// the same honest-engine flag the live product uses to demote a row.
const THIN_VERDICT = /thin|not executable/i;

function round(n, d = 2) {
  return n == null || !isFinite(n) ? null : Number(Number(n).toFixed(d));
}
function isThin(t) {
  return THIN_VERDICT.test(String((t.entry && t.entry.verdict) || ''));
}

// The single per-trade valuation rule (identical to agent32.dailySummary):
// netUsd if present, else unrealizedUsd, else null ("—"), then within-capacity clamp.
function tradeValue(t) {
  const m = t.lastMark || {};
  let v = m.netUsd != null ? m.netUsd : (m.unrealizedUsd != null ? m.unrealizedUsd : null);
  if (v == null) return null;
  const cap = Number(t.entry && t.entry.capacityUsd);
  if (cap > 0 && Math.abs(v) > cap) v = Math.sign(v) * cap; // clamp to real depth
  return v;
}

const CAT_LABEL = {
  'perp-spot-funding':   'Perp-spot funding',
  'cross-venue-funding': 'Cross-venue funding',
  'basis':               'Basis (cash & carry)',
  'prediction-arb':      'Prediction arbitrage',
};
const CAT_METRIC = {
  'perp-spot-funding':   'net $/day',
  'cross-venue-funding': 'net $/day',
  'basis':               'net annualized · unlock at expiry',
  'prediction-arb':      'total ROI · unlock at resolution',
};
// Every paper category prices a real executable leg → cashable chip, EXCEPT rows
// individually flagged THIN (handled per-row). Copy is a mirror.
const CAT_CHIP = {
  'perp-spot-funding':   'cashable',
  'cross-venue-funding': 'cashable',
  'basis':               'cashable',
  'prediction-arb':      'cashable',
};

// Build the per-position detail object the dashboard L3 view renders. Every field
// is passed straight from the stored trade — a missing field stays undefined and
// renders "—". No fabrication, no zero-fill.
function positionDetail(t) {
  const v = tradeValue(t);
  const thin = isThin(t);
  return {
    id: t.id,
    category: t.category,
    label: t.label,
    status: t.status,
    metricKind: t.metricKind,
    thin,
    value: round(v, 4),          // headline contribution ("—" if null)
    entry: t.entry || null,
    lastMark: t.lastMark || null,
    marks: Array.isArray(t.marks) ? t.marks : [],
    contractKey: t.contractKey ?? null,
    fundingCursorT: t.fundingCursorT ?? null,
    cumFundingUsd: t.cumFundingUsd != null ? round(t.cumFundingUsd, 4) : null,
  };
}

// Aggregate an equity curve from STORED marks only (no interpolation). agent32
// marks every open position at the SAME `until` timestamp each cycle, so marks
// are synchronized: for each distinct mark timestamp, sum each executable trade's
// value at that timestamp. Positions without a mark at a timestamp contribute
// nothing (not zero-filled into other positions). Stepwise, real points only.
function equityCurve(trades) {
  const byTs = new Map(); // asOf(iso) -> summed executable value
  for (const t of trades) {
    if (isThin(t)) continue; // headline curve tracks executable P&L only
    const cap = Number(t.entry && t.entry.capacityUsd);
    for (const m of (t.marks || [])) {
      let v = m.netUsd != null ? m.netUsd : (m.unrealizedUsd != null ? m.unrealizedUsd : null);
      if (v == null) continue;
      if (cap > 0 && Math.abs(v) > cap) v = Math.sign(v) * cap;
      byTs.set(m.asOf, (byTs.get(m.asOf) || 0) + v);
    }
  }
  return [...byTs.entries()]
    .map(([asOf, netUsd]) => ({ asOf, netUsd: round(netUsd, 4) }))
    .sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
}

/**
 * assemblePaperBook(store, opts) → structured, honest paper-book aggregation.
 * `store` is the parsed data/paper-trades.json. Pure; reads nothing else.
 * opts.nowMs lets the caller inject a clock (agent32 passes Date.now()); the
 * API omits it and the day index is derived from stored timestamps instead.
 */
function assemblePaperBook(store, opts = {}) {
  const nowMs = typeof opts.nowMs === 'number'
    ? opts.nowMs
    : (store && store.updatedAt ? Date.parse(store.updatedAt) : Date.parse(store && store.entryAsOf));

  const trades = Array.isArray(store && store.trades) ? store.trades : [];
  const copySleeves = Array.isArray(store && store.copySleeves) ? store.copySleeves : [];

  // ── per-category aggregation (identical rule to agent32.dailySummary) ──────
  const byCat = {};
  // openTicket*/openNotional* count EVERY open marked ticket (exec + THIN) — this
  // is agent32.dailySummary's `totalOpen`/`totalNotional`, kept byte-identical so
  // the Telegram framing never changes. execTicket*/execNotional* are the tighter,
  // exec-only framing the dashboard hero uses (its headline P&L is exec-only).
  let openTicketCount = 0, openNotionalUsd = 0;
  let execTicketCount = 0, execNotionalUsd = 0;
  let execHeadlinePnl = 0, execHeadlineHas = false;
  let thinTotalPnl = 0, thinTotalHas = false, thinTotalOpen = 0;

  for (const t of trades) {
    const c = t.category;
    byCat[c] = byCat[c] || {
      key: c, label: CAT_LABEL[c] || c, metric: CAT_METRIC[c] || null, chip: CAT_CHIP[c] || 'paper',
      open: 0, matured: 0,
      execOpen: 0, execNotionalUsd: 0, execPnlUsd: 0, execHas: false,
      thinOpen: 0, thinPnlUsd: 0, thinHas: false,
      positions: [],
    };
    const b = byCat[c];
    if (t.status === 'open') b.open++; else if (t.status === 'matured') b.matured++;
    b.positions.push(positionDetail(t));

    const v = tradeValue(t);
    if (v == null) continue;                       // unmarked → "—", never summed
    const notional = Number(t.entry && t.entry.notionalUsd) || 0;
    // agent32 framing: every open marked ticket counts, THIN included.
    if (t.status === 'open') { openTicketCount++; openNotionalUsd += notional; }
    const thin = isThin(t);
    if (thin) {
      b.thinPnlUsd += v; b.thinHas = true; if (t.status === 'open') b.thinOpen++;
      thinTotalPnl += v; thinTotalHas = true; if (t.status === 'open') thinTotalOpen++;
    } else {
      b.execPnlUsd += v; b.execHas = true;
      if (t.status === 'open') {
        b.execOpen++; b.execNotionalUsd += notional;
        execTicketCount++; execNotionalUsd += notional;
      }
      execHeadlinePnl += v; execHeadlineHas = true;
    }
  }

  // ── copy mirror sleeves (realized + real-marked unrealized only) ──────────
  let copyOpenLegs = 0, copyPnl = 0, copyHas = false;
  const copySleeveDetail = [];
  for (const s of copySleeves) {
    const openLegs = (s.lastMark && s.lastMark.openPositions) || 0;
    copyOpenLegs += openLegs;
    const r = s.realizedUsd || 0;
    const u = (s.lastMark && s.lastMark.unrealizedUsd) || 0; // null → 0 contribution ("—" shown per-sleeve)
    const sleevePnl = r + u;
    copyPnl += sleevePnl;
    if (s.realizedUsd != null) copyHas = true;
    copySleeveDetail.push({
      id: s.id, label: s.label, wallet: s.wallet, status: s.status,
      budgetUsd: s.budgetUsd ?? null, deployedUsd: s.deployedUsd ?? null,
      realizedUsd: s.realizedUsd != null ? round(s.realizedUsd, 4) : null,
      unrealizedUsd: (s.lastMark && s.lastMark.unrealizedUsd != null) ? round(s.lastMark.unrealizedUsd, 4) : null,
      openLegs, lastMark: s.lastMark || null, closed: Array.isArray(s.closed) ? s.closed : [],
    });
  }

  const entryMs = Date.parse(store && store.entryAsOf);
  const dayIndex = isFinite(entryMs) ? Math.max(0, Math.floor((nowMs - entryMs) / DAY_MS)) : 0;

  // Headline = executable P&L (paper categories) + copy realized/unrealized. THIN
  // is a SEPARATE labelled total, never merged in. Copy counts as executable-mirror.
  const headlineExecPnl = execHeadlinePnl + copyPnl;
  const headlineHas = execHeadlineHas || copyHas;

  return {
    meta: {
      entryAsOf: store && store.entryAsOf || null,
      updatedAt: store && store.updatedAt || null,
      simDays: store && store.simDays || null,
      simEndsAt: store && store.simEndsAt || null,
      notionalUsd: store && store.notionalUsd || null,
      dayIndex,
    },
    headline: {
      // executable, within-capacity P&L only — the ONE number the hero shows.
      executablePnlUsd: headlineHas ? round(headlineExecPnl, 2) : null,
      executablePnlHas: headlineHas,
      // THIN "not executable at size" value — returned SEPARATELY, never in the headline.
      thinPnlUsd: thinTotalHas ? round(thinTotalPnl, 2) : null,
      thinOpen: thinTotalOpen,
      // Honest notional framing (dashboard hero): the exec-only tickets/notional the
      // executable headline P&L is actually spread across — N independent $1,000 tickets,
      // never one $1,000 book, THIN excluded (it has its own line).
      ticketCount: execTicketCount,
      ticketSizeUsd: store && store.notionalUsd || null,
      totalNotionalUsd: round(execNotionalUsd, 0),
      // agent32.dailySummary framing: ALL open marked tickets (exec + THIN). Exposed so
      // the Telegram line stays byte-identical when agent32 consumes this same assembly.
      openTicketCountAll: openTicketCount,
      openNotionalUsdAll: round(openNotionalUsd, 0),
    },
    equityCurve: equityCurve(trades),
    strategies: Object.values(byCat).map((b) => ({
      key: b.key, label: b.label, metric: b.metric, chip: b.chip,
      open: b.open, matured: b.matured,
      execOpen: b.execOpen,
      execNotionalUsd: round(b.execNotionalUsd, 0),
      execPnlUsd: b.execHas ? round(b.execPnlUsd, 2) : null,
      thinOpen: b.thinOpen,
      thinPnlUsd: b.thinHas ? round(b.thinPnlUsd, 2) : null,
      positions: b.positions,
    })),
    copy: {
      sleeveCount: copySleeves.length,
      openLegs: copyOpenLegs,
      pnlUsd: copyHas ? round(copyPnl, 2) : null,
      sleeves: copySleeveDetail,
    },
    excluded: Array.isArray(store && store.excluded) ? store.excluded : [],
  };
}

module.exports = { assemblePaperBook, tradeValue, isThin, THIN_VERDICT, equityCurve };
