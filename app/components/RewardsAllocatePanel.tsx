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
import type { OrderTarget } from '@/app/components/OrderPanel';

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
  // La size minima del venue (min_incentive_size) per questo mercato. Sotto di essa il venue non assegna
  // punteggio: il lordo e' ZERO, e `capitalToQualifyUsd` e' il capitale che lo sbloccherebbe.
  minSizeShares: number | null; belowVenueMinSize: boolean; capitalToQualifyUsd: number | null;
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
  // Mercati che la size minima del venue esclude a questo capitale, con il capitale che li sbloccherebbe.
  belowMinSize?: { marketId: string; name: string | null; shortId: string; minSizeShares: number | null; capitalToQualifyUsd: number | null }[];
  // ── IL REGISTRO DEI CANDIDATI ── una riga per OGNI mercato dell'universo reward, scelto o scartato,
  // con il motivo costruito dai suoi stessi numeri. Puramente descrittivo: non decide nulla.
  candidates?: Candidate[];
  universe?: {
    withPot: number; evaluated: number; chosen: number;
    horizonFilter: boolean; horizonRejected: number; note: string;
  };
  error?: string;
};
type Candidate = {
  marketId: string; name: string | null; shortId: string; nameAvailable?: boolean;
  status: 'scelto' | 'scartato'; reason: string; reasonCode?: string;
  capital: number; bestNetPerDay: number | null; bestGrossPerDay: number | null;
  competitorShares: number | null; pot: number | null; maxSpreadCents: number | null;
  horizon: { state: string; days: number | null; payback: number | null; paybackNever: boolean } | null;
};
/** Etichette dei motivi di scarto, per raggrupparli. Il testo per riga resta quello del server. */
const REJECT_LABEL: Record<string, string> = {
  'orizzonte': 'Scadenza troppo vicina',
  'min-size': 'Sotto la size minima del venue',
  'netto-negativo': 'Reward troppo basso rispetto al costo',
  'netto-ignoto': 'Netto non misurabile',
  'non-scorabile': 'Nessuna profondità scorabile',
  'battuto': 'Battuti da mercati migliori',
  'senza-storico': 'Nessuno storico prezzi raccolto',
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
  // Due regole del venue azzerano la riga, non una: FUORI BANDA non scora, e SOTTO LA SIZE MINIMA non
  // scora. La seconda non dipende dall'offset — vale a qualunque tick — quindi va applicata prima.
  const gross = r.grossInBandPerDay == null ? null : (r.belowVenueMinSize ? 0 : (inBand === false ? 0 : r.grossInBandPerDay));
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
  /** Quanti la ricerca ha tolto perché non operabili — dichiarato, mai silenzioso. */
  notTradableDropped?: number;
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

/**
 * Da una riga del piano al pannello ordine. Si passa la size CHE IL PIANO HA DECISO, non la minima del
 * venue: il senso di aprire il pannello da qui e proprio eseguire il piano, e ricominciare dal minimo
 * butterebbe via il calcolo. Il conditionId e quello della riga, copiato, mai ricercato.
 */
function targetFromPlanRow(r: Row): OrderTarget {
  return {
    marketId: r.marketId,
    title: r.nameAvailable && r.name ? r.name : r.shortId,
    endDate: r.endDate ?? null,
    minutesToClose: r.endDate && Number.isFinite(Date.parse(r.endDate))
      ? (Date.parse(r.endDate) - Date.now()) / 60_000 : null,
    mid: r.mid, bestBid: null, bestAsk: null, spreadCents: null,
    tick: r.tick, minSize: r.minSizeShares,
    maxSpreadCents: r.maxSpreadCents,
    rewardsDailyRate: null,
    // Il piano è UN PIANO DI LIQUIDITY REWARDS: ogni riga viene da un mercato che un montepremi ce
    // l'ha. Il tasso puntuale non viaggia in questa struttura, quindi si dichiara il fatto che si sa
    // (c'è un programma) e non si finge di sapere la cifra.
    hasRewards: true,
    enabled: true,
    presetSize: r.sizePerSideShares,
  };
}

export default function RewardsAllocatePanel(
  { onPlaceOrder }: { onPlaceOrder?: (t: OrderTarget) => void } = {},
) {
  const [bal, setBal] = useState<Balance | null>(null);
  const [balLoaded, setBalLoaded] = useState(false);
  const [capital, setCapital] = useState<string>(''); // operator's typed value — NEVER rewritten by us
  // Which mobile card has its technical detail open. One at a time: the card list is already long.
  const [openCard, setOpenCard] = useState<string | null>(null);
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
  const [addPreview, setAddPreview] = useState<EnableResp | null>(null);
  const [addResult, setAddResult] = useState<EnableResp | null>(null);
  const [addBusy, setAddBusy] = useState<string | null>(null);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [takeManual, setTakeManual] = useState(true);
  // ── OTTIMIZZAZIONE AUTOMATICA ── azione ESPLICITA e separata. Non parte da sola quando cambia il
  // capitale: sovrascrivere in silenzio una selezione fatta a mano e' esattamente cio' che non deve
  // succedere, quindi il piano automatico e' un secondo piano, tenuto a parte da `plan`.
  const [autoPlan, setAutoPlan] = useState<Plan | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoErr, setAutoErr] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);

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
      // ── QUANTI MERCATI QUALIFICANO DAVVERO, e per quale delle due regole gli altri non lo fanno.
      // Il riepilogo finale mostra la cifra e, sotto, il motivo: un piano su 12 mercati di cui 5
      // rendono zero non e' un piano su 12 mercati, ed e' esattamente la cosa che uno zero nascosto
      // lascia credere.
      qualifyingCount: usable.filter((x) => (x.c.gross ?? 0) > 0).length,
      belowMinCount: rows.filter((x) => x.r.belowVenueMinSize).length,
      outOfBandCount: rows.filter((x) => x.c.inBand === false).length,
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

  // ── PERCHE QUI NON C'E PIU UNA RICERCA ─────────────────────────────────────────────────────────
  // C'erano due ricerche, in due tab, sulla stessa fonte ma con due comportamenti: una filtrava dal vivo
  // una lista locale, l'altra faceva una GET e mostrava una TABELLA. E la seconda era il punto in cui
  // l'identita di un mercato si perdeva: chi arrivava qui da una card riceveva un termine di ricerca,
  // quindi una lista, e la riga giusta non era la prima. Adesso cercare e mestiere di una tab sola, e da
  // li si apre il pannello ordine direttamente sull'oggetto toccato. Questa tab fa una cosa sola:
  // decidere quanto capitale mettere e su quali mercati.

  // ── OTTIMIZZA AUTOMATICAMENTE ────────────────────────────────────────────────────────────────────
  // Rilancia lo STESSO ottimizzatore sullo stesso universo (che e' sempre stato tutto il board reward,
  // non la lista abilitata a mano) con in piu' il test dell'orizzonte di risoluzione, e chiede il
  // registro dei candidati. E' una GET: non scrive niente, non abilita niente, non piazza niente.
  const runAutoOptimise = useCallback(async () => {
    const n = Number(capital);
    if (!Number.isFinite(n) || n <= 0) { setAutoErr('inserisci prima un capitale'); return; }
    setAutoBusy(true); setAutoErr(null); setAddPreview(null); setAddResult(null);
    try {
      const r = await fetch(`/api/rewards/allocate?capital=${encodeURIComponent(capital)}&auto=1`);
      const b = (await r.json()) as Plan;
      if (b.error) { setAutoErr(b.error); setAutoPlan(null); }
      else setAutoPlan(b);
    } catch (e) { setAutoErr((e as Error).message); }
    finally { setAutoBusy(false); }
  }, [capital]);

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
      }
      if (!b.ok && (b.error || b.gate)) setAddErr(b.error || `rifiutato: ${b.gate}`);
    } catch (e) { setAddErr((e as Error).message); }
    finally { setAddBusy(null); }
  }, [capital, takeManual]);

  return (
    <div className="alloc-root exch">
      <style>{CSS}</style>

      <h1 className="alloc-h">Allocazione capitale · liquidity rewards</h1>
      <p className="alloc-sub" title="L ottimizzatore distribuisce il capitale con un knapsack sulla profondita reale in-band e sul pot, non in parti uguali. L offset e regolabile per singolo mercato ed e leva diretta sull essere riempiti.">Un capitale, distribuito per knapsack sulla profondità reale — non in parti uguali. Offset regolabile per mercato.</p>

      <div className="alloc-basis" data-alloc-basis>
        <div className="alloc-basis-h">⚠ Un piano, non un ordine — cifre lorde, campione piccolo</div>
        <ul className="alloc-basis-ul">
          <li title="Nessun ordine viene creato, firmato o inviato guardando o usando questa pagina, incluso il controllo dell offset. Non viene mosso alcun capitale."><b>Non piazza nulla.</b> Nemmeno il controllo dell’offset.</li>
          <li title="L adverse selection e misurata a parte: il netto e — dove non e stato osservato un fill reale. Non sommare il lordo come rendimento."><b>Cifre LORDE.</b> Il netto è «—» dove non c’è un fill osservato.</li>
          <li data-alloc-disclaimer-counts title="Il comportamento di riempimento per-mercato resta statisticamente esile.">
            <b>Campione piccolo:</b> copertura ~{plan && plan.coverage.truePct != null ? plan.coverage.truePct : '20'}%
            {plan && plan.observed ? <>, {plan.observed.windowHours.toFixed(1)}h, {plan.observed.totalFills} fill su {plan.observed.filledMarkets} mercati</> : <> su ~48h</>}.
          </li>
          <li title="Durante lo studio il lordo e sceso del 36% in due giorni. Nessuna cifra qui e garantita."><b>I pot si muovono.</b> Run-rate, non una promessa.</li>
        </ul>
      </div>

      {/* PROXY / BALANCE */}
      <div className="alloc-card" data-alloc-balance>
        <div className="alloc-h" style={{ fontSize: 15 }}>Saldo proxy</div>
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


      {/* ══ OTTIMIZZA AUTOMATICAMENTE ═══════════════════════════════════════════════════════════════
          UN'AZIONE ESPLICITA, MAI AUTOMATICA. Non parte quando cambia il capitale e non parte con
          «Usa saldo intero»: si preme. Il risultato e' una PROPOSTA tenuta separata dal piano di
          sopra — non riscrive `plan`, non tocca la lista abilitata, non piazza nulla. Ogni mercato
          proposto passa dagli stessi due passi (anteprima → conferma) che gia' esistono qui sotto,
          uno alla volta, e l'aggiunta e' additiva: il server calcola enabledAfter = enabledBefore + id,
          quindi una scelta manuale precedente non puo' essere sovrascritta da qui. */}
      <div className="alloc-card" data-alloc-auto>
        <div className="alloc-h" style={{ fontSize: 15 }}>Cerca la combinazione migliore</div>
        <div className="alloc-sub" title="L universo e sempre stato tutto il board reward: enabledMarketIds non entra nel calcolo dell allocazione e non l ha mai fatto. Questa azione aggiunge il test dell orizzonte di risoluzione e restituisce il registro dei candidati.">
          Cerca su <b>tutti</b> i mercati con montepremi — non solo quelli abilitati — e propone la
          combinazione migliore per questo capitale, scartando quelli che scadono prima di rientrare del
          costo di adverse selection.
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
          <button className="alloc-btn" data-alloc-auto-run onClick={runAutoOptimise}
            disabled={autoBusy || !(Number(capital) > 0)}>
            {autoBusy ? 'Cerco sull’intero universo…' : '⚡ Cerca la combinazione migliore'}
          </button>
          {autoPlan && (
            <button className="alloc-btn" style={{ background: 'transparent' }} onClick={() => { setAutoPlan(null); setAutoErr(null); }}>
              Chiudi proposta
            </button>
          )}
        </div>

        {autoErr && <div className="alloc-note alloc-warn" style={{ marginTop: 10 }} data-alloc-auto-error>⚠ Ricerca della combinazione non riuscita: {autoErr}</div>}

        {autoPlan && autoPlan.universe && (
          <>
            <div className="alloc-sum" style={{ marginTop: 12 }} data-alloc-auto-universe>
              <div><span>Con montepremi</span><b>{autoPlan.universe.withPot}</b></div>
              <div>
                <span>Valutabili</span><b>{autoPlan.universe.evaluated}</b>
                {autoPlan.universe.evaluated < autoPlan.universe.withPot && (
                  <p className="ex-why">{autoPlan.universe.withPot - autoPlan.universe.evaluated} senza storico prezzi</p>
                )}
              </div>
              <div><span>Proposti</span><b className="fresh-ok">{autoPlan.universe.chosen}</b></div>
              <div>
                <span>Scartati per scadenza</span><b>{autoPlan.universe.horizonRejected}</b>
              </div>
              <div><span>Lordo atteso</span><b>{perDay(autoPlan.totals.grossPerDay)}</b></div>
              <div><span>Lordo corretto</span><b>{perDay(autoPlan.totals.realisticPerDay)}</b></div>
            </div>

            <div className="alloc-note" style={{ marginTop: 10 }} data-alloc-auto-disclaimer>
              <b>È una proposta.</b> Nessun mercato è stato abilitato e nessun ordine è stato creato.
              Per ognuno servono i due passi qui sotto, uno alla volta. L’aggiunta è <b>additiva</b>: i
              mercati che hai già abilitato a mano restano dove sono.
            </div>

            {/* ── SCELTI, col perché ── */}
            <div className="alloc-sub" style={{ marginTop: 12, marginBottom: 4 }}>
              <b>Proposti</b> — perché ciascuno è stato scelto
            </div>
            <div className="alloc-cards" style={{ display: 'flex' }} data-alloc-auto-chosen>
              {(autoPlan.candidates ?? []).filter((c) => c.status === 'scelto').map((c) => (
                <div key={c.marketId} className="ac" data-alloc-auto-row={c.marketId}>
                  <div className="ac-top">
                    <div className="ac-name">{c.name || <span className="alloc-addr">{c.shortId}</span>}</div>
                    <b className="fresh-ok" style={{ fontFamily: 'var(--ex-mono)', whiteSpace: 'nowrap' }}>{money(c.capital)}</b>
                  </div>
                  <div className="alloc-sub" style={{ marginTop: 4 }} data-alloc-auto-why>✓ {c.reason}</div>
                  <div className="ac-nums">
                    <div className="ac-num"><span>Netto/g</span><b>{perDay(c.bestNetPerDay)}</b></div>
                    <div className="ac-num"><span>Lordo/g</span><b>{perDay(c.bestGrossPerDay)}</b></div>
                    <div className="ac-num"><span>Scadenza</span><b>{c.horizon && c.horizon.days != null ? `${Math.round(c.horizon.days)} g` : '—'}</b></div>
                  </div>
                  <div style={{ marginTop: 9 }}>
                    <button className="alloc-btn" style={{ fontSize: 12 }}
                      data-alloc-auto-preview
                      disabled={addBusy != null}
                      title="anteprima dell’aggiunta: non scrive nulla"
                      onClick={() => addMarket(c.marketId, true)}>
                      {addBusy === `preview:${c.marketId}` ? '…' : '1 · Anteprima'}
                    </button>
                  </div>
                </div>
              ))}
              {(autoPlan.candidates ?? []).filter((c) => c.status === 'scelto').length === 0 && (
                <div className="alloc-note alloc-warn">
                  ⚠ Nessun mercato qualifica con questo capitale. I motivi sono elencati qui sotto.
                </div>
              )}
            </div>

            {/* ── SCARTATI, raggruppati per motivo ── */}
            <button className="ac-more" style={{ marginTop: 10 }} data-alloc-auto-rejected-toggle
              onClick={() => setShowRejected((v) => !v)}>
              {showRejected ? 'Nascondi gli scartati' : `Perché gli altri ${(autoPlan.candidates ?? []).filter((c) => c.status === 'scartato').length} sono stati scartati`}
            </button>

            {showRejected && (
              <div style={{ marginTop: 10 }} data-alloc-auto-rejected>
                {Object.entries(
                  (autoPlan.candidates ?? []).filter((c) => c.status === 'scartato')
                    .reduce((g: Record<string, Candidate[]>, c) => {
                      const k = c.reasonCode || 'altro';
                      (g[k] = g[k] || []).push(c);
                      return g;
                    }, {}),
                ).map(([code, list]) => (
                  <div key={code} style={{ marginTop: 8 }}>
                    <div className="alloc-sub"><b>{REJECT_LABEL[code] ?? code}</b> · {list.length}</div>
                    <ul className="alloc-basis-ul" style={{ marginTop: 4 }}>
                      {list.slice(0, 8).map((c) => (
                        <li key={c.marketId} title={c.reason}>
                          {c.name || c.shortId} — <span className="alloc-cat">{c.reason}</span>
                        </li>
                      ))}
                      {list.length > 8 && <li className="alloc-cat">+{list.length - 8} altri</li>}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </>
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
          <div className="alloc-note" data-alloc-computed-default style={{ marginTop: 8 }}
               title="Ogni riga parte dall offset che massimizza il netto misurato (lordo meno markout osservato), non il lordo: massimizzare il lordo darebbe offset 0 ovunque, perche il lordo e il tetto S=1 indipendente dall offset (a 0 centesimi ha preso 14.642 fill nella finestra). Dove non c e alcun fill osservato il netto non e misurabile: la riga parte dall offset minimo a esposizione limitata, 1 tick, ed e marcata def exp; le altre sono def net.">
            <b>Offset di partenza calcolato</b>, non fisso: massimizza il netto misurato. <b>def net</b> = misurato,
            <b> def exp</b> = nessun fill osservato, parte da 1 tick.
          </div>

          {/* Fill-exposure signal strength, stated honestly — a discriminator, NOT a probability. */}
          <div className="alloc-note" data-alloc-auc style={{ marginTop: 10 }}
               title={`Score strutturale per riga: order/depth + volatilita + spread stretto. ${plan.fillScore.note}. Misurato su ${plan.fillScore.nFilled} mercati con fill contro ${plan.fillScore.nUnfilled} senza. 0,5 = nessuna discriminazione, 1,0 = perfetta.`}>
            <b>Esposizione al fill</b> · AUC <b>{plan.fillScore.auc == null ? '—' : plan.fillScore.auc.toFixed(3)}</b>
            {plan.fillScore.ci95 ? <> · IC95 [{plan.fillScore.ci95[0].toFixed(3)}, {plan.fillScore.ci95[1].toFixed(3)}]</> : ''}
            {plan.fillScore.ci95 && plan.fillScore.ci95[0] <= 0.55
              ? <b className="oob"> — il bordo basso sfiora il caso: spareggio, mai cancello.</b>
              : <> — spareggio, non cancello.</>}
          </div>
          {/* ── TELEFONO: LE STESSE RIGHE, COME SCHEDE ───────────────────────────────────────────────
              Diciassette colonne non stanno in uno schermo di telefono, e una tabella che scorre in
              orizzontale nasconde proprio la cifra per cui sei venuto. Queste schede leggono gli STESSI
              oggetti calcolati (r, c, band) che alimentano la tabella qui sotto: nessun numero viene
              ricalcolato qui, quindi le due viste non possono divergere. Sotto i 900px la tabella
              sparisce e restano queste; sopra, il contrario. */}
          <div className="alloc-cards" data-alloc-cards>
            {computed.rows.map(({ r, c, ageS, stale, unreadable, dRes, band, nextStepLeaves, nextStepCost }) => {
              const openThis = openCard === r.marketId;
              // Le due regole del venue che azzerano la riga. Il verdetto va PRIMA dei numeri, non in
              // fondo: e' la risposta alla domanda che l'operatore sta per farsi guardando uno zero.
              const zeroed = r.belowVenueMinSize || c.inBand === false;
              return (
                <div key={r.marketId} className="ac" data-alloc-card={r.marketId}
                     data-alloc-usable={(!stale && !unreadable) ? '1' : '0'}
                     style={{ opacity: (stale || unreadable) ? 0.55 : 1 }}>
                  <div className="ac-top">
                    <div className="ac-name">
                      {r.nameAvailable ? r.name : <span className="alloc-addr">{r.shortId}</span>}
                      {r.category && <div className="alloc-cat">{r.category}</div>}
                    </div>
                    <span className={`band-badge band-${band.state}`} data-band-label>{BAND_LABEL[band.state]}</span>
                  </div>

                  {onPlaceOrder && (
                    <button className="alloc-btn alloc-place" data-alloc-place={r.marketId}
                      onClick={() => onPlaceOrder(targetFromPlanRow(r))}
                      title="Apre il pannello ordine su QUESTO mercato, con la size decisa dal piano. Restano due tocchi prima di scrivere.">
                      Piazza ordine → {shares(r.sizePerSideShares)} share
                    </button>
                  )}

                  {zeroed && (
                    <div className="ac-zero" data-alloc-card-zero>
                      {r.belowVenueMinSize
                        ? <>Rende <b>$0,00/g</b> — il capitale sta sotto la size minima del venue
                          {r.capitalToQualifyUsd != null
                            ? <>: servono almeno <b>{money(r.capitalToQualifyUsd)}</b> ({r.minSizeShares} share per lato)</>
                            : <>, quindi l ordine non viene scorato</>}</>
                        : <>Rende <b>$0,00/g</b> — a questo offset il quote esce dalla banda premiante</>}
                    </div>
                  )}

                  <div className="ac-nums">
                    <div className="ac-num">
                      <span>Lordo/g</span>
                      <b data-alloc-card-gross>{zeroed ? '$0,00/g' : perDay(c.gross)}</b>
                    </div>
                    <div className="ac-num">
                      <span>Realistico/g</span>
                      <b data-alloc-card-real>
                        {c.real == null ? '—'
                          : c.real.unknown ? <span className="oob">non stimabile</span>
                            : perDay(c.real.realisticPerDay)}
                      </b>
                    </div>
                    <div className="ac-num">
                      <span>Capitale</span>
                      <b>{money(r.capital)}</b>
                    </div>
                  </div>

                  <div className="ac-off">
                    <span className="ac-off-k">Offset dal mid</span>
                    <span className="off-ctl">
                      <button className="off-step" aria-label="riduci offset" disabled={effTicks(r) <= 0}
                              onClick={() => setRowOffset(r.marketId, Math.max(0, effTicks(r) - 1))}>−</button>
                      <span className="off-val">
                        <b className={c.overridden ? 'off-over' : ''}>{r.tick == null ? '—' : `${effTicks(r)} tick`}</b>
                        <small>{c.offsetCents == null ? '—' : cents(c.offsetCents)}</small>
                      </span>
                      <button className={'off-step' + (nextStepLeaves ? ' step-danger' : '')} aria-label="aumenta offset"
                              disabled={r.tick == null || effTicks(r) >= c.maxTick}
                              onClick={() => setRowOffset(r.marketId, effTicks(r) + 1)}>+</button>
                      {c.overridden && (
                        <button className="off-reset" title="ripristina default" data-alloc-card-reset
                                onClick={() => resetRow(r.marketId)}>↺</button>
                      )}
                    </span>
                  </div>
                  {nextStepLeaves && (
                    <div className="oob ac-warn" data-alloc-card-stepwarn>
                      +1 tick porta il quote fuori banda: reward a $0 (−{perDay(nextStepCost)})
                    </div>
                  )}

                  <button className="ac-more" data-alloc-card-more onClick={() => setOpenCard(openThis ? null : r.marketId)}>
                    {openThis ? 'Nascondi dettagli tecnici' : 'Dettagli tecnici'}
                  </button>

                  {openThis && (
                    <div className="ac-det" data-alloc-card-detail>
                      <div><span>$ per lato</span><b>{money(r.sizePerSideUsd)}</b></div>
                      <div><span>Margine banda</span><b>{band.state === 'unknown' ? '—'
                        : band.state === 'out' ? `oltre di ${cents(-(band.headroomCents ?? 0))}`
                          : `${band.headroomTicks} tick`}</b></div>
                      <div><span>Bid / Ask</span><b>{price(c.bid)} / {price(c.ask)}</b></div>
                      <div><span>Tick</span><b>{r.tick == null ? '—' : r.tick}</b></div>
                      <div><span>Depth</span><b>{shares(r.depthShares)}</b></div>
                      <div><span>Netto/g</span><b>{c.net == null ? '—' : perDay(c.net)}</b></div>
                      <div><span>Fill attesi</span><b>{c.fills == null ? '—' : c.fills}</b></div>
                      <div><span>Score fill</span><b>{r.fillScore == null ? '—' : r.fillScore.toFixed(2)}</b></div>
                      <div><span>Ordine / depth</span><b>{c.orderVsDepth == null ? '—' : `${c.orderVsDepth.toFixed(2)}×`}</b></div>
                      <div><span>Scadenza</span><b>{dRes == null ? '—' : `${Math.round(dRes)} gg`}</b></div>
                      <div><span>Freschezza</span><b>{unreadable ? 'illeggibile' : ageS == null ? '—' : `${freshAge(ageS)} fa`}</b></div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="alloc-tablewrap alloc-plantable">
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
                      {onPlaceOrder && (
                        <button className="alloc-btn alloc-place" data-alloc-place={r.marketId}
                          onClick={() => onPlaceOrder(targetFromPlanRow(r))}
                          title="Apre il pannello ordine su QUESTO mercato, con la size decisa dal piano.">
                          Piazza ordine →
                        </button>
                      )}
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
                      {r.belowVenueMinSize ? (
                        <span className="oob" data-alloc-belowmin-gross
                              title={`Il venue non assegna punteggio agli ordini sotto ${r.minSizeShares ?? '—'} share (min_incentive_size): con questo capitale l'ordine non e' scorato, quindi il reward e' zero.`}>
                          <s>{perDay(r.grossInBandPerDay)}</s> $0,00/g · capitale insufficiente per la size minima del venue
                          {r.capitalToQualifyUsd != null && <small style={{ display: 'block' }}>servono almeno {money(r.capitalToQualifyUsd)} ({r.minSizeShares} share/lato)</small>}
                        </span>
                      ) : c.inBand === false ? <span className="oob" data-alloc-oob-gross><s>{perDay(r.grossInBandPerDay)}</s> $0,00/g · fuori banda</span>
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

          {/* Mercati che la size minima del venue esclude a QUESTO capitale: sparirebbero dalla tabella
              senza spiegazione, e la domanda dell'operatore e' esattamente "perche' quel mercato non c'e'". */}
          {Array.isArray(plan.belowMinSize) && plan.belowMinSize.length > 0 && (
            <div className="alloc-note" data-alloc-belowmin-list style={{ marginTop: 8, fontSize: 12 }}>
              <b>{plan.belowMinSize.length} mercati esclusi dalla size minima del venue</b> — con questo capitale
              l'ordine starebbe sotto <code>min_incentive_size</code> e non verrebbe scorato:{' '}
              {plan.belowMinSize.slice(0, 6).map((b, i) => (
                <span key={b.marketId}>{i > 0 ? ' · ' : ''}{b.name || b.shortId} (min {b.minSizeShares} share
                  {b.capitalToQualifyUsd != null ? `, servono ${money(b.capitalToQualifyUsd)}` : ''})</span>
              ))}
              {plan.belowMinSize.length > 6 && <span> · +{plan.belowMinSize.length - 6} altri</span>}
            </div>
          )}
          {/* ── IL RIEPILOGO FINALE ───────────────────────────────────────────────────────────────────
              Capitale allocato, non allocato, mercati che qualificano davvero e stima realistica: le
              quattro cifre con cui si decide, tutte visibili insieme. Una cifra che vale zero resta a
              schermo con la nota rossa che dice perche' — sotto la size minima del venue, oppure fuori
              banda — invece di sparire e lasciar credere che quel capitale stia lavorando. */}
          <div className="alloc-sum" data-alloc-summary>
            <div><span>Capitale allocato</span><b>{money(plan.totals.capital)}</b></div>
            <div>
              <span>Non allocato</span>
              <b className={plan.totals.unallocated > 0 ? 'ex-gold' : ''}>{money(plan.totals.unallocated)}</b>
              {plan.totals.unallocated > 0 && <p className="ex-why ex-why-warn">capitale fermo: non matura nulla finche non e a riposo in banda</p>}
            </div>
            <div>
              <span>Mercati che qualificano</span>
              <b className={computed.qualifyingCount === 0 ? 'ex-dn' : ''} data-alloc-qualifying>
                {computed.qualifyingCount} / {computed.rows.length}
              </b>
              {(computed.belowMinCount > 0 || computed.outOfBandCount > 0) && (
                <p className="ex-why">
                  {computed.belowMinCount > 0 && <>{computed.belowMinCount} sotto la size minima del venue</>}
                  {computed.belowMinCount > 0 && computed.outOfBandCount > 0 && ' · '}
                  {computed.outOfBandCount > 0 && <>{computed.outOfBandCount} fuori banda</>}
                  {' '}— rendono $0,00/g
                </p>
              )}
            </div>
            <div>
              <span>Stima realistica</span>
              <b data-alloc-summary-realistic>{perDay(computed.realisticNow)}</b>
              {computed.realisticUnknownCount > 0 && (
                <p className="ex-why">{computed.realisticUnknownCount} righe non stimabili, escluse da questo totale</p>
              )}
            </div>
            <div><span>Lordo atteso</span><b data-alloc-total-gross>{perDay(computed.grossNow)}</b></div>
            {/* La SECONDA cifra nel totale, affiancata alla lorda — mai al suo posto. */}
            <div>
              <span>Lordo corretto</span>
              <b data-alloc-total-realistic>{perDay(computed.realisticNow)}
                {computed.realisticGrossOfCounted > 0 && (
                  <small className="alloc-cat"> ({Math.round((computed.realisticNow / computed.realisticGrossOfCounted) * 100)}% del lordo delle stesse righe)</small>
                )}
              </b>
            </div>
            <div><span>vs offset default</span><b>{perDay(computed.grossDefault)}{computed.anyOverride ? <small className="alloc-cat"> ({money(computed.grossNow - computed.grossDefault)}/g)</small> : ''}</b></div>
            <div><span>Netto atteso</span><b>{computed.netNow == null ? '—' : perDay(computed.netNow)}</b></div>
            <div><span>Fill attesi</span><b data-alloc-total-fills>{computed.fillsNow}</b></div>
            <div><span>+1 tick a tutte</span><b data-alloc-widen-cost>{perDay(computed.grossWider)}<small className="alloc-cat"> ({money(computed.grossWider - computed.grossNow)}/g lordo)</small></b></div>
          </div>

          {/* CRITICAL: the S=1 ceiling caveat — renders whenever any row is wider than its computed default with
              gross unchanged/improved. Never present a wider offset as free. */}
          {computed.artifactCount > 0 && (
            <div className="alloc-note alloc-warn" data-alloc-s1-caveat
                 title="Il lordo del replay e il tetto S=1 e non modella il decadimento del punteggio quando il quote si allontana dal mid; l accumulo reale dei reward cala con la distanza, quindi il costo vero di allargare e sottostimato qui.">
              ⚠ <b>Allargare non è gratis.</b> {computed.artifactCount} {computed.artifactCount === 1 ? 'riga' : 'righe'} con lordo
              invariato oltre il default: artefatto del modello (tetto S=1), non un guadagno.
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
          <details className="alloc-note alloc-warn" data-alloc-realistic-note>
            <summary className="alloc-summary">
              <b>Due cifre, non una</b> — «lordo» è teorico, «realistico» applica correzioni dichiarate
            </summary>
            <p style={{ margin: '6px 0 0' }}>
              «Lordo/g» = montepremi × quota modellata, ordine <b>esattamente sul mid</b> e a riposo{' '}
              <b>tutto il giorno</b>. «Realistico/g» parte da lì e applica, una per una:
            </p>
            <ul style={{ margin: '6px 0 6px 18px', padding: 0 }}>
              <li title="La formula pubblicata S=((v-s)/v)^2 fa crollare il punteggio man mano che ti allontani dal mid. Un ordine a 1 tick da una banda di +/-2,25 centesimi vale il 31% del massimo, non il 100%. E la correzione piu grande e non e un opinione: e la stessa formula con cui il venue paga."><b>Punteggio reale</b> <i>(calcolo)</i> — S=((v−s)/v)²: a 1 tick vale il <b>31%</b>, non il 100%.</li>
              <li title="Se il pool e stato tagliato la stima viene scontata di conseguenza. Se e cresciuto, l aumento e segnalato ma non incassato."><b>Andamento montepremi</b> <i>(misurato 48h)</i> — taglio scontato, crescita non incassata.</li>
              <li title="Se la tua quota modellata sarebbe sproporzionata e un rischio, non un occasione. Dove in banda non c e nessun altro la formula ti darebbe il 100% del montepremi, ma e una divisione per un book che non esiste."><b>Mercato sottile</b> <i>(assunzione)</i> — book vuoto in banda ⇒ stima <b>ritirata</b>, non gonfiata.</li>
              <li title="I premi si campionano una volta al minuto, 1.440 campioni al giorno, e ogni cancella-ripiazza e tempo senza ordine a riposo. Di solito vale pochi decimi di punto; qui e calcolato, non ipotizzato."><b>Buchi di copertura</b> <i>(misurato)</i> — 1.440 campioni/giorno, ogni riprezzo è tempo scoperto.</li>
              <li title="Dove il nastro ha prodotto esecuzioni reali si sottrae il markout misurato; dove non ce ne sono si sottrae una percentuale dichiarata e volutamente grezza."><b>Selezione avversa</b> <i>(misurata o assunta)</i> — markout reale dove c’è, percentuale grezza dove manca.</li>
            </ul>
            <p style={{ margin: '6px 0 0' }}>
              <b>Resta una stima.</b> Le voci <i>assunzione</i> non sono misurate.
              {computed.realisticUnknownCount > 0 && <> {computed.realisticUnknownCount} {computed.realisticUnknownCount === 1 ? 'riga' : 'righe'} «non stimabile», {computed.realisticUnknownCount === 1 ? 'esclusa' : 'escluse'} dal totale.</>}
            </p>
          </details>
          <div className="alloc-sub" style={{ marginTop: 6 }} data-alloc-apy-both>
            Annualizzato sul capitale: <b>{plan.annualisedGross.pct == null ? '—' : `${plan.annualisedGross.pct.toFixed(0)}%`}</b> lordo
            {' vs '}<b>{plan.annualisedRealistic.pct == null ? '—' : `${plan.annualisedRealistic.pct.toFixed(0)}%`}</b> realistico.
            Cifre a tre o quattro zeri = capitale piccolo rispetto ai pot dei mercati sottili: <b>run-rate</b>.
          </div>
          <div className="alloc-sub" style={{ marginTop: 6 }}>{plan.annualisedGross.label}. Il netto per-mercato è “—” dove non è stato osservato alcun fill reale. Un offset oltre il raggio di banda (maxSpread/2) porta il lordo a $0: la riga lo dice, non mostra un piccolo positivo.</div>

          {/* ── ESEGUI ALLOCAZIONE ─────────────────────────────────────────────────────────────────
              Due passi obbligatori: prima l'anteprima (che percorre la stessa aritmetica del cap senza
              inviare nulla), poi la conferma. Un bottone singolo che piazza dieci ordini reali al primo
              click e' il tipo di comando che si preme per sbaglio una volta sola. */}
          <div className="alloc-card" data-alloc-bulk style={{ borderColor: '#2E5FBE' }}>
            <div className="alloc-h" style={{ fontSize: 15 }}>Esegui allocazione</div>
            <div className="alloc-sub" title="Ogni ordine passa dagli stessi gate di un ordine a mano (validateOrder, kill-switch, cap) e finisce sotto la stessa gestione del watcher: inseguimento del mid, vincolo di banda, rinnovo GTD, riconciliazione.">
              Piazza <b>in sequenza</b> le righe qui sopra, stesso mercato/lato/prezzo/size. Stessi gate di un
              ordine a mano.
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
          <div className="alloc-sub" style={{ marginTop: 6 }} data-alloc-persist-note
               title="Sopravvive al reload ed e riproducibile: stesso capitale piu stessa mappa produce la stessa allocazione. E una preferenza di visualizzazione, non un ordine ne un istruzione a operare.">
            Offset salvati nel <b>browser</b> (localStorage, per-capitale) — preferenza di visualizzazione, locale.
          </div>
        </div>
      )}
      {plan && !plan.error && plan.rows.length === 0 && Number(capital) > 0 && !loading && (
        <div className="alloc-sub" style={{ margin: '8px 2px' }}>Nessun mercato allocato per questo capitale.</div>
      )}
    </div>
  );
}

// NOTE: keep this stylesheet free of the characters React escapes in text nodes — quotes, angle
// brackets, ampersands. As the child of a style element they are serialised escaped on the server and
// raw on the client, which is a hydration mismatch that takes the whole root down to client rendering.
const CSS = `
.alloc-root { max-width: 1080px; margin: 0 auto; padding: 12px 12px 40px; font-size: 13px; line-height: 1.5; }
.alloc-card { background: var(--ex-panel); border: 1px solid var(--ex-line); border-radius: 8px;
  padding: 12px 14px; margin: 10px 0; }
.alloc-h { font-weight: 700; font-size: 15px; margin: 0 0 4px; letter-spacing: -.01em; }
.alloc-sub { color: var(--ex-txt-2); font-size: 11.5px; line-height: 1.5; }
.alloc-addr { font-family: var(--ex-mono); font-size: 11px; }
.alloc-in { min-height: 40px; padding: 0 10px; width: 180px; border-radius: 6px;
  border: 1px solid var(--ex-line); background: #0D1114; color: var(--ex-txt);
  font-family: var(--ex-mono); font-size: 14px; font-variant-numeric: tabular-nums; }
.alloc-in:focus { outline: none; border-color: var(--ex-gold); }
.alloc-btn { min-height: 40px; min-width: 40px; padding: 0 13px; border-radius: 6px;
  border: 1px solid var(--ex-line); background: var(--ex-panel-2); color: var(--ex-txt);
  font-family: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; touch-action: manipulation; }
.alloc-btn:hover { border-color: var(--ex-gold); color: var(--ex-gold); }
.alloc-btn:disabled { opacity: .45; cursor: not-allowed; }
.alloc-note { border-left: 2px solid var(--ex-gold); padding: 8px 11px; margin: 10px 0;
  background: var(--ex-gold-bg); border-radius: 0 6px 6px 0; font-size: 12px; line-height: 1.55;
  color: var(--ex-txt-2); }
.alloc-warn { border-left-color: var(--ex-red); background: var(--ex-red-bg); color: #FF9AA8; }
.alloc-tablewrap { overflow-x: auto; -webkit-overflow-scrolling: touch;
  border: 1px solid var(--ex-line); border-radius: 8px; }

/* LE STESSE RIGHE, PER TELEFONO. Nascoste da desktop, dove la tabella a 17 colonne resta la vista
   migliore; sotto i 900px si scambiano. Nessun numero viene ricalcolato li: le schede leggono gli
   stessi oggetti della tabella. */
.alloc-cards { display: none; flex-direction: column; gap: 8px; }
.ac { border: 1px solid var(--ex-line); border-radius: 8px; padding: 11px 12px; background: var(--ex-panel); }
.ac-top { display: flex; gap: 10px; align-items: flex-start; justify-content: space-between; }
.ac-name { font-size: 13px; font-weight: 600; line-height: 1.3; min-width: 0; overflow-wrap: anywhere; }
/* LO ZERO SI VEDE, E SOTTO C E IL PERCHE. Una riga che rende $0 resta a schermo con la sua cifra e
   la nota rossa che la spiega — nasconderla e come dire che il mercato sta guadagnando. */
.ac-zero { margin-top: 8px; font-size: 11.5px; line-height: 1.45; color: var(--ex-red);
  border-radius: 6px; padding: 7px 9px; border: 1px solid var(--ex-red-bd); background: var(--ex-red-bg); }
.ac-nums { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
.ac-num span { display: block; font-size: 9.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--ex-txt-3); }
.ac-num b { display: block; font-size: 15px; font-family: var(--ex-mono); font-variant-numeric: tabular-nums;
  line-height: 1.2; overflow-wrap: anywhere; margin-top: 2px; }
.ac-off { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; }
.ac-off-k { font-size: 9.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--ex-txt-3); }
.ac-warn { font-size: 11.5px; margin-top: 6px; line-height: 1.45; }
.ac-more { min-height: 40px; width: 100%; margin-top: 8px; border: 1px solid var(--ex-line);
  border-radius: 6px; background: transparent; color: var(--ex-txt-2); font-family: inherit;
  font-size: 12px; font-weight: 700; cursor: pointer; touch-action: manipulation; }
.ac-more:hover { color: var(--ex-gold); border-color: var(--ex-gold); }
.ac-det { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; margin-top: 10px;
  border-top: 1px solid var(--ex-line); padding-top: 10px; }
.ac-det span { display: block; font-size: 9.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--ex-txt-3); }
.ac-det b { display: block; font-size: 12.5px; font-family: var(--ex-mono); font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere; }
/* Scoped alla SOLA tabella del piano: alloc-tablewrap veste anche la tabella di ricerca e quella dei
   risultati di esecuzione, che su telefono devono restare (scorrono in orizzontale). */
@media (max-width: 900px) { .alloc-cards { display: flex; } .alloc-plantable { display: none; } }

/* ── L AZIONE RESTA SOTTO IL POLLICE ──────────────────────────────────────────────────────────────
   La tabella di ricerca e larga 980px e la colonna «Aggiungi» e l ottava di otto: su un telefono da
   390px cominciava oltre gli 800px, cioe fuori schermo di due volte la larghezza del display. Il
   pulsante c era ed era premibile — semplicemente non lo si raggiungeva senza scoprire che la tabella
   scorre in orizzontale. Adesso l ultima colonna e ancorata al bordo destro: scorre il resto, l azione
   resta ferma e visibile. Nessun cambiamento di comportamento, solo di posizione. */
.alloc-place { margin-top: 6px; font-size: 11px; padding: 5px 9px; border-color: var(--ex-gold-bd);
  color: var(--ex-gold); background: var(--ex-gold-bg); }
.alloc-place:hover { border-color: var(--ex-gold); }
.alloc-searchtable td:last-child,
.alloc-searchtable th:last-child {
  position: sticky; right: 0; z-index: 1;
  background: var(--ex-panel);
  box-shadow: -10px 0 10px -10px rgba(0, 0, 0, .65);
}
.alloc-searchtable th:last-child { background: var(--ex-panel-2); z-index: 3; }

/* ── LA TABELLA — ogni cella numerica in monospazio tabulare. ─────────────────────────────────────── */
table.alloc { border-collapse: collapse; width: 100%; min-width: 1360px; font-size: 12px;
  font-family: var(--ex-mono); font-variant-numeric: tabular-nums; }
table.alloc th, table.alloc td { padding: 7px 9px; border-bottom: 1px solid var(--ex-line-soft);
  text-align: right; white-space: nowrap; }
table.alloc th { position: sticky; top: 0; background: var(--ex-panel-2); font-family: var(--ex-sans);
  font-weight: 700; color: var(--ex-txt-3); font-size: 9.5px; text-transform: uppercase; letter-spacing: .06em;
  border-bottom: 1px solid var(--ex-line); }
table.alloc td.name, table.alloc th.name { text-align: left; white-space: normal; min-width: 170px;
  font-family: var(--ex-sans); }
table.alloc td.dash { color: var(--ex-txt-3); }
.alloc-cat { color: var(--ex-txt-3); font-size: 10.5px; font-family: var(--ex-sans); }

/* ── IL RIEPILOGO FINALE — una striscia densa, non una lista. ─────────────────────────────────────── */
.alloc-sum { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 1px;
  background: var(--ex-line); border: 1px solid var(--ex-line); border-radius: 8px; overflow: hidden;
  margin-top: 12px; }
.alloc-sum div { background: var(--ex-panel); padding: 9px 11px; min-width: 0; }
.alloc-sum div span { display: block; color: var(--ex-txt-3); font-size: 9.5px; letter-spacing: .05em;
  text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.alloc-sum div b { display: block; margin-top: 3px; font-size: 15px; font-family: var(--ex-mono);
  font-variant-numeric: tabular-nums; line-height: 1.2; overflow-wrap: anywhere; }

.alloc-front { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 6px; }
.alloc-chip { font-family: var(--ex-mono); font-variant-numeric: tabular-nums; font-size: 11px;
  border: 1px solid var(--ex-line); border-radius: 3px; padding: 2px 8px; white-space: nowrap;
  background: var(--ex-panel-2); color: var(--ex-txt-2); }
.alloc-basis { border: 1px solid var(--ex-gold-bd); border-radius: 8px; padding: 11px 14px; margin: 12px 0;
  background: var(--ex-gold-bg); }
.alloc-basis-h { font-weight: 700; font-size: 13px; letter-spacing: .01em; margin-bottom: 6px; color: var(--ex-gold); }
.alloc-basis-ul { margin: 0; padding-left: 16px; }
.alloc-basis-ul li { margin: 5px 0; font-size: 12px; line-height: 1.55; color: var(--ex-txt-2); }
/* Il blocco che spiega le due cifre resta per intero, ma richiuso: e' materiale di riferimento,
   non qualcosa che si rilegge a ogni ricalcolo. */
.alloc-summary { cursor: pointer; list-style: none; min-height: 34px; display: flex; align-items: center; }
.alloc-summary::-webkit-details-marker { display: none; }
.alloc-summary::before { content: none; }
details[data-alloc-realistic-note] .alloc-summary::after { content: none; }

/* ── Controllo offset per riga ─────────────────────────────────────────────────────────────────── */
.off-ctl { display: inline-flex; align-items: center; gap: 4px; justify-content: flex-end; }
.off-step { min-width: 40px; min-height: 40px; padding: 0; border-radius: 6px;
  border: 1px solid var(--ex-line); background: var(--ex-panel-2); color: var(--ex-txt);
  font-family: inherit; font-size: 16px; font-weight: 700; cursor: pointer; line-height: 1;
  touch-action: manipulation; }
.off-step:hover { border-color: var(--ex-gold); color: var(--ex-gold); }
.off-step:disabled { opacity: .35; cursor: not-allowed; }
.off-val { min-width: 74px; text-align: center; font-family: var(--ex-mono); font-variant-numeric: tabular-nums; }
.off-val b { font-size: 13px; }
.off-val small { display: block; font-size: 10px; color: var(--ex-txt-3); }
.off-reset { min-width: 32px; min-height: 40px; border: none; background: transparent;
  color: var(--ex-txt-3); cursor: pointer; font-size: 14px; }
.off-reset:hover { color: var(--ex-gold); }
.off-over { color: var(--ex-gold); font-weight: 700; }
.oob { color: var(--ex-red); font-weight: 600; }
.fresh-ok { color: var(--ex-green); }
.fresh-stale { color: var(--ex-gold); font-weight: 700; }

/* Quattro stati di banda, ognuno con un ETICHETTA TESTUALE — mai solo colore: telefono al sole e
   daltonismo devono leggere lo stesso verdetto. */
.band-badge { display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 3px;
  border: 1px solid; white-space: nowrap; font-family: var(--ex-sans); }
.band-comfortable { color: var(--ex-green); border-color: var(--ex-green-bd); background: var(--ex-green-bg); }
.band-edge { color: var(--ex-gold); border-color: var(--ex-gold-bd); background: var(--ex-gold-bg); }
.band-out { color: var(--ex-red); border-color: var(--ex-red-bd); background: var(--ex-red-bg); }
.band-unknown { color: var(--ex-txt-2); border: 1px dashed var(--ex-unk-bd); background: transparent; }
.band-room { display: block; font-size: 10px; color: var(--ex-txt-3); margin-top: 2px; white-space: nowrap; }
.step-danger { border-color: var(--ex-red) !important; color: var(--ex-red) !important;
  background: var(--ex-red-bg) !important; }

.fresh-bar { display: flex; flex-wrap: wrap; gap: 5px 14px; align-items: center; font-size: 11px;
  margin: 2px 0 8px; color: var(--ex-txt-3); }
.gross-bar { display: block; height: 3px; min-width: 44px; border-radius: 999px; margin-top: 4px;
  background: var(--ex-line); overflow: hidden; }
.gross-bar i { display: block; height: 100%; border-radius: 999px; background: var(--ex-gold); }
.fresh-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px;
  vertical-align: baseline; }
/* Etichetta TESTUALE (mai solo colore): un mercato senza montepremi va letto come tale anche su uno
   schermo al sole o da chi non distingue i colori. */
.no-reward-badge { display: inline-block; margin-top: 3px; font-size: 10px; font-weight: 700;
  letter-spacing: .02em; padding: 1px 6px; border-radius: 3px; color: var(--ex-gold);
  border: 1px solid var(--ex-gold-bd); background: var(--ex-gold-bg); white-space: normal;
  font-family: var(--ex-sans); }
@media (max-width: 430px) { .alloc-in { width: 44vw; } }
`;
