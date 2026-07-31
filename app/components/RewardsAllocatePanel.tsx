'use client';

// RewardsAllocatePanel — PUBLIC allocation planner for the liquidity-rewards maker.
//
// It reads the operator's real proxy pUSD balance (/api/rewards/balance) and the capital allocation plan
// (/api/rewards/allocate) and displays them, with a PER-MARKET offset control. It PLANS and DISPLAYS ONLY:
// there is no fetch, handler, or import here that constructs, signs, arms or places an order — every
// interactive control below either sets a LOCAL number or GETs one of those two read-only routes. Offset
// changes recompute the row + totals LOCALLY from data the plan already returned (no refetch). No private
// key is ever read, logged or echoed.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { bandStateFor } from '@/app/dashboard/liquidity-rewards/allocate/band-state';

type Balance = {
  proxy: string | null; proxySource: string | null; signer: string | null;
  pusdBalance: number | null; rpcReachable: boolean; readAt: string | null;
  ageSeconds: number | null; stale: boolean; latencyMs: number | null; cadenceSeconds: number; note: string;
};
type FillTick = { tick: number; offsetCents: number | null; fills: number; costPerDay: number | null; bid: number | null; ask: number | null };
// ── THE SECOND, CORRECTED $/day FIGURE ──────────────────────────────────────────────────────────────
// One entry per selectable offset, precomputed server-side (lib/rewards/realistic-estimate.js) so moving a
// row's offset never needs a refetch — the same pattern fillsByTick already uses. `unknown:true` means the
// figure was WITHHELD (e.g. no competing liquidity in band at all), which the UI must render as "non
// stimabile" with its reason, never as $0.00 and never as a small optimistic number.
type Correction = {
  key: string; kind: 'derivata' | 'misurata' | 'assunzione'; label: string;
  factor: number; usd?: number; applied: boolean; measurable: boolean; note: string;
};
type RealisticTick = {
  tick: number; realisticPerDay: number | null; totalFactor: number | null; unknown: boolean;
  reason: string | null; corrections: Correction[] | null;
  flags: { key: string; severity: string; text: string }[]; summary: string;
};
type PoolTrend = {
  measurable: boolean; ratio: number | null; discountFactor: number;
  direction: 'up' | 'flat' | 'down' | null; samples: number;
  currentPool: number | null; meanPool: number | null; note: string;
};
type Row = {
  marketId: string; name: string | null; category: string | null; nameAvailable: boolean; shortId: string;
  capital: number; sizePerSideUsd: number; sizePerSideShares: number | null;
  tick: number | null; mid: number | null; depthShares: number | null; newestTsMs: number | null;
  endDate: string | null;
  maxSpreadCents: number | null; grossInBandPerDay: number | null; defaultOffsetTicks: number;
  computedDefaultOffsetTicks: number; defaultReason: string; defaultNetDerived: boolean; grossMaxDefaultTicks: number;
  fillScore: number | null; fillsByTick: FillTick[];
  realisticByTick: RealisticTick[]; realisticBestTick: number | null; realisticBestPerDay: number | null;
  poolTrend: PoolTrend;
};
type Plan = {
  requested: number; capital: number; unit: number; offsetCents: number;
  coverage: { coveredMarketCount: number | null; truePct: number | null; trueNote: string; headerLines: string[] };
  staleFrac: number; rows: Row[];
  observed: { totalFills: number; filledMarkets: number; windowHours: number };
  fillScore: { auc: number | null; ci95: [number, number] | null; nFilled: number; nUnfilled: number; note: string };
  offsetFrontier: { offsetCents: number; fills: number; grossInBand: number; rewardLost: number }[];
  totals: {
    capital: number; unallocated: number; grossPerDay: number; netPerDay: number | null; count: number;
    realisticPerDay: number | null; realisticRatio: number | null; realisticRowsUnknown: number | null;
  };
  annualisedGross: { pct: number | null; capped: boolean; cap: number; label: string };
  annualisedRealistic: { pct: number | null; capped: boolean; cap: number; label: string };
  frontier: { count: number; net: number }[];
  error?: string;
};

