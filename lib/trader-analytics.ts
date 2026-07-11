// lib/trader-analytics.ts — honest per-trader P&L reconstruction from REAL fills.
//
// Consumes agent30's per-wallet record (raw Data-API fills + Polymarket /positions)
// and derives everything the trader detail page shows. HONEST-ENGINE rules baked in:
//
//  * Open positions   → unrealized P&L marked to CURRENT mid (curPrice), always
//                       LABELLED "unrealized · mark-to-mid". Never realized.
//  * Resolved         → settle 100¢/0¢, NO exit price. P&L is settlement-realized.
//  * Closed (sold)    → reconstructed from fills: realized = proceeds − cost basis,
//                       avg entry = size-weighted buy price, ROI = P&L / cost basis.
//  * Missing inputs   → null (render as "—"), NEVER invented.
//  * Capped fills     → if a closed line touches the oldest kept fill and the fill
//                       window is capped, its cost basis may be incomplete → P&L
//                       is withheld (null) and flagged, rather than shown wrong.
//
// @ts-ignore — category.js is CommonJS (allowJs); named interop works in Next.
import { categoryFromText } from '@/lib/category';

export interface RawFill {
  txHash: string | null;
  asset: string;
  conditionId: string | null;
  side: string | null;            // BUY | SELL
  price: number;
  size: number;
  timestamp: number;              // unix seconds
  title: string | null;
  slug: string | null;
  eventSlug: string | null;
  outcome: string | null;
  outcomeIndex: number | null;
}

export interface RawPosition {
  asset: string;
  conditionId: string | null;
  size: number | null;
  avgPrice: number | null;
  curPrice: number | null;
  initialValue: number | null;
  currentValue: number | null;
  cashPnl: number | null;         // unrealized (mark-to-mid) for open; settled delta for resolved
  percentPnl: number | null;
  realizedPnl: number | null;
  totalBought: number | null;
  redeemable: boolean;
  title: string | null;
  slug: string | null;
  eventSlug: string | null;
  outcome: string | null;
  outcomeIndex: number | null;
  endDate: string | null;
}

export interface WalletRecord {
  fills: RawFill[];
  positions: RawPosition[];
  firstFillTs: number | null;
  lastFillTs: number | null;
  fillsUpdatedAt: number | null;
  positionsUpdatedAt: number | null;
  fillsCount?: number;
  fillsCapped?: boolean;
  // True count of genuinely-OPEN positions observed (redeemable=false, |size|>0),
  // which can exceed the stored/displayed subset for MM/scalper wallets. openCapped
  // ⇒ even more open exist than we scanned. Both drive the "showing X of Y" note.
  openObserved?: number | null;
  openCapped?: boolean;
}

export type PosStatus = 'open' | 'closed' | 'resolved' | 'settled';

export interface EnrichedPosition {
  key: string;
  market: string | null;
  slug: string | null;
  eventSlug: string | null;
  conditionId: string | null;
  asset: string;
  outcome: string | null;
  status: PosStatus;
  shares: number | null;          // current shares held (open/resolved) or shares traded (closed)
  avgEntry: number | null;        // size-weighted buy price (¢ as 0..1)
  close: number | null;           // open→mark, closed→exit(sell), resolved→settle(0|1)
  closeLabel: string;             // 'mark-to-mid' | 'exit (avg sell)' | 'settled 100¢/0¢'
  costBasis: number | null;
  proceeds: number | null;        // closed/resolved realized proceeds; null for open
  pnl: number | null;
  pnlLabel: string;               // honest label
  realized: boolean;              // whether pnl is realized (vs unrealized)
  roiPct: number | null;
  heldDays: number | null;
  nFills: number;
  incompleteBasis: boolean;
  category: string;
  lastActivityTs: number | null;
  // Real slug-derived market close (unix s) for OPEN timed markets → the detail
  // page's live expiry countdown. null when the slug carries no epoch (non-timed
  // market) → no countdown is shown (honest "no expiry"), never a fabricated one.
  marketEndTs?: number | null;
}

export interface EquityPoint { t: number; cum: number }
export interface CategoryPnl { category: string; realizedPnl: number; winRate: number | null; n: number }

