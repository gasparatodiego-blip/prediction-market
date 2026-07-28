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

type Balance = {
  proxy: string | null; proxySource: string | null; signer: string | null;
  pusdBalance: number | null; rpcReachable: boolean; readAt: string | null;
  ageSeconds: number | null; stale: boolean; latencyMs: number | null; cadenceSeconds: number; note: string;
};
type FillTick = { tick: number; offsetCents: number | null; fills: number; costPerDay: number | null; bid: number | null; ask: number | null };
type Row = {
  marketId: string; name: string | null; category: string | null; nameAvailable: boolean; shortId: string;
  capital: number; sizePerSideUsd: number; sizePerSideShares: number | null;
  tick: number | null; mid: number | null; depthShares: number | null; newestTsMs: number | null;
  endDate: string | null;
  maxSpreadCents: number | null; grossInBandPerDay: number | null; defaultOffsetTicks: number;
  computedDefaultOffsetTicks: number; defaultReason: string; defaultNetDerived: boolean; grossMaxDefaultTicks: number;
  fillScore: number | null; fillsByTick: FillTick[];
};
type Plan = {
  requested: number; capital: number; unit: number; offsetCents: number;
  coverage: { coveredMarketCount: number | null; truePct: number | null; trueNote: string; headerLines: string[] };
  staleFrac: number; rows: Row[];
  observed: { totalFills: number; filledMarkets: number; windowHours: number };
  fillScore: { auc: number | null; ci95: [number, number] | null; nFilled: number; nUnfilled: number; note: string };
  offsetFrontier: { offsetCents: number; fills: number; grossInBand: number; rewardLost: number }[];
  totals: { capital: number; unallocated: number; grossPerDay: number; netPerDay: number | null; count: number };
  annualisedGross: { pct: number | null; capped: boolean; cap: number; label: string };
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
  return { offsetTicks, offsetCents, bid: ft ? ft.bid : null, ask: ft ? ft.ask : null, inBand, bandKnown, gross, fills, cost, net, orderVsDepth, overridden: offsetTicks !== r.computedDefaultOffsetTicks, maxTick: r.fillsByTick.length ? r.fillsByTick[r.fillsByTick.length - 1].tick : 0 };
}

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
      return { r, c, ageS, unreadable, stale, usable: !unreadable && !stale, dRes };
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
    const ages = rows.map((x) => x.ageS).filter((a): a is number => a != null);
    return {
      rows, grossNow, grossDefault, grossWider, fillsNow, netNow, anyOverride: Object.keys(offsets).length > 0,
      staleCount: rows.filter((x) => x.stale).length, unreadableCount: rows.filter((x) => x.unreadable).length,
      usableCount: usable.length, newestAge: ages.length ? Math.min(...ages) : null, oldestAge: ages.length ? Math.max(...ages) : null,
      resDist,
    };
  }, [plan, offsets, nowMs]);

  const balanceNum = bal && bal.pusdBalance != null ? bal.pusdBalance : null;
  const capitalNum = Number(capital);
  const overBalance = balanceNum != null && Number.isFinite(capitalNum) && capitalNum > balanceNum;

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
        table.alloc{border-collapse:collapse;width:100%;min-width:1120px;font-size:13px}
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
        .fresh-bar{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;font-size:12px;margin:2px 0 8px;color:color-mix(in srgb,var(--ds-text) 60%,transparent)}
        .fresh-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:baseline}
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
              <button className="alloc-btn" style={{ minHeight: 44, background: 'transparent', fontSize: 13 }} data-alloc-reset-all onClick={resetAll}>Ripristina default</button>
              {recomputeMs != null && <span data-alloc-recompute-ms>· ricalcolo {recomputeMs.toFixed(1)} ms (locale, senza refetch)</span>}
            </div>
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
            {plan.fillScore.ci95 && plan.fillScore.ci95[0] <= 0.52
              ? <b style={{ color: '#d98a41' }}> Il limite inferiore dell’IC è vicino a 0,5: segnale al limite del rumore, non un filtro affidabile.</b>
              : <> Non è un filtro affidabile (0,5 = nessuna discriminazione, 1,0 = perfetta); usalo come spareggio, non come cancello.</>}
          </div>
          <div className="alloc-tablewrap">
            <table className="alloc">
              <thead>
                <tr>
                  <th className="name">Mercato</th><th>Capitale</th><th>$/lato</th><th>Scad. (gg)</th><th>Offset (tick / ¢ da mid)</th>
                  <th>Bid</th><th>Ask</th><th>Tick</th><th>Depth</th><th>Lordo/g</th><th>Netto/g</th><th>Fill attesi</th>
                  <th>Score fill</th><th>Ord/depth</th><th>Freschezza</th>
                </tr>
              </thead>
              <tbody>
                {computed.rows.map(({ r, c, ageS, stale, unreadable, dRes }) => (
                  <tr key={r.marketId} data-alloc-row data-alloc-usable={(!stale && !unreadable) ? '1' : '0'} style={{ opacity: (stale || unreadable) ? 0.55 : 1 }}>
                    <td className="name">
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
                        <button className="off-step" aria-label="aumenta offset" disabled={r.tick == null || effTicks(r) >= c.maxTick} onClick={() => setRowOffset(r.marketId, effTicks(r) + 1)}>+</button>
                        {c.overridden && <button className="off-reset" title="ripristina default" data-alloc-row-reset onClick={() => resetRow(r.marketId)}>↺</button>}
                      </span>
                    </td>
                    <td className={c.bid == null ? 'dash' : ''}>{price(c.bid)}</td>
                    <td className={c.ask == null ? 'dash' : ''}>{price(c.ask)}</td>
                    <td className={r.tick == null ? 'dash' : ''}>{r.tick == null ? '—' : r.tick}</td>
                    <td className={r.depthShares == null ? 'dash' : ''}>{shares(r.depthShares)}</td>
                    <td className={c.gross == null ? 'dash' : ''} data-alloc-gross>
                      {c.inBand === false ? <span className="oob">$0 · fuori banda</span> : (c.bandKnown === false && c.gross != null ? <span>{perDay(c.gross)}<small className="alloc-cat"> banda —</small></span> : perDay(c.gross))}
                    </td>
                    <td className={c.net == null ? 'dash' : ''} data-alloc-net>{c.net == null ? '—' : perDay(c.net)}</td>
                    <td className={c.fills == null ? 'dash' : ''} data-alloc-fills>{c.fills == null ? '—' : c.fills}</td>
                    <td className={r.fillScore == null ? 'dash' : ''} data-alloc-score>{r.fillScore == null ? '—' : r.fillScore.toFixed(2)}</td>
                    <td className={c.orderVsDepth == null ? 'dash' : ''} data-alloc-orderdepth>{c.orderVsDepth == null ? '—' : `${c.orderVsDepth.toFixed(2)}×`}</td>
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
            <div><span>vs offset default</span><b>{perDay(computed.grossDefault)}{computed.anyOverride ? <small className="alloc-cat"> ({money(computed.grossNow - computed.grossDefault)}/g)</small> : ''}</b></div>
            <div><span>Netto atteso</span><b>{computed.netNow == null ? '—' : perDay(computed.netNow)}</b></div>
            <div><span>Fill attesi totali</span><b data-alloc-total-fills>{computed.fillsNow}</b></div>
          </div>
          <div className="alloc-sub" style={{ marginTop: 6 }} data-alloc-totals-scope>
            I totali coprono i <b>{computed.usableCount} mercati con dati aggiornati</b>{computed.staleCount || computed.unreadableCount ? <> — esclusi <b>{computed.staleCount} stale</b>{computed.unreadableCount ? <> e <b>{computed.unreadableCount} illeggibili</b></> : ''} (dati troppo vecchi per pianificare il book attuale, non azzerati)</> : ''}.
          </div>
          <div className="alloc-sub" style={{ marginTop: 6 }}>{plan.annualisedGross.label}. Il netto per-mercato è “—” dove non è stato osservato alcun fill reale. Un offset oltre il raggio di banda (maxSpread/2) porta il lordo a $0: la riga lo dice, non mostra un piccolo positivo.</div>

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
            <div className="alloc-sub" style={{ marginTop: 4 }}>1¢ evita ~97% dei fill a costo reward zero (tutte le bande ≥ 2¢); oltre, ogni mercato che supera il proprio raggio di banda perde tutto il reward.</div>
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