const money = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '—' : `$${v.toFixed(2)}`);
const shares = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(1));
const price = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(3));
const perDay = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '—' : `$${v.toFixed(2)}/g`);
const cents = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(v < 1 ? 2 : 1)}¢`);
const trunc = (a: string | null): string => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');
const ageText = (s: number | null): string => (s == null ? '—' : s < 90 ? `${s}s fa` : s < 5400 ? `${Math.round(s / 60)} min fa` : `${(s / 3600).toFixed(1)} h fa`);
const FRONTIER_MARKS = [1, 2, 3, 5, 10, 20];
const STORE_KEY = 'edgeradar-alloc-offsets-v1'; // per-capital offset map, browser-local display preference
// Freshness: the mid-history sampler writes each SUBSCRIBED market every ~60-90s; a row older than 5 min has
// missed several cycles → it is not in agent34's live subscription and its mid/depth predate the current book.
const STALE_S = 300;
const CLOCK_MS = 15_000;   // re-tick per-row data age locally (no refetch) so staleness is always current
const REFRESH_MS = 180_000; // re-fetch the whole plan; the recompute costs ~19s, matched to the route's cache TTL
const freshAge = (s: number): string => (s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const NEAR_RES_DAYS = 15; // within 15d the price moves on real news, not noise — the character of a fill changes
// Four band states, each with a TEXT label (never colour alone — phone-in-sunlight / colour-blind must get it).
const BAND_LABEL: Record<string, string> = { comfortable: 'in banda', edge: 'al bordo', out: 'fuori banda', unknown: 'banda ignota' };
const BAND_BORDER: Record<string, string> = { comfortable: '3px solid transparent', edge: '3px solid #d9a441', out: '3px solid #d1495b', unknown: '3px dashed #8a8f98' };
// Days until resolution from the market's public endDate; null (never inferred) when endDate is missing/unparseable.
const daysToRes = (endDate: string | null, now: number): number | null => {
  if (!endDate) return null;
  const t = Date.parse(endDate);
  return Number.isFinite(t) ? (t - now) / 86_400_000 : null;
};

// Recompute one row at `offsetTicks` from data the plan already returned — no refetch, no reimplemented tick
// math (bid/ask/fills/cost were snapped server-side per tick). Band-honest: out of band earns ZERO.
function rowAt(r: Row, offsetTicks: number) {
  const ft = r.fillsByTick.find((x) => x.tick === offsetTicks) || null;
  const offsetCents = r.tick != null ? offsetTicks * r.tick * 100 : null;
  const bandKnown = r.maxSpreadCents != null;
  const inBand = bandKnown && offsetCents != null ? offsetCents <= r.maxSpreadCents! / 2 + 1e-9 : null;
  const gross = r.grossInBandPerDay == null ? null : (inBand === false ? 0 : r.grossInBandPerDay);
  const fills = ft ? ft.fills : null;
  const cost = ft ? ft.costPerDay : null;
  const net = fills != null && fills > 0 && gross != null && cost != null ? gross - cost : null;
  const orderVsDepth = r.sizePerSideShares != null && r.depthShares != null && r.depthShares > 0 ? r.sizePerSideShares / r.depthShares : null;
  // The corrected figure for THIS offset — looked up, never recomputed here. The corrections it applies
  // (placement score, pool trend, thin book, coverage gaps, adverse selection) are arithmetic the server
  // already did; re-deriving any of it in the browser would be a second implementation that can drift.
  const real = (r.realisticByTick || []).find((x) => x.tick === offsetTicks) || null;
  return {
    offsetTicks, offsetCents, bid: ft ? ft.bid : null, ask: ft ? ft.ask : null, inBand, bandKnown,
    gross, fills, cost, net, orderVsDepth, real,
    overridden: offsetTicks !== r.computedDefaultOffsetTicks,
    maxTick: r.fillsByTick.length ? r.fillsByTick[r.fillsByTick.length - 1].tick : 0,
  };
}

/** The corrections, as one plain-text block for the cell's tooltip. Each line says whether it is derived
 *  arithmetic, a measurement, or a declared assumption — an operator weighing a number needs to know which. */
function correctionsTooltip(real: RealisticTick | null): string {
  if (!real) return 'stima corretta non disponibile per questo offset';
  if (real.unknown) return `NON STIMABILE — ${real.reason ?? 'motivo non disponibile'}`;
  const kindLabel: Record<string, string> = { derivata: 'calcolo', misurata: 'misurato', assunzione: 'ASSUNZIONE' };
  const lines = (real.corrections ?? [])
    .map((c) => `• [${kindLabel[c.kind] ?? c.kind}] ${c.label}: ${c.applied ? `×${c.factor}${c.usd != null && c.usd > 0 ? ` (−$${c.usd.toFixed(2)}/g)` : ''}` : 'nessuna correzione'}\n   ${c.note}`);
  return [
    `${real.summary}`,
    '',
    ...lines,
    '',
    'Resta una STIMA, non una garanzia: le voci marcate ASSUNZIONE non sono misurate.',
  ].join('\n');
}

// ── RICERCA MERCATI SENZA FILTRO ─────────────────────────────────────────────────────────────────────
// Il piano qui sopra copre SOLO i mercati con montepremi: nasce dal board reward, che agent24 costruisce
// filtrando su rewardsDailyRate > 0. Questa sezione interroga il venue direttamente e mostra TUTTO quello
// che trova — con o senza reward — perché la scelta manuale sia informata e non cieca. Per ogni riga:
// reward $/g (o «NESSUN REWARD»), spread attuale, tick, e quanto manca alla chiusura (che decide la
// finestra GTD dell'ordine e se il mercato è già sotto la soglia di non-piazzamento).
type SearchRow = {
  marketId: string; question: string | null; slug: string | null; endDate: string | null;
  minutesToClose: number | null; rewardsDailyRate: number | null; hasRewards: boolean;
  rewardLabel: string; spreadCents: number | null; tick: number | null;
  rewardsMaxSpreadCents: number | null; negRisk: boolean | null;
  bestBid: number | null; bestAsk: number | null; mid: number | null;
  closed: boolean; acceptingOrders: boolean;
  enabled: boolean; optedIn: boolean; catalogued: boolean; tooCloseToClose: boolean;
};
type SearchResp = {
  ok: boolean; error: string | null; query: string; count: number; markets: SearchRow[];
  withRewards: number; withoutRewards: number; minMinutesToClose: number; globalAutoRepriceEnabled: boolean;
};
type EnableResp = {
  ok: boolean; preview: boolean; action: string; marketId: string; error?: string; gate?: string;
  summary?: {
    question: string | null; rewardsDailyRate: number | null; hasRewards: boolean; rewardLabel: string;
    spreadCents: number | null; tick: number | null; minutesToClose: number | null;
    window: { ttlSeconds: number; refreshMarginSeconds: number | null; minutesToClose: number | null; minMinutes: number; tooClose: boolean; gate: string | null; reason: string };
    capitalUsd: number | null; marketCountBefore: number; marketCountAfter: number;
    alreadyEnabled: boolean; manualModeActive: boolean; willTakeManual: boolean; warnings: string[];
  };
  writes?: string[]; note?: string; warnings?: string[];
  enabledBefore?: string[]; enabledAfter?: string[];
};
const closeText = (min: number | null): string => {
  if (min == null) return 'scadenza ignota';
  if (min < 0) return `chiuso da ${Math.abs(min) < 90 ? `${Math.round(Math.abs(min))} min` : `${(Math.abs(min) / 60).toFixed(1)} h`}`;
  if (min < 90) return `${Math.round(min)} min`;
  if (min < 2880) return `${(min / 60).toFixed(1)} h`;
  return `${(min / 1440).toFixed(1)} g`;
};

// ── ESECUZIONE DELL'ALLOCAZIONE ── una riga per ordine, con il verdetto di ciascuna.
type BulkRowResult = {
  marketId: string; title: string | null; book: string; side: string; price: number; size: number;
  index?: number; status: 'placed' | 'refused' | 'skipped'; notionalUsd?: number | null;
  sent?: boolean; orderId?: string | null; gate?: string | null; reason?: string;
};
type BulkResult = {
  ok: boolean; at: string; attempted: number; placed: number; refused: number; skipped: number;
  stoppedBy: string | null; reason: string | null; results: BulkRowResult[];
  totals: { requestedUsd: number; placedUsd: number; rows: number };
  openBefore?: number | null; error?: string;
};

export default function RewardsAllocatePanel() {
  const [bal, setBal] = useState<Balance | null>(null);
  const [balLoaded, setBalLoaded] = useState(false);
  const [capital, setCapital] = useState<string>(''); // operator's typed value — NEVER rewritten by us
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [touched, setTouched] = useState(false);
  const [offsets, setOffsets] = useState<Record<string, number>>({}); // per-market offset override, in ticks
  const [recomputeMs, setRecomputeMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now()); // ticks CLOCK_MS → live per-row data age, no refetch
  const [refreshMs, setRefreshMs] = useState<number | null>(null); // measured latency of the last auto-refresh fetch
  const [lastRefreshMs, setLastRefreshMs] = useState<number | null>(null);
  // Esecuzione: preview → conferma → run. Tre stati distinti perche' il passo intermedio (la conferma
  // con capitale e numero di mercati) e' esattamente cio' che impedisce di piazzare un'allocazione
  // guardata di sfuggita.
  const [bulkPreview, setBulkPreview] = useState<BulkResult | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [bulkBusy, setBulkBusy] = useState<'preview' | 'run' | null>(null);
  const [bulkErr, setBulkErr] = useState<string | null>(null);
  // Ricerca mercati SENZA filtro reward + aggiunta manuale, anch'essa a due passi (anteprima → conferma).
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SearchResp | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [addPreview, setAddPreview] = useState<EnableResp | null>(null);
  const [addResult, setAddResult] = useState<EnableResp | null>(null);
  const [addBusy, setAddBusy] = useState<string | null>(null);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [takeManual, setTakeManual] = useState(true);

  // Live age clock — re-render every CLOCK_MS so each row's "letto Xs fa" and STALE badge stay true, WITHOUT
  // refetching any market data. Cheap: only re-derives ages from newestTsMs already in the plan.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), CLOCK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let alive = true;
    fetch('/api/rewards/balance').then((r) => r.json()).then((b: Balance) => {
      if (!alive) return; setBal(b); setBalLoaded(true);
      if (!touched && b.pusdBalance != null) setCapital(String(b.pusdBalance));
    }).catch(() => { if (alive) setBalLoaded(true); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const compute = useCallback((cap: string) => {
    const n = Number(cap);
    if (!Number.isFinite(n) || n <= 0) { setPlan(null); return; }
    setLoading(true);
    fetch(`/api/rewards/allocate?capital=${encodeURIComponent(cap)}`)
      .then((r) => r.json())
      .then((p: Plan) => {
        setPlan(p);
        // restore the persisted per-market offset map for THIS capital (a display preference, deterministic)
        let restored: Record<string, number> = {};
        try { const all = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); restored = all[String(p.capital)] || {}; } catch { /* no store */ }
        setOffsets(restored);
      })
      .catch(() => setPlan({ error: 'errore' } as any)).finally(() => setLoading(false));
  }, []);

  // AUTO-REFRESH: re-fetch the plan for the SAME (already-computed) capital, updating ONLY the plan — it never
  // touches the operator's typed capital or their per-market offset overrides, so both survive every cycle.
  const refreshPlan = useCallback((cap: string) => {
    const n = Number(cap);
    if (!Number.isFinite(n) || n <= 0) return;
    const t0 = performance.now();
    fetch(`/api/rewards/allocate?capital=${encodeURIComponent(cap)}`)
      .then((r) => r.json())
      .then((p: Plan) => { if (p && !p.error) { setPlan(p); setRefreshMs(performance.now() - t0); setLastRefreshMs(Date.now()); } })
      .catch(() => { /* keep the last good plan on a failed refresh */ });
  }, []);

  useEffect(() => {
    if (!plan || plan.error || !(plan.capital > 0)) return;
    const cap = String(plan.capital);
    const id = setInterval(() => refreshPlan(cap), REFRESH_MS);
    return () => clearInterval(id);
    // key ONLY on capital so the interval is not torn down/recreated on every refresh (which would reset the timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan?.capital, plan?.error, refreshPlan]);

  // PERSIST the per-market offset map, keyed by capital, in the browser (localStorage). It is a DISPLAY
  // preference — reproducible (same capital + same map ⇒ same allocation), never an order or a trade signal.
  useEffect(() => {
    if (typeof window === 'undefined' || !plan || plan.error) return;
    try { const all = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); all[String(plan.capital)] = offsets; localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* storage unavailable */ }
  }, [offsets, plan]);

  const effTicks = useCallback((r: Row) => (offsets[r.marketId] ?? r.computedDefaultOffsetTicks), [offsets]);

  // set one row's offset (local recompute only — measured); NEVER refetches market data
  const setRowOffset = useCallback((marketId: string, ticks: number) => {
    const t0 = performance.now();
    setOffsets((o) => ({ ...o, [marketId]: ticks }));
    setRecomputeMs(performance.now() - t0);
  }, []);
  const resetRow = useCallback((marketId: string) => setOffsets((o) => { const n = { ...o }; delete n[marketId]; return n; }), []);
  const setAll = useCallback((ticks: number) => { if (!plan) return; const t0 = performance.now(); setOffsets(Object.fromEntries(plan.rows.map((r) => [r.marketId, ticks]))); setRecomputeMs(performance.now() - t0); }, [plan]);
  // widen every row by ONE tick from its current offset (default or override) — local recompute only
  const widenAll = useCallback(() => { if (!plan) return; const t0 = performance.now(); setOffsets((o) => Object.fromEntries(plan.rows.map((r) => [r.marketId, (o[r.marketId] ?? r.computedDefaultOffsetTicks) + 1]))); setRecomputeMs(performance.now() - t0); }, [plan]);
  const resetAll = useCallback(() => setOffsets({}), []);

  // recompute all rows + totals at the current offsets (memoised — the "no visible stall" path). Each row also
  // carries its LIVE data age; STALE rows (past STALE_S) and UNREADABLE rows (no mid/tick/sample) are shown with
  // their true age but EXCLUDED from the totals and counted — never shown as current, never defaulted to zero.
  const computed = useMemo(() => {
    if (!plan) return null;
    const rows = plan.rows.map((r) => {
      const c = rowAt(r, offsets[r.marketId] ?? r.computedDefaultOffsetTicks);
      const ageS = r.newestTsMs != null ? Math.max(0, (nowMs - r.newestTsMs) / 1000) : null;
      const unreadable = r.mid == null || r.tick == null || r.newestTsMs == null;
      const stale = !unreadable && ageS != null && ageS > STALE_S;
      const dRes = daysToRes(r.endDate, nowMs);
      // S=1 ceiling artifact: an offset WIDER than the computed default whose gross is unchanged/improved. The
      // replay's gross doesn't model within-band score decay, so widening only LOOKS free/better here.
      const cDef = rowAt(r, r.computedDefaultOffsetTicks);
      const wider = (offsets[r.marketId] ?? r.computedDefaultOffsetTicks) > r.computedDefaultOffsetTicks;
      const artifact = wider && c.gross != null && cDef.gross != null && c.gross >= cDef.gross - 1e-9;
      // Band-edge state at the CURRENT offset + what the NEXT +1 step would do (pre-emptive warning input).
      const eff = offsets[r.marketId] ?? r.computedDefaultOffsetTicks;
      const band = bandStateFor(r.maxSpreadCents, r.tick, eff);
      const nextBand = bandStateFor(r.maxSpreadCents, r.tick, eff + 1);
      const nextStepLeaves = band.state !== 'unknown' && band.state !== 'out' && nextBand.state === 'out';
      const nextStepCost = nextStepLeaves && c.gross != null ? c.gross - (rowAt(r, eff + 1).gross ?? 0) : null;
      return { r, c, ageS, unreadable, stale, usable: !unreadable && !stale, dRes, artifact, band, nextStepLeaves, nextStepCost };
    });
    const resDist = rows.reduce((d, x) => {
      if (x.dRes == null) d.unknown++; else if (x.dRes < NEAR_RES_DAYS) d.near++; else if (x.dRes <= 90) d.mid++; else d.long++;
      return d;
    }, { near: 0, mid: 0, long: 0, unknown: 0 });
    const usable = rows.filter((x) => x.usable);
    const grossNow = usable.reduce((s, x) => s + (x.c.gross ?? 0), 0);
    const grossDefault = usable.reduce((s, x) => s + (rowAt(x.r, x.r.computedDefaultOffsetTicks).gross ?? 0), 0);
    const grossWider = usable.reduce((s, x) => s + (rowAt(x.r, (offsets[x.r.marketId] ?? x.r.computedDefaultOffsetTicks) + 1).gross ?? 0), 0);
    const fillsNow = usable.reduce((s, x) => s + (x.c.fills ?? 0), 0);
    const netKnown = usable.length > 0 && usable.every((x) => x.c.net != null);
    const netNow = netKnown ? usable.reduce((s, x) => s + (x.c.net ?? 0), 0) : null;
    // ── THE REALISTIC TOTAL at the CURRENT offsets. Rows whose corrected figure was WITHHELD are excluded
    //    and COUNTED — adding them as zero would understate, and adding their gross would defeat the point.
    //    Either way the count is displayed, so the total is never read as covering more than it does.
    const realRows = usable.filter((x) => x.c.real && !x.c.real.unknown && x.c.real.realisticPerDay != null);
    const realisticNow = realRows.reduce((s, x) => s + (x.c.real!.realisticPerDay ?? 0), 0);
    const realisticUnknownCount = usable.length - realRows.length;
    const realisticGrossOfCounted = realRows.reduce((s, x) => s + (x.c.gross ?? 0), 0);
    const ages = rows.map((x) => x.ageS).filter((a): a is number => a != null);
    return {
      rows, grossNow, grossDefault, grossWider, fillsNow, netNow,
      realisticNow, realisticUnknownCount, realisticGrossOfCounted,
      anyOverride: Object.keys(offsets).length > 0,
      staleCount: rows.filter((x) => x.stale).length, unreadableCount: rows.filter((x) => x.unreadable).length,
      usableCount: usable.length, newestAge: ages.length ? Math.min(...ages) : null, oldestAge: ages.length ? Math.max(...ages) : null,
      resDist, artifactCount: rows.filter((x) => x.artifact).length,
      // Largest per-market gross among the rows that COUNT (usable ones). It is only the bar's scale —
      // the bar is a reading aid for the $/g already in the cell, never a second number. Rows excluded
      // from the totals (stale/unreadable) get no bar rather than a bar drawn to a scale they are not in.
      maxGross: usable.reduce((m, x) => Math.max(m, x.c.gross ?? 0), 0),
      widenAllLeaves: rows.filter((x) => x.usable && x.nextStepLeaves).length, // rows a global +1 would push OUT
      bandCounts: rows.reduce((b, x) => { b[x.band.state] = (b[x.band.state] || 0) + 1; return b; }, { comfortable: 0, edge: 0, out: 0, unknown: 0 } as Record<string, number>),
      grossAllInBand: usable.reduce((s, x) => s + (x.r.grossInBandPerDay ?? 0), 0), // every row quoting INSIDE its band
    };
  }, [plan, offsets, nowMs]);

  // Le righe da eseguire, prese ESATTAMENTE dalla tabella come e' configurata adesso: stesso mercato,
  // stesso lato, stesso prezzo, stessa size che l'operatore sta guardando. Escluse le righe stale o
  // illeggibili (non sono nei totali) e quelle fuori banda (varrebbero zero).
  const bulkRows = useMemo(() => {
    if (!computed) return [];
    return computed.rows
      .filter((x) => x.usable && x.c.inBand !== false && x.c.bid != null && x.r.sizePerSideShares != null)
      .map((x) => ({
        marketId: x.r.marketId,
        title: x.r.name || x.r.shortId,
        book: 'yes' as const,
        price: x.c.bid as number,
        size: Math.round((x.r.sizePerSideShares as number) * 10) / 10,
      }));
  }, [computed]);

  const runBulk = useCallback(async (preview: boolean) => {
    if (!bulkRows.length) return;
    setBulkBusy(preview ? 'preview' : 'run');
    setBulkErr(null);
    if (!preview) setBulkResult(null);
    try {
      const r = await fetch('/api/maker/manual/bulk-allocate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: bulkRows, preview }),
      });
      const b = (await r.json()) as BulkResult;
      if (preview) setBulkPreview(b); else { setBulkResult(b); setBulkPreview(null); }
    } catch (e) {
      setBulkErr((e as Error).message);
    } finally { setBulkBusy(null); }
  }, [bulkRows]);

  const balanceNum = bal && bal.pusdBalance != null ? bal.pusdBalance : null;
  const capitalNum = Number(capital);
  const overBalance = balanceNum != null && Number.isFinite(capitalNum) && capitalNum > balanceNum;

  // ── RICERCA SENZA FILTRO. Nessun mercato viene nascosto perché non paga reward: quelli senza
  //    montepremi compaiono come tutti gli altri, con l'etichetta che lo dice. ──
  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setSearchBusy(true); setSearchErr(null); setAddPreview(null); setAddResult(null);
    try {
      const r = await fetch(`/api/maker/markets/search?q=${encodeURIComponent(q)}&limit=20`);
      const b = (await r.json()) as SearchResp;
      setSearch(b);
      if (!b.ok && b.error) setSearchErr(b.error);
    } catch (e) { setSearchErr((e as Error).message); }
    finally { setSearchBusy(false); }
  }, [query]);

  // Passo 1 dell'aggiunta: ANTEPRIMA. Rilegge il mercato dal venue e dice esattamente cosa verrebbe
  // scritto — senza scrivere nulla. Passo 2: conferma (preview:false), che è l'unica cosa che scrive.
  const addMarket = useCallback(async (marketId: string, preview: boolean) => {
    setAddBusy(`${preview ? 'preview' : 'confirm'}:${marketId}`); setAddErr(null);
    if (!preview) setAddResult(null);
    try {
      const cap = Number(capital);
      const r = await fetch('/api/maker/markets/enable', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketId, preview, enabled: true, takeManual,
          capitalUsd: Number.isFinite(cap) && cap > 0 ? cap : undefined,
        }),
      });
      const b = (await r.json()) as EnableResp;
      if (preview) { setAddPreview(b); setAddResult(null); }
      else {
        setAddResult(b); setAddPreview(null);
        if (b.ok) runSearch();   // ricarica la lista: la riga appena abilitata deve dirlo da sola
      }
      if (!b.ok && (b.error || b.gate)) setAddErr(b.error || `rifiutato: ${b.gate}`);
    } catch (e) { setAddErr((e as Error).message); }
    finally { setAddBusy(null); }
  }, [capital, takeManual, runSearch]);

  return (
    <div className="alloc-root">
      <style>{`
        .alloc-root{color:var(--ds-text);max-width:1040px;margin:0 auto;padding:16px 12px 48px;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
        .alloc-card{background:color-mix(in srgb,var(--ds-text) 3%,transparent);border:1px solid var(--ds-border);border-radius:12px;padding:14px 16px;margin:12px 0}
        .alloc-h{font-weight:600;font-size:18px;margin:0 0 4px}
        .alloc-sub{color:color-mix(in srgb,var(--ds-text) 55%,transparent);font-size:12.5px}
        .alloc-addr{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
        .alloc-in{font:16px ui-monospace,monospace;background:var(--ds-bg);color:var(--ds-text);border:1px solid var(--ds-border);border-radius:8px;padding:10px 12px;width:180px;min-height:44px}
        .alloc-btn{min-height:44px;min-width:44px;padding:8px 14px;border-radius:8px;border:1px solid var(--ds-border);background:color-mix(in srgb,var(--ds-accent) 14%,transparent);color:var(--ds-text);font-weight:600;cursor:pointer}
        .alloc-note{border-left:3px solid var(--ds-accent);padding:8px 12px;margin:10px 0;background:color-mix(in srgb,var(--ds-accent) 8%,transparent);border-radius:0 8px 8px 0;font-size:13px}
        .alloc-warn{border-left-color:#d9a441;background:color-mix(in srgb,#d9a441 12%,transparent)}
        .alloc-tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--ds-border);border-radius:10px}
        table.alloc{border-collapse:collapse;width:100%;min-width:1360px;font-size:13px}
        table.alloc th,table.alloc td{padding:8px 10px;border-bottom:1px solid var(--ds-border);text-align:right;white-space:nowrap}
        table.alloc th{position:sticky;top:0;background:var(--ds-bg);font-weight:600;color:color-mix(in srgb,var(--ds-text) 70%,transparent);font-size:11.5px;text-transform:uppercase;letter-spacing:.03em}
        table.alloc td.name,table.alloc th.name{text-align:left;white-space:normal;min-width:170px}
        table.alloc td.dash{color:color-mix(in srgb,var(--ds-text) 45%,transparent)}
        .alloc-cat{color:color-mix(in srgb,var(--ds-text) 50%,transparent);font-size:11.5px}
        .alloc-sum{display:flex;flex-wrap:wrap;gap:14px 26px;margin-top:10px}
        .alloc-sum div span{display:block;color:color-mix(in srgb,var(--ds-text) 55%,transparent);font-size:11.5px}
        .alloc-sum div b{font-size:17px;font-variant-numeric:tabular-nums}
        .alloc-front{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
        .alloc-chip{font-variant-numeric:tabular-nums;font-size:12px;border:1px solid var(--ds-border);border-radius:999px;padding:3px 9px;white-space:nowrap}
        .alloc-basis{border:1px solid var(--ds-accent);border-radius:12px;padding:12px 16px;margin:14px 0;background:color-mix(in srgb,var(--ds-accent) 7%,transparent)}
        .alloc-basis-h{font-weight:700;font-size:14px;letter-spacing:.02em;margin-bottom:6px}
        .alloc-basis-ul{margin:0;padding-left:18px}.alloc-basis-ul li{margin:5px 0;font-size:13px;line-height:1.5}
        .off-ctl{display:inline-flex;align-items:center;gap:4px;justify-content:flex-end}
        .off-step{min-width:44px;min-height:44px;padding:0;border-radius:8px;border:1px solid var(--ds-border);background:color-mix(in srgb,var(--ds-accent) 10%,transparent);color:var(--ds-text);font-size:18px;font-weight:700;cursor:pointer;line-height:1}
        .off-val{min-width:74px;text-align:center;font-variant-numeric:tabular-nums}
        .off-val b{font-size:14px}.off-val small{display:block;font-size:11px;color:color-mix(in srgb,var(--ds-text) 55%,transparent)}
        .off-reset{min-width:34px;min-height:44px;border:none;background:transparent;color:color-mix(in srgb,var(--ds-text) 55%,transparent);cursor:pointer;font-size:15px}
        .off-over{color:#d9a441;font-weight:700}
        .oob{color:#d98a41;font-weight:600}
        .fresh-ok{color:#4c9a6a}
        .fresh-stale{color:#d98a41;font-weight:700}
        .band-badge{display:inline-block;font-size:11px;font-weight:700;padding:1px 7px;border-radius:6px;border:1px solid;white-space:nowrap}
        .band-comfortable{color:#4c9a6a;border-color:color-mix(in srgb,#4c9a6a 45%,transparent);background:color-mix(in srgb,#4c9a6a 10%,transparent)}
        .band-edge{color:#b9791f;border-color:#d9a441;background:color-mix(in srgb,#d9a441 16%,transparent)}
        .band-out{color:#d1495b;border-color:#d1495b;background:color-mix(in srgb,#d1495b 14%,transparent)}
        .band-unknown{color:#8a8f98;border:1px dashed #8a8f98;background:transparent}
        .band-room{display:block;font-size:11px;color:color-mix(in srgb,var(--ds-text) 55%,transparent);margin-top:2px;white-space:nowrap}
        .step-danger{border-color:#d1495b !important;color:#d1495b !important;background:color-mix(in srgb,#d1495b 12%,transparent) !important}
        .fresh-bar{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;font-size:12px;margin:2px 0 8px;color:color-mix(in srgb,var(--ds-text) 60%,transparent)}
        .gross-bar{display:block;height:4px;min-width:48px;border-radius:999px;margin-top:4px;background:color-mix(in srgb,var(--ds-text) 10%,transparent);overflow:hidden}
        .gross-bar i{display:block;height:100%;border-radius:999px;background:#2E5FBE}
        .fresh-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:baseline}
        /* Etichetta TESTUALE (mai solo colore): un mercato senza montepremi va letto come tale anche su
           uno schermo al sole o da chi non distingue i colori. */
        .no-reward-badge{display:inline-block;margin-top:3px;font-size:11px;font-weight:700;letter-spacing:.02em;padding:1px 7px;border-radius:6px;color:#b9791f;border:1px solid #d9a441;background:color-mix(in srgb,#d9a441 16%,transparent);white-space:normal}
        @media(max-width:430px){.alloc-in{width:44vw}}
      `}</style>

      <h1 className="alloc-h">Allocazione capitale · liquidity rewards</h1>
      <p className="alloc-sub">Inserisci un capitale: l’ottimizzatore lo distribuisce sui mercati con la dimensione per-mercato corretta (knapsack sulla profondità reale in-band e sul pot), non in parti uguali. L’offset è ora regolabile per singolo mercato — leva diretta sull’essere riempiti.</p>

      <div className="alloc-basis" data-alloc-basis>
        <div className="alloc-basis-h">Cos’è questa pagina — e cosa NON è</div>
        <ul className="alloc-basis-ul">
          <li><b>È un piano calcolato su dati osservati, non un ordine.</b> Nessun ordine viene creato, firmato o inviato guardando o usando questa pagina, incluso il controllo dell’offset. Non viene mosso alcun capitale.</li>
          <li><b>Le cifre sono LORDE.</b> L’adverse selection è misurata a parte: il netto è “—” dove non è stato osservato un fill reale. Non sommare il lordo come rendimento.</li>
          <li data-alloc-disclaimer-counts><b>Il campione osservato è piccolo:</b> copertura ~{plan && plan.coverage.truePct != null ? plan.coverage.truePct : '20'}% dell’universo reward collezionabile{plan && plan.observed ? <>, su una finestra di <b>{plan.observed.windowHours.toFixed(1)} ore</b>, con <b>{plan.observed.totalFills} fill osservati nel tape su {plan.observed.filledMarkets} mercati distinti</b> con almeno un fill</> : <> su ~48h</>}. (I «11 fill su 4 mercati» descrivevano solo l’allocazione $5.000, non l’intero tape.) Il comportamento di riempimento per-mercato resta statisticamente esile.</li>
          <li><b>I pot dei reward si muovono.</b> Durante lo studio il lordo è sceso del <b>36% in due giorni</b>. Nessuna cifra qui è garantita: run-rate, non una promessa.</li>
        </ul>
      </div>

      {/* PROXY / BALANCE */}
      <div className="alloc-card" data-alloc-balance>
        <div className="alloc-h" style={{ fontSize: 15 }}>Saldo reale del proxy (funder)</div>
        {!balLoaded ? <div className="alloc-sub">lettura on-chain…</div> : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 20px', alignItems: 'baseline' }}>
              <div>
                <span className="alloc-sub">saldo pUSD </span>
                {bal && bal.pusdBalance != null
                  ? <b style={{ fontSize: 20, fontVariantNumeric: 'tabular-nums' }} data-alloc-balance-value>{money(bal.pusdBalance)}</b>
                  : <b style={{ fontSize: 20, color: 'color-mix(in srgb,var(--ds-text) 45%,transparent)' }} data-alloc-balance-unknown>—</b>}
                {bal && bal.pusdBalance === 0 && <span className="alloc-sub"> · zero reale (letto on-chain, non sconosciuto)</span>}
                {bal && bal.pusdBalance == null && <span className="alloc-sub"> · sconosciuto (RPC non raggiungibile), non zero</span>}
              </div>
              <div className="alloc-sub">letto {ageText(bal?.ageSeconds ?? null)}{bal?.stale ? ' · NON aggiornato (valore precedente)' : ''}</div>
            </div>
            <div className="alloc-sub" style={{ marginTop: 6 }}>
              <span className="alloc-addr">funder (proxy): {trunc(bal?.proxy ?? null)}</span>{' · '}
              <span className="alloc-addr">signer (firma, non detiene fondi): {trunc(bal?.signer ?? null)}</span>
            </div>
          </>
        )}
      </div>

      {/* CAPITAL INPUT */}
      <div className="alloc-card">
        <label className="alloc-sub" htmlFor="alloc-cap">Capitale da allocare (USD)</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
          <input id="alloc-cap" className="alloc-in" inputMode="decimal" value={capital} data-alloc-capital-input
            onChange={(e) => { setTouched(true); setCapital(e.target.value.replace(/[^0-9.]/g, '')); }}
            onKeyDown={(e) => { if (e.key === 'Enter') compute(capital); }} placeholder="es. 5000" />
          <button className="alloc-btn" data-alloc-compute onClick={() => compute(capital)}>Calcola</button>
          <button className="alloc-btn" style={{ background: 'transparent' }} disabled={balanceNum == null}
            data-alloc-usefull onClick={() => { setTouched(true); if (balanceNum != null) { setCapital(String(balanceNum)); compute(String(balanceNum)); } }}>
            Usa saldo intero{balanceNum != null ? ` (${money(balanceNum)})` : ''}
          </button>
        </div>
        {overBalance && (
          <div className="alloc-note alloc-warn" data-alloc-overbalance>
            Il capitale richiesto (<b>{money(capitalNum)}</b>) supera il saldo reale del proxy (<b>{money(balanceNum)}</b>).
            Il valore inserito resta esattamente com’è: è un’ipotesi di piano, non viene ridotto.
          </div>
        )}
      </div>

      {/* ── CERCA E AGGIUNGI UN MERCATO — RICERCA SENZA FILTRO ────────────────────────────────────────
          Il piano qui sotto copre solo i mercati con montepremi (è un piano di liquidity rewards). Questa
          ricerca interroga il venue e mostra TUTTO: se un mercato non paga reward compare lo stesso, con
          l'etichetta «NESSUN REWARD — solo trading direzionale», così la scelta è informata. Aggiungere
          un mercato NON piazza nulla: lo rende ammissibile ai gate, che restano tutti in vigore. */}
      <div className="alloc-card" data-alloc-search>
        <div className="alloc-h" style={{ fontSize: 15 }}>Cerca un mercato (ricerca senza filtro)</div>
        <div className="alloc-sub">
          Cerca per testo o incolla un <b>conditionId</b> (0x…). Nessun filtro sui reward: i mercati
          <b> senza montepremi</b> sono elencati come tutti gli altri e segnalati come tali. Ogni riga mostra
          <b> reward $/g</b>, <b>spread attuale</b>, <b>tick</b> e quanto manca alla chiusura.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <input className="alloc-in" style={{ width: 320 }} value={query} data-alloc-search-input
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
            placeholder="es. bitcoin up or down · harry kane · 0x…" />
          <button className="alloc-btn" data-alloc-search-go onClick={runSearch} disabled={searchBusy || !query.trim()}>
            {searchBusy ? 'Cerco…' : 'Cerca'}
          </button>
          <label className="alloc-sub" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={takeManual} onChange={(e) => setTakeManual(e.target.checked)} data-alloc-take-manual />
            prendi anche il <b>controllo manuale</b> del mercato (agent35 si tiene fuori)
          </label>
        </div>

        {searchErr && <div className="alloc-note alloc-warn" style={{ marginTop: 10 }} data-alloc-search-error>Ricerca fallita: {searchErr}</div>}

        {search && search.markets.length > 0 && (
          <>
            <div className="alloc-sub" style={{ marginTop: 10 }} data-alloc-search-counts>
              <b>{search.count}</b> mercati · <b>{search.withRewards}</b> con reward · <b>{search.withoutRewards}</b> senza reward
              {' '}(mostrati tutti, nessun filtro) · soglia di non-piazzamento: <b>{search.minMinutesToClose} min</b> alla chiusura
              {!search.globalAutoRepriceEnabled && <> · <b className="oob">master auto-riprezzo SPENTO</b>: un mercato aggiunto resta opted-in ma non entra in lista</>}
            </div>
            <div className="alloc-tablewrap" style={{ marginTop: 8 }}>
              <table className="alloc" style={{ minWidth: 980 }}>
                <thead>
                  <tr>
                    <th className="name">Mercato</th><th>Reward/g</th><th>Spread</th><th>Tick</th>
                    <th>Banda reward</th><th>Chiusura</th><th>Stato</th><th>Aggiungi</th>
                  </tr>
                </thead>
                <tbody>
                  {search.markets.map((m) => (
                    <tr key={m.marketId} data-alloc-search-row data-alloc-has-rewards={m.hasRewards ? '1' : '0'}>
                      <td className="name">
                        {m.question || <span className="alloc-addr">{m.marketId.slice(0, 10)}…</span>}
                        {!m.hasRewards && (
                          <div className="no-reward-badge" data-alloc-no-reward-label>NESSUN REWARD — solo trading direzionale</div>
                        )}
                      </td>
                      <td className={m.rewardsDailyRate == null ? 'dash' : ''} data-alloc-search-reward>
                        {m.rewardsDailyRate == null ? 'nessun reward' : perDay(m.rewardsDailyRate)}
                      </td>
                      <td className={m.spreadCents == null ? 'dash' : ''} data-alloc-search-spread>{cents(m.spreadCents)}</td>
                      <td className={m.tick == null ? 'dash' : ''} data-alloc-search-tick>{m.tick == null ? '—' : m.tick}</td>
                      <td className={m.rewardsMaxSpreadCents ? '' : 'dash'} data-alloc-search-band>
                        {m.rewardsMaxSpreadCents ? `±${(m.rewardsMaxSpreadCents / 2).toFixed(2)}¢` : '— nessuna'}
                      </td>
                      <td data-alloc-search-close className={m.tooCloseToClose ? 'oob' : ''}>
                        {closeText(m.minutesToClose)}{m.tooCloseToClose ? ' ⚠' : ''}
                      </td>
                      <td data-alloc-search-state>
                        {m.enabled ? <b className="fresh-ok">abilitato</b>
                          : m.optedIn ? <span className="fresh-stale">opted-in</span>
                            : <span className="alloc-cat">non abilitato</span>}
                        {m.closed && <div className="oob">chiuso</div>}
                        {!m.acceptingOrders && <div className="oob">non accetta ordini</div>}
                      </td>
                      <td>
                        <button className="alloc-btn" style={{ fontSize: 12, minHeight: 36, padding: '6px 10px' }}
                          data-alloc-add-preview
                          disabled={addBusy != null || m.enabled}
                          title={m.enabled ? 'già abilitato' : 'anteprima dell’aggiunta: non scrive nulla'}
                          onClick={() => addMarket(m.marketId, true)}>
                          {addBusy === `preview:${m.marketId}` ? '…' : m.enabled ? 'già in lista' : '1 · Anteprima'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {search && search.ok && search.markets.length === 0 && (
          <div className="alloc-sub" style={{ marginTop: 10 }} data-alloc-search-empty>Nessun mercato aperto trovato per «{search.query}».</div>
        )}

        {/* PASSO 2 — LA CONFERMA. Stessa forma del flusso di esecuzione: anteprima prima, conferma poi,
            con capitale e numero di mercati sotto gli occhi al momento di premere. */}
        {addPreview && addPreview.summary && (
          <div className="alloc-note" style={{ marginTop: 12 }} data-alloc-add-confirm>
            <div><b>Anteprima — non è stato scritto nulla.</b></div>
            <div style={{ marginTop: 4 }}>
              <b>{addPreview.summary.question || addPreview.marketId.slice(0, 12)}</b>
              {' · '}{addPreview.summary.hasRewards ? perDay(addPreview.summary.rewardsDailyRate) : <b className="oob">NESSUN REWARD — solo trading direzionale</b>}
              {' · spread '}{cents(addPreview.summary.spreadCents)}
              {' · tick '}{addPreview.summary.tick ?? '—'}
              {' · chiusura fra '}{closeText(addPreview.summary.minutesToClose)}
            </div>
            <div style={{ marginTop: 4 }}>
              Capitale in gioco <b>{addPreview.summary.capitalUsd == null ? '—' : money(addPreview.summary.capitalUsd)}</b>
              {' · mercati abilitati '}<b>{addPreview.summary.marketCountBefore} → {addPreview.summary.marketCountAfter}</b>
              {' · finestra GTD che avrebbe un ordine qui: '}
              <b>{addPreview.summary.window.tooClose ? 'nessuna — rifiutato' : `${addPreview.summary.window.ttlSeconds}s (${(addPreview.summary.window.ttlSeconds / 60).toFixed(1)} min)`}</b>
              {addPreview.summary.window.refreshMarginSeconds != null && !addPreview.summary.window.tooClose && <> · rinnovo a <b>{addPreview.summary.window.refreshMarginSeconds}s</b> dalla scadenza</>}
            </div>
            {addPreview.writes && (
              <ul style={{ margin: '6px 0 0 18px', padding: 0, fontSize: 12.5 }}>
                {addPreview.writes.map((w) => <li key={w}>{w}</li>)}
              </ul>
            )}
            {addPreview.summary.warnings.length > 0 && (
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }} data-alloc-add-warnings>
                {addPreview.summary.warnings.map((w) => <li key={w} className="oob" style={{ fontSize: 12.5 }}>{w}</li>)}
              </ul>
            )}
            <button className="alloc-btn" style={{ marginTop: 10, background: 'color-mix(in srgb,#2FA96B 30%,transparent)' }}
              data-alloc-add-confirm-btn disabled={addBusy != null}
              onClick={() => addMarket(addPreview.marketId, false)}>
              {addBusy?.startsWith('confirm') ? 'Scrivo…' : '2 · Conferma e aggiungi'}
            </button>
          </div>
        )}

        {addErr && <div className="alloc-note alloc-warn" style={{ marginTop: 10 }} data-alloc-add-error>Aggiunta non riuscita — nulla è cambiato: {addErr}</div>}

        {addResult && addResult.ok && (
          <div className="alloc-note" style={{ marginTop: 10 }} data-alloc-add-result>
            <b>Mercato aggiunto.</b> {addResult.note}
            {addResult.warnings && addResult.warnings.length > 0 && (
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {addResult.warnings.map((w) => <li key={w} className="oob" style={{ fontSize: 12.5 }}>{w}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>

      {loading && <div className="alloc-sub" style={{ margin: '8px 2px' }}>calcolo dell’allocazione…</div>}
      {plan && !plan.error && computed && plan.rows.length > 0 && (
        <div className="alloc-card">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
            <div className="alloc-h" style={{ fontSize: 15 }}>Allocazione su {plan.totals.count} mercati</div>
            <div className="alloc-sub" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} data-alloc-global-offset>
              offset globale:
              <button className="off-step" data-alloc-global-minus onClick={() => setAll(1)}>1t</button>
              <button className="off-step" style={{ fontSize: 13 }} onClick={() => setAll(2)}>2t</button>
              <button className="off-step" style={{ fontSize: 13 }} onClick={() => setAll(3)}>3t</button>
              <button className={'off-step' + (computed.widenAllLeaves ? ' step-danger' : '')} style={{ fontSize: 12, minWidth: 60 }} data-alloc-widen-all
                title={`allarga tutte di 1 tick: ${computed.widenAllLeaves} righe uscirebbero dalla banda, ${money(computed.grossWider - computed.grossNow)}/g lordo`}
                onClick={widenAll}>+1 tutte</button>
              <button className="alloc-btn" style={{ minHeight: 44, background: 'transparent', fontSize: 13 }} data-alloc-reset-all onClick={resetAll}>Ripristina default</button>
              {recomputeMs != null && <span data-alloc-recompute-ms>· ricalcolo {recomputeMs.toFixed(1)} ms (locale, senza refetch)</span>}
            </div>
          </div>

          {/* PRE-EMPTIVE widening preview — states the effect of «+1 a tutte» BEFORE it is pressed. */}
          <div className="alloc-sub" data-alloc-widen-preview style={{ margin: '4px 0 2px' }}>
            Anteprima «+1 a tutte» (prima di premere): <b className={computed.widenAllLeaves ? 'oob' : ''}>{computed.widenAllLeaves}</b> righe uscirebbero dalla banda (reward → $0), costo <b>{money(computed.grossWider - computed.grossNow)}/g</b> lordo.
          </div>

          {/* GLOBAL FRESHNESS — newest/oldest row age, stale count, and the auto-refresh cadence + measured latency. */}
          <div className="fresh-bar" data-alloc-freshness>
            <span><span className="fresh-dot" style={{ background: computed.staleCount ? '#d98a41' : '#4c9a6a' }} />
              dati per-riga: più recente <b>{computed.newestAge != null ? freshAge(computed.newestAge) + ' fa' : '—'}</b> · più vecchio <b>{computed.oldestAge != null ? freshAge(computed.oldestAge) + ' fa' : '—'}</b></span>
            <span className={computed.staleCount ? 'fresh-stale' : 'fresh-ok'} data-alloc-stale-count>
              {computed.staleCount} STALE{computed.unreadableCount ? ` · ${computed.unreadableCount} illeggibili` : ''} esclusi dai totali (soglia {STALE_S / 60} min)</span>
            <span>auto-refresh ogni {REFRESH_MS / 1000}s{lastRefreshMs ? ` · ultimo ${freshAge((nowMs - lastRefreshMs) / 1000)} fa` : ''}{refreshMs != null ? ` · latenza ${(refreshMs / 1000).toFixed(1)}s` : ''}</span>
          </div>

          {/* RESOLUTION HORIZON — how long the capital is committed. Long-dated is the norm here. */}
          <div className="fresh-bar" data-alloc-resdist>
            <span>orizzonte risoluzione: <b className={computed.resDist.near ? 'fresh-stale' : ''} data-alloc-near15>{computed.resDist.near}</b> entro {NEAR_RES_DAYS}g · <b>{computed.resDist.mid}</b> 15–90g · <b>{computed.resDist.long}</b> oltre 90g{computed.resDist.unknown ? <> · <b>{computed.resDist.unknown}</b> data ignota</> : ''}</span>
            <span className="alloc-sub" style={{ fontStyle: 'italic' }}>capitale a lungo termine; entro {NEAR_RES_DAYS}g il prezzo si muove su notizie reali, non rumore — cambia il carattere del fill (righe segnate ⚠).</span>
          </div>

          {/* COMPUTED DEFAULT OFFSET — net-max, not a fixed +1 tick. Explains why each row starts where it does. */}
          <div className="alloc-note" data-alloc-computed-default style={{ marginTop: 8 }}>
            <b>Offset di partenza calcolato, non fisso.</b> Ogni riga parte dall’offset che massimizza il <b>netto misurato</b> (lordo − markout osservato), non il lordo: massimizzare il lordo darebbe offset 0 — a metà prezzo — ovunque, perché il lordo è il tetto S=1 indipendente dall’offset (a 0¢ ha preso 14.642 fill nella finestra). Dove non c’è alcun fill osservato il netto non è misurabile: la riga parte dall’offset minimo a esposizione limitata (1 tick) ed è marcata <b>def exp</b>; le altre sono <b>def net</b>. Sotto ogni offset è indicato il default calcolato.
          </div>

          {/* Fill-exposure signal strength, stated honestly — a discriminator, NOT a probability. */}
          <div className="alloc-note" data-alloc-auc style={{ marginTop: 10 }}>
            <b>Esposizione al fill</b> (score strutturale per riga: order/depth + volatilità + spread stretto).
            {' '}Discriminatore <b>debole ma significativo</b>, {plan.fillScore.note}: AUC{' '}
            <b>{plan.fillScore.auc == null ? '—' : plan.fillScore.auc.toFixed(3)}</b>
            {plan.fillScore.ci95 ? <> · IC 95% [{plan.fillScore.ci95[0].toFixed(3)}, {plan.fillScore.ci95[1].toFixed(3)}]</> : ''}
            {' '}(su {plan.fillScore.nFilled} mercati con fill vs {plan.fillScore.nUnfilled} senza).
            {plan.fillScore.ci95 && plan.fillScore.ci95[0] <= 0.55
              ? <b style={{ color: '#d98a41' }}> Il limite inferiore dell’IC ({plan.fillScore.ci95[0].toFixed(3)}) è quasi a 0,5 (il caso): è un discriminatore, NON una probabilità, e il bordo basso sfiora il rumore. Usalo come spareggio, mai come cancello.</b>
              : <> Non è un filtro affidabile (0,5 = nessuna discriminazione, 1,0 = perfetta); usalo come spareggio, non come cancello.</>}
          </div>
          <div className="alloc-tablewrap">
            <table className="alloc">
              <thead>
                <tr>
                  <th className="name">Mercato</th><th>Capitale</th><th>$/lato</th><th>Scad. (gg)</th><th>Offset (tick / ¢ da mid)</th>
                  <th>Margine banda</th><th>Bid</th><th>Ask</th><th>Tick</th><th>Depth</th><th>Lordo/g</th>
                  <th title="Stima realistica: la cifra lorda dopo correzioni dichiarate (punteggio reale della posizione, andamento del montepremi, mercato sottile, buchi di copertura, selezione avversa). Passa il mouse su una cella per l'elenco completo.">Realistico/g</th>
                  <th>Netto/g</th><th>Fill attesi</th>
                  <th>Score fill</th><th>Ord/depth</th><th>Freschezza</th>
                </tr>
              </thead>
              <tbody>
                {computed.rows.map(({ r, c, ageS, stale, unreadable, dRes, artifact, band, nextStepLeaves, nextStepCost }) => (
                  <tr key={r.marketId} data-alloc-row data-alloc-usable={(!stale && !unreadable) ? '1' : '0'} style={{ opacity: (stale || unreadable) ? 0.55 : 1 }}>
                    <td className="name" style={{ borderLeft: BAND_BORDER[band.state] }}>
                      {r.nameAvailable ? r.name : <span><span className="alloc-addr">{r.shortId}</span> <span className="alloc-cat">· nome non disponibile</span></span>}
                      {r.category && <div className="alloc-cat">{r.category}</div>}
                    </td>
                    <td>{money(r.capital)}</td>
                    <td>{money(r.sizePerSideUsd)}</td>
                    <td className={dRes == null ? 'dash' : ''} data-alloc-resolution>
                      {dRes == null ? '—' : <span className={dRes < NEAR_RES_DAYS ? 'fresh-stale' : ''}>{Math.round(dRes)}{dRes < NEAR_RES_DAYS ? ' ⚠' : ''}</span>}
                    </td>
                    <td>
                      <span className="off-ctl">
                        <button className="off-step" aria-label="riduci offset" disabled={effTicks(r) <= 0} onClick={() => setRowOffset(r.marketId, Math.max(0, effTicks(r) - 1))}>−</button>
                        <span className="off-val" data-alloc-offset-cell title={`default calcolato: ${r.computedDefaultOffsetTicks} tick — ${r.defaultReason}`}>
                          <b className={c.overridden ? 'off-over' : ''}>{r.tick == null ? '—' : `${effTicks(r)} tick`}</b>
                          <small>{c.offsetCents == null ? '—' : cents(c.offsetCents)}{c.overridden ? ` • modif. (def ${r.computedDefaultOffsetTicks}t)` : ` • def ${r.defaultNetDerived ? 'net' : 'exp'}`}</small>
                        </span>
                        <button className={'off-step' + (nextStepLeaves ? ' step-danger' : '')} aria-label="aumenta offset"
                          title={nextStepLeaves ? `+1 tick porta il quote FUORI banda: reward → $0 (perdi ${perDay(nextStepCost)})` : 'aumenta offset di 1 tick'}
                          disabled={r.tick == null || effTicks(r) >= c.maxTick} onClick={() => setRowOffset(r.marketId, effTicks(r) + 1)}>+</button>
                        {c.overridden && <button className="off-reset" title="ripristina default" data-alloc-row-reset onClick={() => resetRow(r.marketId)}>↺</button>}
                      </span>
                      {nextStepLeaves && <small className="oob" data-alloc-step-warn style={{ display: 'block', marginTop: 2 }}>+1 → fuori banda: −{perDay(nextStepCost)}</small>}
                    </td>
                    <td data-alloc-headroom data-alloc-band-state={band.state} className={band.state === 'unknown' ? 'dash' : ''}>
                      <span className={`band-badge band-${band.state}`} data-band-label>{BAND_LABEL[band.state]}</span>
                      <small className="band-room" data-band-room title={band.state === 'unknown' ? 'raggio di banda illeggibile — margine sconosciuto, non sicuro' : undefined}>
                        {band.state === 'unknown' ? 'margine —'
                          : band.state === 'out' ? `oltre di ${cents(-(band.headroomCents ?? 0))}`
                            : `${band.headroomTicks} tick · ${cents(band.headroomCents)} al bordo`}
                      </small>
                    </td>
                    <td className={c.bid == null ? 'dash' : ''}>{price(c.bid)}</td>
                    <td className={c.ask == null ? 'dash' : ''}>{price(c.ask)}</td>
                    <td className={r.tick == null ? 'dash' : ''}>{r.tick == null ? '—' : r.tick}</td>
                    <td className={r.depthShares == null ? 'dash' : ''}>{shares(r.depthShares)}</td>
                    <td className={c.gross == null ? 'dash' : ''} data-alloc-gross>
                      {c.inBand === false ? <span className="oob" data-alloc-oob-gross><s>{perDay(r.grossInBandPerDay)}</s> $0,00/g · fuori banda</span>
                        : c.bandKnown === false && c.gross != null ? <span>{perDay(c.gross)}<small className="alloc-cat"> banda —</small></span>
                          : <>{perDay(c.gross)}{artifact && <small className="oob" data-alloc-s1-row title="lordo = tetto S=1: non modella il decadimento del punteggio con la distanza dal mid — allargare non è gratis"> · tetto S=1</small>}</>}
                      {/* Proportional bar — the same $/g already in this cell, drawn to the largest usable
                          row so the split across markets is readable at a glance. Out-of-band earns zero,
                          so its bar is genuinely empty; excluded rows get no bar at all. */}
                      {!stale && !unreadable && computed.maxGross > 0 && (
                        <span className="gross-bar" aria-hidden="true" data-alloc-gross-bar>
                          <i style={{ width: `${Math.max(0, Math.min(100, ((c.inBand === false ? 0 : (c.gross ?? 0)) / computed.maxGross) * 100))}%` }} />
                        </span>
                      )}
                    </td>
                    {/* ── STIMA REALISTICA — la seconda cifra, ACCANTO alla lorda, mai al suo posto. ──
                        Withheld ("non stimabile") is rendered as such WITH its reason: a book with no
                        competing liquidity produces a 100%-of-the-pot share, which is a formula outside its
                        domain, not an opportunity to be shaded down. */}
                    <td className={c.real == null || c.real.unknown ? 'dash' : ''} data-alloc-realistic
                        title={correctionsTooltip(c.real)}>
                      {c.real == null ? '—'
                        : c.real.unknown ? <span className="oob" data-alloc-realistic-unknown>non stimabile ⓘ</span>
                          : <>
                              <b>{perDay(c.real.realisticPerDay)}</b>
                              {c.gross != null && c.gross > 0 && c.real.totalFactor != null && (
                                <small className="alloc-cat" style={{ display: 'block' }}>{Math.round(c.real.totalFactor * 100)}% del lordo</small>
                              )}
                              {c.real.flags.map((fl) => (
                                <small key={fl.key} className={fl.severity === 'danger' ? 'oob' : 'fresh-stale'} style={{ display: 'block' }} title={fl.text}>⚠ {fl.text.length > 42 ? `${fl.text.slice(0, 42)}…` : fl.text}</small>
                              ))}
                            </>}
                      {/* The offset that maximises the CORRECTED figure. It disagrees with the configured
                          default whenever the default was chosen against the flat S=1 gross, which is
                          exactly the case worth showing. */}
                      {r.realisticBestTick != null && r.realisticBestTick !== effTicks(r) && r.realisticBestPerDay != null && (
                        <small className="alloc-cat" style={{ display: 'block' }}
                               title="l'offset che massimizza la stima CORRETTA. Il default è scelto contro il lordo a tetto S=1, che non decade dentro la banda: qui il decadimento è prezzato.">
                          a {r.realisticBestTick} tick: {perDay(r.realisticBestPerDay)}
                          <button className="off-reset" style={{ marginLeft: 4 }} title={`imposta l'offset a ${r.realisticBestTick} tick`}
                                  onClick={() => setRowOffset(r.marketId, r.realisticBestTick as number)}>→</button>
                        </small>
                      )}
                    </td>
                    <td className={c.net == null ? 'dash' : ''} data-alloc-net>{c.net == null ? '—' : perDay(c.net)}</td>
                    <td className={c.fills == null ? 'dash' : ''} data-alloc-fills>{c.fills == null ? '—' : c.fills}</td>
                    <td className={r.fillScore == null ? 'dash' : ''} data-alloc-score>{r.fillScore == null ? '—' : r.fillScore.toFixed(2)}</td>
                    <td className={c.orderVsDepth == null ? 'dash' : ''} data-alloc-orderdepth>
                      {c.orderVsDepth == null ? '—' : <span className={c.orderVsDepth >= 10 ? 'fresh-stale' : c.orderVsDepth >= 2 ? 'oob' : ''}>{c.orderVsDepth.toFixed(2)}×{c.orderVsDepth >= 2 ? ' ⚠' : ''}</span>}
                    </td>
                    <td className={ageS == null ? 'dash' : ''} data-alloc-fresh>
                      {unreadable ? <span className="fresh-stale">illeggibile</span>
                        : ageS == null ? '—'
                          : <span className={stale ? 'fresh-stale' : 'fresh-ok'}>{stale ? 'STALE · ' : ''}{freshAge(ageS)} fa</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="alloc-sum">
            <div><span>Capitale allocato</span><b>{money(plan.totals.capital)}</b></div>
            <div><span>Non allocato (resto)</span><b>{money(plan.totals.unallocated)}</b></div>
            <div><span>Lordo atteso (offset attuale)</span><b data-alloc-total-gross>{perDay(computed.grossNow)}</b></div>
            {/* La SECONDA cifra nel totale, affiancata alla lorda — mai al suo posto. */}
            <div>
              <span>Stima realistica (offset attuale)</span>
              <b data-alloc-total-realistic>{perDay(computed.realisticNow)}
                {computed.realisticGrossOfCounted > 0 && (
                  <small className="alloc-cat"> ({Math.round((computed.realisticNow / computed.realisticGrossOfCounted) * 100)}% del lordo delle stesse righe)</small>
                )}
              </b>
            </div>
            <div><span>vs offset default</span><b>{perDay(computed.grossDefault)}{computed.anyOverride ? <small className="alloc-cat"> ({money(computed.grossNow - computed.grossDefault)}/g)</small> : ''}</b></div>
            <div><span>Netto atteso</span><b>{computed.netNow == null ? '—' : perDay(computed.netNow)}</b></div>
            <div><span>Fill attesi totali</span><b data-alloc-total-fills>{computed.fillsNow}</b></div>
            <div><span>Allargare ogni riga +1 tick</span><b data-alloc-widen-cost>{perDay(computed.grossWider)}<small className="alloc-cat"> ({money(computed.grossWider - computed.grossNow)}/g lordo)</small></b></div>
          </div>

          {/* CRITICAL: the S=1 ceiling caveat — renders whenever any row is wider than its computed default with
              gross unchanged/improved. Never present a wider offset as free. */}
          {computed.artifactCount > 0 && (
            <div className="alloc-note alloc-warn" data-alloc-s1-caveat>
              <b>Un offset più largo NON è gratis.</b> {computed.artifactCount} {computed.artifactCount === 1 ? 'riga ha' : 'righe hanno'} un offset oltre il default calcolato con lordo <b>invariato o “migliore”</b>: è un <b>artefatto del modello</b>, non un guadagno. Il lordo del replay è il <b>tetto S=1</b> e non modella il decadimento del punteggio quando il quote si allontana dal mid; l’accumulo reale dei reward cala con la distanza, quindi il costo vero di allargare è <b>sottostimato</b> qui.
            </div>
          )}
          {/* BAND-STATE TRUTH: counts in every state, and — when any row is out — the loss made visible in the aggregate. */}
          <div className="alloc-sub" data-alloc-band-counts style={{ marginTop: 8 }}>
            <b>Stato banda:</b> <b className="fresh-ok">{computed.bandCounts.comfortable}</b> in banda · <b style={{ color: '#b9791f' }}>{computed.bandCounts.edge}</b> al bordo · <b className="oob">{computed.bandCounts.out}</b> fuori · <b style={{ color: '#8a8f98' }}>{computed.bandCounts.unknown}</b> ignota.
            {computed.bandCounts.out > 0 && <> Lordo <b data-alloc-gross-configured>{perDay(computed.grossNow)}</b> come configurato <b>vs</b> <b data-alloc-gross-allinband>{perDay(computed.grossAllInBand)}</b> con ogni riga in banda — <b className="oob">{money(computed.grossNow - computed.grossAllInBand)}/g perso fuori banda</b>.</>}
          </div>
          <div className="alloc-sub" style={{ marginTop: 6 }} data-alloc-totals-scope>
            I totali coprono i <b>{computed.usableCount} mercati con dati aggiornati</b>{computed.staleCount || computed.unreadableCount ? <> — esclusi <b>{computed.staleCount} stale</b>{computed.unreadableCount ? <> e <b>{computed.unreadableCount} illeggibili</b></> : ''} (dati troppo vecchi per pianificare il book attuale, non azzerati)</> : ''}.
          </div>
          {/* ── LE DUE CIFRE, SPIEGATE IN CHIARO ────────────────────────────────────────────────────────
              Questo è il testo che il prompt chiede: elenca le correzioni in linguaggio semplice e dice
              a voce alta che resta una stima. Sta sotto la tabella, non in un tooltip soltanto, perché è
              la cosa che cambia il modo di leggere ogni numero della pagina. */}
          <div className="alloc-note alloc-warn" data-alloc-realistic-note>
            <b>Due cifre, non una.</b> «Lordo/g» è il numero teorico di sempre: montepremi × quota modellata,
            con l’ordine appoggiato <b>esattamente sul mid</b> (punteggio massimo) e a riposo <b>tutto il giorno</b>.
            «Realistico/g» parte dallo stesso lordo e applica correzioni <b>dichiarate una per una</b> (passa il
            mouse su una cella per vederle tutte con i numeri):
            <ul style={{ margin: '6px 0 6px 18px', padding: 0 }}>
              <li><b>Punteggio reale della posizione</b> <i>(calcolo)</i> — la formula pubblicata S=((v−s)/v)² fa
                crollare il punteggio man mano che ti allontani dal mid. Un ordine a 1 tick da una banda di
                ±2,25¢ vale il <b>31%</b> del massimo, non il 100%. È la correzione più grande e non è un’opinione:
                è la stessa formula con cui il venue paga.</li>
              <li><b>Andamento del montepremi</b> <i>(misurato su 48h)</i> — se il pool è stato tagliato, la stima
                viene scontata di conseguenza. Se è cresciuto, l’aumento è segnalato ma <b>non incassato</b>.</li>
              <li><b>Mercato sottile</b> <i>(assunzione)</i> — se la tua quota modellata sarebbe sproporzionata, è
                un rischio, non un’occasione. Dove in banda <b>non c’è nessun altro</b>, la stima viene
                <b> ritirata</b> («non stimabile»): la formula ti darebbe il 100% del montepremi, ma è una divisione
                per un book che non esiste.</li>
              <li><b>Buchi di copertura</b> <i>(misurato)</i> — i premi si campionano <b>una volta al minuto</b>
                (1.440 campioni/giorno), e ogni cancella→ripiazza è tempo senza ordine a riposo. Di solito vale
                pochi decimi di punto; qui è calcolato, non ipotizzato.</li>
              <li><b>Selezione avversa</b> <i>(misurata dove ci sono fill, altrimenti assunzione)</i> — dove il nastro
                ha prodotto esecuzioni reali si sottrae il markout <b>misurato</b>; dove non ce ne sono, si sottrae
                una percentuale dichiarata e <b>volutamente grezza</b>.</li>
            </ul>
            <b>Resta una stima, non una garanzia.</b> Le voci marcate <i>assunzione</i> non sono misurate, e nemmeno
            la parte calcolata promette un rendimento: descrive solo cosa succederebbe se il book restasse com’è.
            {computed.realisticUnknownCount > 0 && <> Su questa allocazione <b>{computed.realisticUnknownCount}</b> {computed.realisticUnknownCount === 1 ? 'riga è' : 'righe sono'} «non stimabile» e {computed.realisticUnknownCount === 1 ? 'è esclusa' : 'sono escluse'} dal totale realistico.</>}
          </div>
          <div className="alloc-sub" style={{ marginTop: 6 }} data-alloc-apy-both>
            Annualizzato sul capitale: <b>{plan.annualisedGross.pct == null ? '—' : `${plan.annualisedGross.pct.toFixed(0)}%`}</b> lordo
            {' vs '}<b>{plan.annualisedRealistic.pct == null ? '—' : `${plan.annualisedRealistic.pct.toFixed(0)}%`}</b> realistico.
            Numeri a tre o quattro cifre da entrambe le parti significano che il capitale è piccolo rispetto ai
            montepremi dei mercati sottili in cui finisce — sono <b>run-rate</b>, non rendimenti attesi.
          </div>
          <div className="alloc-sub" style={{ marginTop: 6 }}>{plan.annualisedGross.label}. Il netto per-mercato è “—” dove non è stato osservato alcun fill reale. Un offset oltre il raggio di banda (maxSpread/2) porta il lordo a $0: la riga lo dice, non mostra un piccolo positivo.</div>

          {/* ── ESEGUI ALLOCAZIONE ─────────────────────────────────────────────────────────────────
              Due passi obbligatori: prima l'anteprima (che percorre la stessa aritmetica del cap senza
              inviare nulla), poi la conferma. Un bottone singolo che piazza dieci ordini reali al primo
              click e' il tipo di comando che si preme per sbaglio una volta sola. */}
          <div className="alloc-card" data-alloc-bulk style={{ borderColor: '#2E5FBE' }}>
            <div className="alloc-h" style={{ fontSize: 15 }}>Esegui allocazione</div>
            <div className="alloc-sub">
              Piazza <b>in sequenza</b> gli ordini della tabella qui sopra, uno per riga, con lo stesso
              mercato/lato/prezzo/size che stai guardando. Ogni ordine passa dagli <b>stessi gate</b> di un
              ordine a mano (validateOrder, kill-switch, cap) e finisce sotto la <b>stessa gestione del
              watcher</b>: inseguimento del mid, vincolo di banda, rinnovo GTD, riconciliazione.
            </div>

            {bulkRows.length === 0 ? (
              <div className="alloc-note alloc-warn" style={{ marginTop: 10 }}>
                Nessuna riga eseguibile: servono righe con dati freschi, dentro banda e con un bid calcolabile.
              </div>
            ) : (
              <>
                <div className="alloc-sub" style={{ marginTop: 10 }} data-alloc-bulk-summary>
                  <b>{bulkRows.length}</b> ordini · capitale totale{' '}
                  <b>{money(bulkRows.reduce((s, r) => s + r.price * r.size, 0))}</b>
                  {balanceNum != null && <> su un saldo reale di <b>{money(balanceNum)}</b></>}
                </div>

                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
                  <button className="alloc-btn" data-alloc-bulk-preview onClick={() => runBulk(true)} disabled={bulkBusy != null}>
                    {bulkBusy === 'preview' ? 'Verifico…' : '1 · Anteprima (non invia nulla)'}
                  </button>
                  <button
                    className="alloc-btn"
                    data-alloc-bulk-run
                    style={{ background: bulkPreview ? 'color-mix(in srgb,#2FA96B 30%,transparent)' : undefined }}
                    onClick={() => runBulk(false)}
                    disabled={bulkBusy != null || !bulkPreview}
                    title={bulkPreview ? 'piazza davvero gli ordini elencati nell\'anteprima' : 'fai prima l\'anteprima'}
                  >
                    {bulkBusy === 'run' ? 'Piazzo…' : '2 · Conferma ed esegui'}
                  </button>
                </div>

                {bulkPreview && !bulkResult && (
                  <div className="alloc-note" style={{ marginTop: 10 }} data-alloc-bulk-confirm>
                    <b>Conferma:</b> verranno piazzati <b>{bulkPreview.results.filter((x) => x.status !== 'refused').length}</b> ordini
                    su <b>{new Set(bulkPreview.results.map((x) => x.marketId)).size}</b> mercati, per{' '}
                    <b>{money(bulkPreview.totals.requestedUsd)}</b> di capitale.
                    {bulkPreview.stoppedBy === 'cap-cumulativo' && (
                      <> <b className="oob">Attenzione:</b> {bulkPreview.reason} — le righe oltre quel punto NON verranno piazzate.</>
                    )}
                    {bulkPreview.openBefore ? <> Esposizione già aperta: <b>{money(bulkPreview.openBefore)}</b>.</> : null}
                  </div>
                )}

                {bulkErr && <div className="alloc-note alloc-warn" style={{ marginTop: 10 }}>Richiesta fallita — nulla è confermato: {bulkErr}</div>}

                {bulkResult && (
                  <div style={{ marginTop: 10 }} data-alloc-bulk-result>
                    <div className="alloc-sub">
                      <b>{bulkResult.placed}</b> piazzati · <b>{bulkResult.refused}</b> rifiutati ·{' '}
                      <b>{bulkResult.skipped}</b> saltati · capitale piazzato <b>{money(bulkResult.totals.placedUsd)}</b>
                      {bulkResult.stoppedBy && <> — <b className="oob">fermata: {bulkResult.reason}</b></>}
                    </div>
                    <div className="alloc-tablewrap" style={{ marginTop: 8 }}>
                      <table className="alloc" style={{ minWidth: 640 }}>
                        <thead><tr><th className="name">Mercato</th><th>Prezzo</th><th>Size</th><th>Esito</th><th className="name">Dettaglio</th></tr></thead>
                        <tbody>
                          {bulkResult.results.map((x, i) => (
                            <tr key={`${x.marketId}-${i}`}>
                              <td className="name">{x.title || x.marketId.slice(0, 10)}</td>
                              <td>{price(x.price)}</td>
                              <td>{shares(x.size)}</td>
                              <td>
                                <b className={x.status === 'placed' ? 'fresh-ok' : x.status === 'refused' ? 'oob' : ''}>
                                  {x.status === 'placed' ? (x.sent ? 'piazzato' : 'validato (dry-run)') : x.status === 'refused' ? 'rifiutato' : 'saltato'}
                                </b>
                              </td>
                              <td className="name"><small>{x.gate ? `[${x.gate}] ` : ''}{x.reason}</small></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div style={{ marginTop: 14 }}>
            <div className="alloc-sub">Frontiera netto/g per numero di mercati tenuti:</div>
            <div className="alloc-front">
              {FRONTIER_MARKS.map((n) => { const f = plan.frontier.find((x) => x.count === n); return <span key={n} className="alloc-chip">{n} mkt: {f ? `$${f.net.toFixed(1)}/g` : '—'}</span>; })}
            </div>
          </div>

          {/* Measured offset frontier from the risk-first run — fills avoided vs reward lost, per cent. */}
          <div style={{ marginTop: 14 }} data-alloc-offset-frontier>
            <div className="alloc-sub">Frontiera offset misurata (risk-first, $1000/lato, tutti i mercati) — cosa costa e cosa evita allargare:</div>
            <div className="alloc-front">
              {plan.offsetFrontier.map((f) => (
                <span key={f.offsetCents} className="alloc-chip">{f.offsetCents}¢: {f.fills.toLocaleString()} fill{f.rewardLost > 0 ? ` · −$${f.rewardLost.toFixed(0)}/g reward` : ' · reward $0 perso'}</span>
              ))}
            </div>
            <div className="alloc-sub" style={{ marginTop: 4 }} data-alloc-s1-note>1¢ evita ~97% dei fill a costo reward zero (tutte le bande ≥ 2¢); oltre, ogni mercato che supera il proprio raggio di banda perde tutto il reward. <b>Il lordo qui è il tetto S=1</b> (indipendente dall’offset in banda): non modella il decadimento del punteggio con la distanza dal mid, quindi in banda allargare <b>sembra</b> gratis ma non lo è.</div>
          </div>

          <div className="alloc-sub" style={{ marginTop: 12 }}>{plan.coverage.trueNote}</div>
          <div className="alloc-sub" style={{ marginTop: 6 }} data-alloc-persist-note>
            La configurazione degli offset è salvata nel <b>browser</b> (localStorage, per-capitale): sopravvive al reload ed è riproducibile — stesso capitale + stessa mappa produce la stessa allocazione. È una <b>preferenza di visualizzazione</b>, non un ordine né un’istruzione a operare, e resta locale a questo dispositivo.
          </div>
        </div>
      )}
      {plan && !plan.error && plan.rows.length === 0 && Number(capital) > 0 && !loading && (
        <div className="alloc-sub" style={{ margin: '8px 2px' }}>Nessun mercato allocato per questo capitale.</div>
      )}
    </div>
  );
}