export interface TraderSummary {
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  costBasisOpen: number | null;
  openCount: number;
  closedCount: number;
  resolvedCount: number;
  settledCount: number;
  winRateRealized: number | null;
  realizedTrades: number;
  // openObserved = true open count from the source (≥ openCount, which is capped for
  // display); openTruncated ⇒ the list is a top-by-value subset → UI shows "X of Y".
  openObserved: number;
  openTruncated: boolean;
}

export interface TraderAnalytics {
  summary: TraderSummary;
  positions: EnrichedPosition[];
  equityCurve: EquityPoint[];
  categoryPnl: CategoryPnl[];
}

const EPS = 1e-6;
const clampP = (p: number) => Math.max(0, Math.min(1, p));
function catOf(title: string | null): string {
  try { return (categoryFromText(title || '') as string) || 'Other'; } catch { return 'Other'; }
}

// A position/market line is keyed by conditionId + outcome so a wallet holding
// both sides is split correctly. asset (tokenId) is the tightest key when present.
const lineKey = (asset: string | null, conditionId: string | null, outcomeIndex: number | null) =>
  asset || `${conditionId || 'na'}:${outcomeIndex ?? 'na'}`;

export function buildTraderAnalytics(rec: WalletRecord): TraderAnalytics {
  const fills = Array.isArray(rec.fills) ? rec.fills.slice() : [];
  const rawPositions = Array.isArray(rec.positions) ? rec.positions : [];
  const capped = !!rec.fillsCapped;
  // oldest kept fill timestamp — a closed line reaching this may be missing older buys.
  const oldestTs = fills.length ? Math.min(...fills.map(f => f.timestamp)) : null;

  const openAssets = new Set(rawPositions.map(p => p.asset));

  // ── 1. Reconstruct per-line buy/sell aggregates from fills ──────────────────
  interface Line {
    key: string; asset: string; conditionId: string | null; outcomeIndex: number | null;
    title: string | null; slug: string | null; eventSlug: string | null; outcome: string | null;
    buyShares: number; buyCost: number; sellShares: number; sellProceeds: number;
    firstTs: number; lastTs: number; nFills: number; touchesOldest: boolean;
  }
  const lines = new Map<string, Line>();
  for (const f of fills) {
    if (!f || !Number.isFinite(f.price) || !Number.isFinite(f.size)) continue;
    const k = lineKey(f.asset, f.conditionId, f.outcomeIndex);
    let ln = lines.get(k);
    if (!ln) {
      ln = {
        key: k, asset: f.asset, conditionId: f.conditionId, outcomeIndex: f.outcomeIndex,
        title: f.title, slug: f.slug, eventSlug: f.eventSlug, outcome: f.outcome,
        buyShares: 0, buyCost: 0, sellShares: 0, sellProceeds: 0,
        firstTs: f.timestamp, lastTs: f.timestamp, nFills: 0, touchesOldest: false,
      };
      lines.set(k, ln);
    }
    const p = clampP(f.price), sz = Math.abs(f.size);
    if (f.side === 'SELL') { ln.sellShares += sz; ln.sellProceeds += p * sz; }
    else { ln.buyShares += sz; ln.buyCost += p * sz; }        // default BUY
    ln.firstTs = Math.min(ln.firstTs, f.timestamp);
    ln.lastTs  = Math.max(ln.lastTs, f.timestamp);
    ln.nFills++;
    if (oldestTs != null && f.timestamp <= oldestTs + 1) ln.touchesOldest = true;
  }

  const positions: EnrichedPosition[] = [];
  const realizedEvents: { t: number; pnl: number; category: string; won: boolean }[] = [];

  // ── 2. OPEN / RESOLVED positions — authoritative from Polymarket /positions ──
  for (const p of rawPositions) {
    const ln = lines.get(lineKey(p.asset, p.conditionId, p.outcomeIndex));
    const resolved = !!p.redeemable;   // redeemable ⇒ market resolved, awaiting/eligible redemption
    const status: PosStatus = resolved ? 'resolved' : 'open';
    const settle = resolved ? (p.curPrice != null ? Math.round(p.curPrice) : null) : null;
    const heldDays = ln ? Math.max(0, (ln.lastTs - ln.firstTs) / 86400) : null;
    const category = catOf(p.title);

    if (resolved) {
      // Settlement-realized: settle 100¢/0¢, NO exit price. P&L = settled value − cost.
      const pnl = p.cashPnl;   // Polymarket's cashPnl on a redeemable = settled − cost (realized)
      positions.push({
        key: p.asset, market: p.title, slug: p.slug, eventSlug: p.eventSlug,
        conditionId: p.conditionId, asset: p.asset, outcome: p.outcome, status,
        shares: p.size, avgEntry: p.avgPrice, close: settle, closeLabel: 'settled 100¢/0¢',
        costBasis: p.initialValue, proceeds: (settle != null && p.size != null) ? settle * p.size : null,
        pnl, pnlLabel: 'realized · settled', realized: true,
        roiPct: (pnl != null && p.initialValue) ? (pnl / p.initialValue) * 100 : null,
        heldDays, nFills: ln ? ln.nFills : 0, incompleteBasis: false, category,
        lastActivityTs: ln ? ln.lastTs : null,
      });
      if (pnl != null) {
        // Settlement TIME for the equity curve. We don't get the exact on-chain
        // settlement/elimination timestamp from /positions, and endDate is the
        // market's nominal end which can be in the FUTURE (e.g. a negRisk team
        // eliminated early — its YES settled to 0 now, but the tournament ends
        // later). Plotting a realized loss at a future date would be a lie, so
        // we use the line's REAL last-activity timestamp (a true, ≤-settlement
        // trade time), clamping any endDate fallback to never exceed now.
        const nowTs = Math.floor(Date.now() / 1000);
        const endTs = p.endDate ? Math.floor(new Date(p.endDate + 'T00:00:00Z').getTime() / 1000) : null;
        const t = (ln && ln.lastTs) ? ln.lastTs
          : (endTs != null ? Math.min(endTs, nowTs) : (rec.lastFillTs || nowTs));
        realizedEvents.push({ t, pnl, category, won: pnl > 0 });
      }
    } else {
      // OPEN: unrealized, marked to current mid. Never counted as realized.
      positions.push({
        key: p.asset, market: p.title, slug: p.slug, eventSlug: p.eventSlug,
        conditionId: p.conditionId, asset: p.asset, outcome: p.outcome, status,
        shares: p.size, avgEntry: p.avgPrice, close: p.curPrice, closeLabel: 'mark-to-mid',
        costBasis: p.initialValue, proceeds: null,
        pnl: p.cashPnl, pnlLabel: 'unrealized · mark-to-mid', realized: false,
        roiPct: p.percentPnl,
        heldDays, nFills: ln ? ln.nFills : 0, incompleteBasis: false, category,
        lastActivityTs: ln ? ln.lastTs : null,
        marketEndTs: marketEndTsFromSlug(p.slug),   // real slug epoch → live countdown; null for non-timed
      });
    }
  }

  // ── 3. CLOSED (sold-out) & SETTLED (held-to-settlement) — from fills only ────
  // Any line NOT in the current /positions snapshot is one of:
  //   • CLOSED  — sold back out on the CLOB (has sells, net ≈ 0 shares). Realized
  //               P&L is reconstructable from fills: proceeds − matched cost basis.
  //   • SETTLED — still net-long yet absent from the live snapshot. Almost always a
  //               buy-and-hold-to-settlement line (e.g. 5-min BTC Up/Down scalping):
  //               the market already resolved and the shares were redeemed, so the
  //               position dropped out of /positions. We KNOW the entry (shares, avg
  //               price, cost basis) but NOT the settlement outcome from fills alone,
  //               so realized P&L is HONESTLY withheld (null → "—"), never invented.
  //               Without this branch a pure-buy wallet's fills aggregate to ZERO
  //               positions — the "200 fills but 0 positions" contradiction.
  for (const ln of Array.from(lines.values())) {
    if (openAssets.has(ln.asset)) continue;              // still open/resolved → handled above
    if (ln.buyShares < EPS) continue;                    // no buys → nothing to reconstruct
    const net = ln.buyShares - ln.sellShares;
    const flatTol = Math.max(1, ln.buyShares * 0.02);
    const avgBuy = ln.buyShares > EPS ? ln.buyCost / ln.buyShares : null;
    const category = catOf(ln.title);
    // Withhold P&L if the buy leg may be incomplete (capped window reached its edge).
    const incomplete = capped && ln.touchesOldest;

    if (ln.sellShares >= EPS && Math.abs(net) <= flatTol) {
      // CLOSED — sold out, net ≈ 0. Realized from fills.
      const avgSell = ln.sellShares > EPS ? ln.sellProceeds / ln.sellShares : null;
      const matchedShares = Math.min(ln.buyShares, ln.sellShares);
      const costBasis = avgBuy != null ? avgBuy * matchedShares : null;
      const proceeds = ln.sellProceeds;
      const pnl = (!incomplete && costBasis != null) ? (proceeds - costBasis) : null;
      positions.push({
        key: ln.key, market: ln.title, slug: ln.slug, eventSlug: ln.eventSlug,
        conditionId: ln.conditionId, asset: ln.asset, outcome: ln.outcome, status: 'closed',
        shares: ln.sellShares, avgEntry: avgBuy, close: avgSell, closeLabel: 'exit (avg sell)',
        costBasis, proceeds, pnl, pnlLabel: incomplete ? 'realized · basis incomplete' : 'realized',
        realized: true,
        roiPct: (pnl != null && costBasis) ? (pnl / costBasis) * 100 : null,
        heldDays: Math.max(0, (ln.lastTs - ln.firstTs) / 86400),
        nFills: ln.nFills, incompleteBasis: incomplete, category,
        lastActivityTs: ln.lastTs,
      });
      if (pnl != null) realizedEvents.push({ t: ln.lastTs, pnl, category, won: pnl > 0 });
    } else if (net > flatTol) {
      // SETTLED — still net-long but gone from the live snapshot. Entry known,
      // settlement outcome unknown → P&L withheld (honest), not fabricated.
      const heldShares = net;
      const costBasis = avgBuy != null ? avgBuy * heldShares : null;
      positions.push({
        key: ln.key, market: ln.title, slug: ln.slug, eventSlug: ln.eventSlug,
        conditionId: ln.conditionId, asset: ln.asset, outcome: ln.outcome, status: 'settled',
        shares: heldShares, avgEntry: avgBuy, close: null, closeLabel: 'settled (outcome n/a)',
        costBasis, proceeds: null, pnl: null,
        pnlLabel: 'held to settlement — outcome not in live data; P&L withheld',
        realized: false, roiPct: null,
        heldDays: Math.max(0, (ln.lastTs - ln.firstTs) / 86400),
        nFills: ln.nFills, incompleteBasis: incomplete, category,
        lastActivityTs: ln.lastTs,
      });
    }
    // else: net < −flatTol (oversold beyond the kept window) → capped-window
    // artifact, skip rather than guess.
  }

  // ── 4. Sort positions: open first, then resolved/closed by recency ──────────
  const statusRank: Record<PosStatus, number> = { open: 0, resolved: 1, settled: 2, closed: 3 };
  positions.sort((a, b) =>
    statusRank[a.status] - statusRank[b.status] ||
    (b.lastActivityTs ?? 0) - (a.lastActivityTs ?? 0));

  // ── 5. Equity curve — cumulative REALIZED P&L over time ─────────────────────
  realizedEvents.sort((a, b) => a.t - b.t);
  let cum = 0;
  const equityCurve: EquityPoint[] = [];
  for (const e of realizedEvents) { cum += e.pnl; equityCurve.push({ t: e.t, cum: round2(cum) }); }

  // ── 6. Category realized P&L + win% ─────────────────────────────────────────
  const catMap = new Map<string, { pnl: number; wins: number; n: number }>();
  for (const e of realizedEvents) {
    const c = catMap.get(e.category) || { pnl: 0, wins: 0, n: 0 };
    c.pnl += e.pnl; c.n++; if (e.won) c.wins++;
    catMap.set(e.category, c);
  }
  const categoryPnl: CategoryPnl[] = Array.from(catMap.entries())
    .map(([category, c]: [string, { pnl: number; wins: number; n: number }]) => ({ category, realizedPnl: round2(c.pnl), winRate: c.n ? (c.wins / c.n) * 100 : null, n: c.n }))
    .sort((a, b) => b.realizedPnl - a.realizedPnl);

  // ── 7. Summary ──────────────────────────────────────────────────────────────
  const openPositions = positions.filter(p => p.status === 'open');
  const realizedPositions = positions.filter(p => p.realized && p.pnl != null);
  const realizedPnl = realizedEvents.length ? round2(realizedEvents.reduce((s, e) => s + e.pnl, 0)) : null;
  const unrealizedPnl = openPositions.some(p => p.pnl != null)
    ? round2(openPositions.reduce((s, p) => s + (p.pnl ?? 0), 0)) : null;
  const costBasisOpen = openPositions.some(p => p.costBasis != null)
    ? round2(openPositions.reduce((s, p) => s + (p.costBasis ?? 0), 0)) : null;
  const realizedWins = realizedPositions.filter(p => (p.pnl ?? 0) > 0).length;

  const summary: TraderSummary = {
    realizedPnl,
    unrealizedPnl,
    costBasisOpen,
    openCount: openPositions.length,
    closedCount: positions.filter(p => p.status === 'closed').length,
    resolvedCount: positions.filter(p => p.status === 'resolved').length,
    settledCount: positions.filter(p => p.status === 'settled').length,
    winRateRealized: realizedPositions.length ? (realizedWins / realizedPositions.length) * 100 : null,
    realizedTrades: realizedPositions.length,
    // True open count: agent30's observed total (capture of ALL genuinely-open
    // positions) when present; else the displayed count. Truncated when more open
    // exist than we display — honest "showing X of Y", never a silent under-count.
    openObserved: Math.max(openPositions.length, rec.openObserved ?? 0),
    openTruncated: !!rec.openCapped || ((rec.openObserved ?? 0) > openPositions.length),
  };

  return { summary, positions, equityCurve, categoryPnl };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

// ── Closed-trade entry→exit enrichment ────────────────────────────────────────
// agent20's aggregate closed-trades ledger reports a REAL realized P&L per market
// but no entry/exit price (the aggregate ledger doesn't pin per-fill prices), so
// the profile's Entry→Exit column shows "— → —". agent30's per-fill feed for the
// SAME wallet DOES have them. This joins the two, by conditionId, to surface:
//   • entry = size-weighted BUY-fill price (real)
//   • exit  = the settlement — 1.0 (100¢) if the outcome won, 0.0 (0¢) if it lost
//            (that IS the real exit for a settled market) — or, for a line closed
//            by SELLING back out, the size-weighted SELL price.
// Duplicate fills (the same on-chain fill re-recorded by the live WS AND a resync,
// stored at slightly different float precision) are deduped by txHash|asset|side|
// size so held shares aren't doubled.
// HONEST-ENGINE: entry/exit are enriched only from REAL fills and the REAL settlement —
// never fabricated, and realized P&L is never touched. Two honest surfacing paths:
//   • EXACT reconcile — (exit−entry)×shares matches the realized P&L agent20 reports
//     (±max($1, 20%)). Required for lines CLOSED BY SELLING, where the exit price is
//     INFERRED from sell fills and an incomplete window would produce a wrong exit.
//   • HELD-TO-SETTLEMENT subset — the exit is a HARD FACT (100¢ won / 0¢ lost), not
//     inferred, and entry is the real size-weighted BUY price. agent30's capped fill
//     window can miss earlier buys of a just-settled position, so the observed fills
//     UNDERSHOOT the ledger P&L. Surface when they are directionally consistent (same
//     sign), do not overstate the ledger, AND cover ≥ ENTRY_EXIT_MIN_COVERAGE of the
//     realized P&L — a sliver that explains too little of the true position stays "—".
// Fills that are absent, contradict the ledger, or fall below the coverage floor stay
// "— → —" (never forced to a match). ENTRY_EXIT_MIN_COVERAGE approved by Diego.
const ENTRY_EXIT_MIN_COVERAGE = 0.50;   // held-to-settlement: min |recon|/|realized| to surface
export interface ClosedEntryExit { entryPrice: number | null; exitPrice: number | null; realizedPnl: number | null; result?: string | null; cid?: string | null }
export function enrichClosedTradesEntryExit(
  trades: ClosedEntryExit[] | null | undefined,
  rec: WalletRecord | null | undefined,
): { surfaced: number; unreconciled: number; noFills: number } {
  const out = { surfaced: 0, unreconciled: 0, noFills: 0 };
  if (!Array.isArray(trades) || trades.length === 0) return out;
  const fills = Array.isArray(rec?.fills) ? rec!.fills : [];

  // Dedup + aggregate buy/sell shares & cost per conditionId.
  const seen = new Set<string>();
  const agg = new Map<string, { bS: number; bC: number; sS: number; sP: number }>();
  for (const f of fills) {
    if (!f || !Number.isFinite(f.price) || !Number.isFinite(f.size)) continue;
    const cid = f.conditionId; if (!cid) continue;
    const sz = Math.abs(f.size);
    if (f.txHash) {
      const dk = `${f.txHash}|${f.asset}|${f.side}|${sz.toFixed(6)}`;
      if (seen.has(dk)) continue;
      seen.add(dk);
    }
    const p = clampP(f.price);
    const a = agg.get(cid) ?? { bS: 0, bC: 0, sS: 0, sP: 0 };
    if (f.side === 'SELL') { a.sS += sz; a.sP += p * sz; }
    else { a.bS += sz; a.bC += p * sz; }   // default BUY
    agg.set(cid, a);
  }

  const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
  for (const t of trades) {
    if (!t || t.entryPrice != null || t.exitPrice != null) continue; // already sourced → leave
    const a = t.cid ? agg.get(t.cid) : undefined;
    if (!a || a.bS < EPS) { out.noFills++; continue; }               // no buy fills in window → honest "—"
    const avgBuy = a.bC / a.bS;
    const net = a.bS - a.sS;
    const realized = typeof t.realizedPnl === 'number' ? t.realizedPnl : null;
    const tol = realized != null ? Math.max(1.0, Math.abs(realized) * 0.20) : Infinity;
    const hasSells = a.sS > Math.max(1, a.bS * 0.02);

    if (hasSells) {
      // Closed by selling back out → exit = size-weighted sell price.
      const avgSell = a.sS > EPS ? a.sP / a.sS : null;
      const matched = Math.min(a.bS, a.sS);
      const recon = a.sP - avgBuy * matched;
      if (avgSell != null && realized != null && Math.abs(recon - realized) <= tol) {
        t.entryPrice = round4(avgBuy); t.exitPrice = round4(avgSell); out.surfaced++;
      } else { out.unreconciled++; }
    } else {
      // Held to settlement → exit = 100¢/0¢ from the resolved outcome (agent20's result).
      // The exit is a hard fact, so we don't need EXACT P&L reconciliation: the capped
      // fill window often misses earlier buys, making the observed P&L a consistent
      // UNDERSHOOT of the ledger. Surface when (a) it exactly reconciles, or (b) the
      // observed fills are same-sign, don't overstate the ledger, and cover ≥ the floor
      // of the realized P&L. Below the floor / opposite-sign / overstating → honest "—".
      const exit = t.result === 'won' ? 1 : (t.result === 'lost' ? 0 : null);
      if (exit == null) { out.unreconciled++; continue; }            // breakeven/ambiguous → honest "—"
      const recon = (exit - avgBuy) * net;
      if (realized != null) {
        const exactOk     = Math.abs(recon - realized) <= tol;
        const sameSign    = (recon >= 0) === (realized >= 0);
        const noOverstate = Math.abs(recon) <= Math.abs(realized) + tol;
        const coverage    = Math.abs(realized) > EPS ? Math.abs(recon) / Math.abs(realized) : 0;
        const subsetOk    = sameSign && noOverstate && coverage >= ENTRY_EXIT_MIN_COVERAGE;
        if (exactOk || subsetOk) {
          t.entryPrice = round4(avgBuy); t.exitPrice = exit; out.surfaced++;
        } else { out.unreconciled++; }
      } else { out.unreconciled++; }
    }
  }
  return out;
}

// One fill in the expandable closed-trade drawer. All values are REAL — sourced
// from the same feed / Data-API fills that back the entry→exit reconciliation.
// `price`/`usd` are null only when redacted for the free tier (never invented).
export interface ClosedFill {
  side:        string | null;    // BUY | SELL
  price:       number | null;    // 0..1 (dollars per share)
  size:        number;           // shares
  usd:         number | null;    // price × size (dollar notional)
  timestamp:   number;           // unix seconds
  secToExpiry: number | null;    // marketEndTs − fill ts; null when market end is unknown
}

// Real market close time for Polymarket's short crypto Up/Down markets, derived
// from the authoritative slug the fill already carries: e.g.
//   "xrp-updown-5m-1783711500" → period start 1783711500 + 5m = 1783711800.
// The trailing epoch is the period START (verified: it maps exactly to the market
// title's ET window); end = start + the slug's own duration token (Nm / Nh / Nd).
// Gamma purges these ephemeral markets within minutes, so the slug — not Gamma —
// is the only durable real source. Returns null (→ honest "expiry unavailable")
// for any slug that doesn't carry a duration+epoch (non-timed markets).
export function marketEndTsFromSlug(slug: string | null | undefined): number | null {
  if (!slug) return null;
  const m = slug.match(/-(\d+)([mhd])-(\d+)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10), start = parseInt(m[3], 10);
  if (!Number.isFinite(n) || !Number.isFinite(start)) return null;
  if (start < 1_000_000_000 || start > 4_000_000_000) return null; // plausible unix-seconds guard
  const durSec = m[2] === 'm' ? n * 60 : m[2] === 'h' ? n * 3600 : n * 86_400;
  return start + durSec;
}

// Attach the real per-fill breakdown (+ market close time) to each closed trade so
// the UI can render an expandable drawer. Joins the SAME deduped fills used for the
// entry→exit reconciliation by conditionId, sorted chronologically (entry → exit),
// and computes time-to-expiry from the real fill ts vs the slug-derived close ts.
// HONEST-ENGINE: only real fills are attached; a row with no matching fills gets
// none (stays non-expandable), and marketEndTs is null (→ "expiry unavailable")
// when the close can't be sourced. No number here feeds P&L / entry→exit — it is
// a pure read-through of the fills that already justify those figures.
export function attachClosedTradeFills(
  trades: Array<ClosedEntryExit & { fills?: ClosedFill[]; marketEndTs?: number | null }> | null | undefined,
  rec: WalletRecord | null | undefined,
): void {
  if (!Array.isArray(trades) || trades.length === 0) return;
  const fills = Array.isArray(rec?.fills) ? rec!.fills : [];

  const byCid    = new Map<string, RawFill[]>();
  const slugByCid = new Map<string, string | null>();
  const seen = new Set<string>();
  for (const f of fills) {
    const cid = f?.conditionId; if (!cid) continue;
    if (!Number.isFinite(f.price) || !Number.isFinite(f.size)) continue;
    const sz = Math.abs(f.size);
    if (f.txHash) {
      const dk = `${f.txHash}|${f.asset}|${f.side}|${sz.toFixed(6)}`;
      if (seen.has(dk)) continue;                     // same dedup as enrich → drawer matches entry→exit
      seen.add(dk);
    }
    let arr = byCid.get(cid); if (!arr) { arr = []; byCid.set(cid, arr); }
    arr.push(f);
    if (!slugByCid.has(cid)) slugByCid.set(cid, f.slug ?? null);
  }

  for (const t of trades) {
    const cid = t.cid; if (!cid) continue;
    const fs = byCid.get(cid); if (!fs || fs.length === 0) continue;
    const endTs = marketEndTsFromSlug(slugByCid.get(cid) ?? null);
    t.marketEndTs = endTs;
    t.fills = fs
      .slice()
      .sort((a, b) => a.timestamp - b.timestamp)      // chronological: entry first
      .map(f => {
        const price = clampP(f.price), size = Math.abs(f.size);
        return {
          side:        f.side ?? null,
          price,
          size,
          usd:         price * size,
          timestamp:   f.timestamp,
          secToExpiry: endTs != null ? endTs - f.timestamp : null,
        };
      });
  }
}
