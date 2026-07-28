'use client';

// RewardsAllocatePanel — PUBLIC allocation planner for the liquidity-rewards maker.
//
// It reads the operator's real proxy pUSD balance (/api/rewards/balance) and the capital allocation plan
// (/api/rewards/allocate) and displays them. It PLANS and DISPLAYS ONLY: there is no fetch, handler, or
// import here that constructs, signs, arms or places an order — every interactive control below either sets
// a local number or GETs one of those two read-only routes. No private key is ever read, logged or echoed.

import { useCallback, useEffect, useState } from 'react';

type Balance = {
  proxy: string | null; proxySource: string | null; signer: string | null;
  pusdBalance: number | null; rpcReachable: boolean; readAt: string | null;
  ageSeconds: number | null; stale: boolean; latencyMs: number | null; cadenceSeconds: number; note: string;
};
type Row = {
  marketId: string; name: string | null; category: string | null; nameAvailable: boolean; shortId: string;
  capital: number; sizePerSideUsd: number; sizePerSideShares: number | null;
  snappedBid: number | null; snappedAsk: number | null; tick: number | null; offsetCents: number;
  depthShares: number | null; grossPerDay: number | null; netPerDay: number | null; fills: number;
};
type Plan = {
  requested: number; capital: number; unit: number; offsetCents: number;
  coverage: { coveredMarketCount: number | null; truePct: number | null; trueNote: string; headerLines: string[] };
  staleFrac: number; rows: Row[];
  totals: { capital: number; unallocated: number; grossPerDay: number; netPerDay: number | null; count: number };
  annualisedGross: { pct: number | null; capped: boolean; cap: number; label: string };
  frontier: { count: number; net: number }[];
  error?: string;
};

const money = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '—' : `$${v.toFixed(2)}`);
const shares = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(1));
const price = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(3));
const perDay = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '—' : `$${v.toFixed(2)}/g`);
const trunc = (a: string | null): string => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');
const ageText = (s: number | null): string => (s == null ? '—' : s < 90 ? `${s}s fa` : s < 5400 ? `${Math.round(s / 60)} min fa` : `${(s / 3600).toFixed(1)} h fa`);
const FRONTIER_MARKS = [1, 2, 3, 5, 10, 20];

export default function RewardsAllocatePanel() {
  const [bal, setBal] = useState<Balance | null>(null);
  const [balLoaded, setBalLoaded] = useState(false);
  const [capital, setCapital] = useState<string>(''); // the operator's typed value — NEVER rewritten by us
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [touched, setTouched] = useState(false);

  // read the real balance once; default the input to it (only before the operator has typed).
  useEffect(() => {
    let alive = true;
    fetch('/api/rewards/balance').then((r) => r.json()).then((b: Balance) => {
      if (!alive) return;
      setBal(b); setBalLoaded(true);
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
      .then((r) => r.json()).then((p: Plan) => setPlan(p)).catch(() => setPlan({ error: 'errore' } as any)).finally(() => setLoading(false));
  }, []);

  const balanceNum = bal && bal.pusdBalance != null ? bal.pusdBalance : null;
  const capitalNum = Number(capital);
  const overBalance = balanceNum != null && Number.isFinite(capitalNum) && capitalNum > balanceNum;

  return (
    <div className="alloc-root">
      <style>{`
        .alloc-root{color:var(--ds-text);max-width:960px;margin:0 auto;padding:16px 12px 48px;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
        .alloc-card{background:color-mix(in srgb,var(--ds-text) 3%,transparent);border:1px solid var(--ds-border);border-radius:12px;padding:14px 16px;margin:12px 0}
        .alloc-h{font-weight:600;font-size:18px;margin:0 0 4px}
        .alloc-sub{color:color-mix(in srgb,var(--ds-text) 55%,transparent);font-size:12.5px}
        .alloc-addr{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
        .alloc-in{font:16px ui-monospace,monospace;background:var(--ds-bg);color:var(--ds-text);border:1px solid var(--ds-border);border-radius:8px;padding:10px 12px;width:180px;min-height:44px}
        .alloc-btn{min-height:44px;min-width:44px;padding:8px 14px;border-radius:8px;border:1px solid var(--ds-border);background:color-mix(in srgb,var(--ds-accent) 14%,transparent);color:var(--ds-text);font-weight:600;cursor:pointer}
        .alloc-note{border-left:3px solid var(--ds-accent);padding:8px 12px;margin:10px 0;background:color-mix(in srgb,var(--ds-accent) 8%,transparent);border-radius:0 8px 8px 0;font-size:13px}
        .alloc-warn{border-left-color:#d9a441;background:color-mix(in srgb,#d9a441 12%,transparent)}
        .alloc-tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--ds-border);border-radius:10px}
        table.alloc{border-collapse:collapse;width:100%;min-width:760px;font-size:13px}
        table.alloc th,table.alloc td{padding:8px 10px;border-bottom:1px solid var(--ds-border);text-align:right;white-space:nowrap}
        table.alloc th{position:sticky;top:0;background:var(--ds-bg);font-weight:600;color:color-mix(in srgb,var(--ds-text) 70%,transparent);font-size:11.5px;text-transform:uppercase;letter-spacing:.03em}
        table.alloc td.name,table.alloc th.name{text-align:left;white-space:normal;min-width:180px}
        table.alloc td.dash{color:color-mix(in srgb,var(--ds-text) 45%,transparent)}
        .alloc-cat{color:color-mix(in srgb,var(--ds-text) 50%,transparent);font-size:11.5px}
        .alloc-sum{display:flex;flex-wrap:wrap;gap:14px 26px;margin-top:10px}
        .alloc-sum div span{display:block;color:color-mix(in srgb,var(--ds-text) 55%,transparent);font-size:11.5px}
        .alloc-sum div b{font-size:17px;font-variant-numeric:tabular-nums}
        .alloc-front{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
        .alloc-chip{font-variant-numeric:tabular-nums;font-size:12px;border:1px solid var(--ds-border);border-radius:999px;padding:3px 9px;white-space:nowrap}
        .alloc-basis{border:1px solid var(--ds-accent);border-radius:12px;padding:12px 16px;margin:14px 0;background:color-mix(in srgb,var(--ds-accent) 7%,transparent)}
        .alloc-basis-h{font-weight:700;font-size:14px;letter-spacing:.02em;margin-bottom:6px}
        .alloc-basis-ul{margin:0;padding-left:18px}
        .alloc-basis-ul li{margin:5px 0;font-size:13px;line-height:1.5}
        @media(max-width:430px){.alloc-in{width:44vw}}
      `}</style>

      <h1 className="alloc-h">Allocazione capitale · liquidity rewards</h1>
      <p className="alloc-sub">Inserisci un capitale: l’ottimizzatore lo distribuisce sui mercati con la dimensione per-mercato corretta (knapsack sulla profondità reale in-band e sul pot), non in parti uguali.</p>

      {/* BASIS & LIMITS — unmissable, plain Italian, not softened. */}
      <div className="alloc-basis" data-alloc-basis>
        <div className="alloc-basis-h">Cos’è questa pagina — e cosa NON è</div>
        <ul className="alloc-basis-ul">
          <li><b>È un piano calcolato su dati osservati, non un ordine.</b> Nessun ordine viene creato, firmato o inviato guardando o usando questa pagina. Non viene mosso alcun capitale.</li>
          <li><b>Le cifre sono LORDE.</b> L’adverse selection (il costo di essere selezionati quando il prezzo si muove contro) è misurata a parte: il netto è mostrato solo dove è stato osservato un fill reale, altrimenti “—”. Non sommare il lordo come se fosse un rendimento.</li>
          <li><b>Il backtest dietro questa allocazione è un campione MOLTO piccolo:</b> ~20% di copertura dell’universo reward collezionabile, su una finestra di 48,8 ore, con <b>11 fill osservati su 4 mercati</b>. Il comportamento di riempimento per-mercato è quindi statisticamente esile.</li>
          <li><b>I pot dei reward si muovono.</b> Durante lo studio il lordo è sceso del <b>36% in due giorni</b>. Nessuna cifra qui è garantita: è un run-rate, non una promessa.</li>
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
              <div className="alloc-sub">letto {ageText(bal?.ageSeconds ?? null)}{bal?.stale ? ' · NON aggiornato (lettura fallita, valore precedente)' : ''}</div>
            </div>
            <div className="alloc-sub" style={{ marginTop: 6 }}>
              <span className="alloc-addr">funder (proxy): {trunc(bal?.proxy ?? null)}</span>
              {' · '}
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

      {/* ALLOCATION */}
      {loading && <div className="alloc-sub" style={{ margin: '8px 2px' }}>calcolo dell’allocazione…</div>}
      {plan && !plan.error && plan.rows.length > 0 && (
        <div className="alloc-card">
          <div className="alloc-h" style={{ fontSize: 15 }}>Allocazione su {plan.totals.count} mercati</div>
          <div className="alloc-tablewrap">
            <table className="alloc">
              <thead>
                <tr>
                  <th className="name">Mercato</th><th>Capitale</th><th>$/lato</th><th>Quote/lato</th>
                  <th>Bid</th><th>Ask</th><th>Tick</th><th>Depth (quote)</th><th>Lordo/g</th><th>Netto/g</th>
                </tr>
              </thead>
              <tbody>
                {plan.rows.map((r) => (
                  <tr key={r.marketId}>
                    <td className="name">
                      {r.nameAvailable ? r.name : <span><span className="alloc-addr">{r.shortId}</span> <span className="alloc-cat">· nome non disponibile</span></span>}
                      {r.category && <div className="alloc-cat">{r.category}</div>}
                    </td>
                    <td>{money(r.capital)}</td>
                    <td>{money(r.sizePerSideUsd)}</td>
                    <td className={r.sizePerSideShares == null ? 'dash' : ''}>{shares(r.sizePerSideShares)}</td>
                    <td className={r.snappedBid == null ? 'dash' : ''}>{price(r.snappedBid)}</td>
                    <td className={r.snappedAsk == null ? 'dash' : ''}>{price(r.snappedAsk)}</td>
                    <td className={r.tick == null ? 'dash' : ''}>{r.tick == null ? '—' : r.tick} <span className="alloc-cat">(+{r.offsetCents}¢)</span></td>
                    <td className={r.depthShares == null ? 'dash' : ''}>{shares(r.depthShares)}</td>
                    <td className={r.grossPerDay == null ? 'dash' : ''}>{perDay(r.grossPerDay)}</td>
                    <td className={r.netPerDay == null ? 'dash' : ''} data-alloc-net>{r.netPerDay == null ? '—' : perDay(r.netPerDay)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="alloc-sum">
            <div><span>Capitale allocato</span><b>{money(plan.totals.capital)}</b></div>
            <div><span>Non allocato (resto)</span><b>{money(plan.totals.unallocated)}</b></div>
            <div><span>Lordo atteso</span><b>{perDay(plan.totals.grossPerDay)}</b></div>
            <div><span>Netto atteso</span><b>{plan.totals.netPerDay == null ? '—' : perDay(plan.totals.netPerDay)}</b></div>
            <div><span>Annualizzato (lordo)</span><b>{plan.annualisedGross.pct == null ? '—' : plan.annualisedGross.capped ? `>${plan.annualisedGross.cap}%/anno` : `${plan.annualisedGross.pct.toFixed(1)}%/anno`}</b></div>
            <div><span>Mercati</span><b>{plan.totals.count}</b></div>
          </div>
          <div className="alloc-sub" style={{ marginTop: 6 }}>{plan.annualisedGross.label}. Il netto per-mercato è “—” dove non è stato osservato alcun fill reale.</div>

          <div style={{ marginTop: 14 }}>
            <div className="alloc-sub">Frontiera netto/g per numero di mercati tenuti (perché l’ottimizzatore si ferma dove si ferma):</div>
            <div className="alloc-front">
              {FRONTIER_MARKS.map((c) => {
                const f = plan.frontier.find((x) => x.count === c);
                return <span key={c} className="alloc-chip">{c} mkt: {f ? `$${f.net.toFixed(1)}/g` : '—'}</span>;
              })}
            </div>
          </div>

          <div className="alloc-sub" style={{ marginTop: 12 }}>{plan.coverage.trueNote}</div>
        </div>
      )}
      {plan && !plan.error && plan.rows.length === 0 && Number(capital) > 0 && !loading && (
        <div className="alloc-sub" style={{ margin: '8px 2px' }}>Nessun mercato allocato per questo capitale.</div>
      )}
    </div>
  );
}
