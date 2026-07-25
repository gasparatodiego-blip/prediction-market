'use client';

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// MARKET TERMINAL — ONE screen for one liquidity-reward market, from "is this worth touching?" to ARM.
//
// It replaces three disconnected views: the list's preview bar, the separate "Apri il book" page, and
// the separate "Scheda mercato". Splitting them meant the answer to "should I quote here" lived on a
// different page from the book that answers it and from the controls that would act on it — and the
// operator never actually arrived at placing anything. Everything now lives here, in the order the
// decision is actually made:
//
//   1  head + VERDICT     is this worth it at your size, and if not, exactly why
//   2  configure          total size, distance from the mid (tick-aware), which side
//   3  ONE book           a single YES ladder (NO = 1 − YES) with the reward band and your two orders
//   4  numbers            gross $/day, your weight on the book, net — with the adverse disclosure
//   5  per-order rules    follow-the-mid or pinned; what happens per side when a leg fills
//   5b risk limit         the per-market collateral ceiling that bounds inventory accumulation
//   6  execution          the four gates, each with its REAL state, ending in the two-step ARM
//   7  market data        the read-only declaration (identifiers, dates, venue rules, pUSD), collapsed
//   8  KILL               sticky, one tap, no dialog
//
// HONEST-ENGINE:
//   • Every number is a real read or "—". Nothing is defaulted to zero or inferred from a sibling.
//   • NET is never published as a figure: the adverse-selection cost is a MODEL with a 2–5% band, good
//     enough to say "this is not worth it" (that is section 1's job) and not good enough to print.
//   • No math is re-implemented here. Prices/share/$ come from lib/reward-price-row, the band test from
//     lib/rewards-live-band, the placement verdict from lib/maker/venue-rules, the worth-it verdict from
//     lib/maker/worth-it, the adverse cost from lib/rewards-estimate.
//
// THIS SCREEN ARMS NOTHING BY BEING OPENED. Sections 5b/6/8 are operator-only (they probe the same
// admin gate /api/maker/* rides) and every one of their actions is an explicit tap by the operator.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import EventTerminal from './EventTerminal';
import { Redacted } from './ui/Redacted';
import { computePriceRow } from '@/lib/reward-price-row';
import { validateQuotePair } from '@/lib/maker/venue-rules';
import { inBand } from '@/lib/rewards-live-band';
import { computeWorthIt } from '@/lib/maker/worth-it';
import { normalizeFillRule, type FillRule } from '@/lib/maker/fill-policy';
import { canonicalize } from '@/lib/maker/canonical-position';
import { estimateReward, type MarketSnapshot } from '@/lib/rewards-estimate';

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const D = <span className="mkt-dash">—</span>;

const cents = (p: number, dp = 1) => `${(p * 100).toFixed(dp)}¢`;
const usd = (n: number, dp = 2) => `$${n.toFixed(dp)}`;
const int = (n: number) => Math.round(n).toLocaleString('it-IT');

function countdown(hours: number | null | undefined): string | null {
  if (!fin(hours) || hours <= 0) return null;
  const total = Math.floor(hours * 60);
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  return `${d}g ${String(h).padStart(2, '0')}h`;
}
function fmtDur(s: number | null): string {
  if (s == null) return '—';
  if (s <= 0) return 'scaduto';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

// ── shared, sticky operator inputs. The SAME localStorage keys the board and the data card already
//    use, so the size/offset the operator set on the list is the size/offset this screen computes.
const LS_SIZE = 'rw_size';
const LS_DIST = 'rw_dist';
const LS_CFG = (id: string) => `mkt-cfg:${id}`;

type SideMode = 'both' | 'yes' | 'no';
type LegMode = 'follow' | 'pinned';

interface BookSideT { bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }>; bestBid: number | null; bestAsk: number | null }
interface BookPayload {
  feedState: 'live' | 'stale' | 'rest-fallback';
  ageMs: number | null; reason: string;
  yes: BookSideT | null;
  bestBid: number | null; bestAsk: number | null;
  scoringMid: number | null; scoringMidSource: string | null; plainMid: number | null;
  maxSpreadCents: number | null; bandRadiusCents: number | null; bandLo: number | null; bandHi: number | null;
  ladderCap: number; source: string;
}
interface Gates {
  engine: { fresh: boolean; ageSec: number | null; cycle: number | null; lastError: string | null; unknownReason: string | null };
  gates: {
    funding: { key: string; value: boolean | null; pass: boolean; how: string };
    mode: { key: string; value: string | null; pass: boolean; ladder: string[]; how: string };
    kill: { killed: boolean | null; reason: string | null };
    canWrite: boolean | null;
  };
  arming: { armed: boolean; expiresInSec: number | null; expiresAt: string | null; totalSizeUsd: number | null; ttlSeconds: number | null };
}
interface PreflightCheck { key: string; label: string; pass: boolean; value: string; detail: string }
interface CapState { capUsd: number | null; source: string; fallbackUsd: number | null; note: string | null; error: string | null }

function Section({ id, n, title, sub, children }:
  { id: string; n: string; title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="mkt-sec" id={id} data-mkt-section={id}>
      <header className="mkt-sec-h"><span className="mkt-sec-n">{n}</span><h2 className="mkt-sec-t">{title}</h2></header>
      {sub ? <p className="mkt-sec-s">{sub}</p> : null}
      {children}
    </section>
  );
}

export default function MarketTerminal({ marketId }: { marketId: string }) {
  const [ev, setEv] = useState<any | null>(null);
  const [book, setBook] = useState<BookPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // ── SECTION 2 · configuration ──
  const [sizeInput, setSizeInput] = useState<string>('200');
  const [distInput, setDistInput] = useState<string>('1');
  const [side, setSide] = useState<SideMode>('both');
  // ── SECTION 5 · per-order rules ──
  const [legMode, setLegMode] = useState<LegMode>('follow');
  const [fillYes, setFillYes] = useState<FillRule>('opposite');
  const [fillNo, setFillNo] = useState<FillRule>('opposite');
  const [legsSave, setLegsSave] = useState<'idle' | 'saving' | 'saved' | 'local' | 'error'>('idle');
  const [legsMsg, setLegsMsg] = useState<string>('');

  // ── operator-only state (sections 5b/6/8) ──
  const [operator, setOperator] = useState<boolean | null>(null);
  const [gates, setGates] = useState<Gates | null>(null);
  const [preflight, setPreflight] = useState<{ checks: PreflightCheck[]; go: boolean; error?: string } | null>(null);
  const [pfRunning, setPfRunning] = useState(false);
  const [universe, setUniverse] = useState<{ marketIds: string[] } | null>(null);
  const [uniBusy, setUniBusy] = useState(false);
  const [uniMsg, setUniMsg] = useState<string | null>(null);
  const [cap, setCap] = useState<CapState | null>(null);
  const [capInput, setCapInput] = useState<string>('');
  const [capMsg, setCapMsg] = useState<string | null>(null);
  const [armOpen, setArmOpen] = useState(false);
  const [typedTotal, setTypedTotal] = useState('');
  const [armMsg, setArmMsg] = useState<string | null>(null);
  const [arming, setArming] = useState(false);
  const [ttl, setTtl] = useState<number | null>(null);
  const [killing, setKilling] = useState(false);
  const [killMsg, setKillMsg] = useState<string | null>(null);

  // ── restore the sticky inputs ──
  useEffect(() => {
    try {
      const s = localStorage.getItem(LS_SIZE); if (s != null) setSizeInput(s);
      const d = localStorage.getItem(LS_DIST); if (d != null) setDistInput(d);
      const c = localStorage.getItem(LS_CFG(marketId));
      if (c) {
        const p = JSON.parse(c);
        if (p.side === 'both' || p.side === 'yes' || p.side === 'no') setSide(p.side);
        if (p.legMode === 'follow' || p.legMode === 'pinned') setLegMode(p.legMode);
        setFillYes(normalizeFillRule(p.fillYes));
        setFillNo(normalizeFillRule(p.fillNo));
      }
    } catch { /* private mode — defaults stand, and they are stated on screen */ }
  }, [marketId]);
  useEffect(() => { try { localStorage.setItem(LS_SIZE, sizeInput); } catch { /* ignore */ } }, [sizeInput]);
  useEffect(() => { try { localStorage.setItem(LS_DIST, distInput); } catch { /* ignore */ } }, [distInput]);
  useEffect(() => {
    try { localStorage.setItem(LS_CFG(marketId), JSON.stringify({ side, legMode, fillYes, fillNo })); } catch { /* ignore */ }
  }, [marketId, side, legMode, fillYes, fillNo]);

  const totalSizeUsd = useMemo(() => {
    const n = Number(sizeInput);
    return sizeInput.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
  }, [sizeInput]);
  const offsetCents = useMemo(() => {
    const n = Number(distInput);
    return distInput.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
  }, [distInput]);

  // ── loads ──
  const loadEvent = useCallback(async () => {
    try {
      const r = await fetch(`/api/rewards/event?marketId=${encodeURIComponent(marketId)}`, { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) { setErr(j?.error ?? `HTTP ${r.status}`); return; }
      setEv(j); setErr(null);
    } catch (e: any) { setErr(e?.message ?? 'fetch failed'); }
  }, [marketId]);

  useEffect(() => { loadEvent(); const t = setInterval(loadEvent, 60_000); return () => clearInterval(t); }, [loadEvent]);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch(`/api/rewards/event/book?marketId=${encodeURIComponent(marketId)}`, { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        if (alive) setBook(j);
      } catch { /* keep the previous book; its age label keeps ticking */ }
    }
    load();
    const t = setInterval(load, 2_000);
    return () => { alive = false; clearInterval(t); };
  }, [marketId]);

  const loadGates = useCallback(async () => {
    try { const r = await fetch('/api/maker/gates', { cache: 'no-store' }); if (r.ok) setGates(await r.json()); } catch { /* keep prior */ }
  }, []);
  const loadCap = useCallback(async () => {
    try {
      const r = await fetch(`/api/maker/market-cap?marketId=${encodeURIComponent(marketId)}`, { cache: 'no-store' });
      if (r.ok) { const j = await r.json(); setCap(j); if (j.source === 'per-market' && fin(j.capUsd)) setCapInput(String(j.capUsd)); }
    } catch { /* keep prior */ }
  }, [marketId]);
  const loadUniverse = useCallback(async () => {
    try { const r = await fetch('/api/maker/universe', { cache: 'no-store' }); if (r.ok) { const j = await r.json(); setUniverse(j.resolved ?? null); } } catch { /* keep prior */ }
  }, []);

  // Operator probe — the SAME admin gate every /api/maker/* action rides. A non-admin visitor gets the
  // decision surface (1–5, 7) and no execution controls at all; nothing is hidden that they could use.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/maker/status', { cache: 'no-store' });
        if (!alive) return;
        setOperator(r.ok);
        if (r.ok) { loadGates(); loadCap(); loadUniverse(); }
      } catch { if (alive) setOperator(false); }
    })();
    const t = setInterval(() => { if (alive && operator) { loadGates(); loadUniverse(); } }, 15_000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadGates, loadCap, loadUniverse]);

  // TTL countdown, seeded from the server and re-read at zero (the record auto-disarms on read past expiry).
  useEffect(() => { setTtl(gates?.arming?.armed ? gates.arming.expiresInSec ?? null : null); }, [gates]);
  useEffect(() => {
    if (ttl == null) return;
    if (ttl <= 0) { loadGates(); return; }
    const t = setTimeout(() => setTtl((c) => (c == null ? null : c - 1)), 1_000);
    return () => clearTimeout(t);
  }, [ttl, loadGates]);

  // ── derived ──
  const feed = ev?.feed ?? null;
  const rules = ev?.rules ?? null;
  const isPaid: boolean = ev?.isPaid ?? false;
  const tick: number | null = fin(rules?.tickSize) ? rules.tickSize : (fin(feed?.tickSize) ? feed.tickSize : null);

  // ONE price computation, shared with the board and the data card (lib/reward-price-row).
  const pr = useMemo(() => computePriceRow({
    rewardScore: feed?.rewardScore ?? null, tick, totalSizeUsd, offsetCents, market: feed ?? undefined,
  }), [feed, tick, totalSizeUsd, offsetCents]);

  // THE dollar→share conversion, read from the shared price row rather than divided again here. One
  // conversion, one number — the panel, the list row and the size persisted on the leg cannot drift.
  const perSideShares = pr.perSideShares;

  // What the BOOK will actually hold once this configuration is saved. Comprare NO a q è vendere YES a
  // 1−q: the same resting order on the same side. The engine scores that canonical set, so the panel
  // states it here rather than letting the operator count rows and assume.
  const canonical = useMemo(() => {
    if (!fin(pr.buyYes) || !fin(pr.buyNo)) return null;
    const rows: Array<{ book: string; kind: string; price: number }> = [];
    if (side === 'both' || side === 'yes') rows.push({ book: 'yes', kind: 'buy', price: pr.buyYes });
    if (side === 'both' || side === 'no') rows.push({ book: 'no', kind: 'buy', price: pr.buyNo });
    return canonicalize(rows);
  }, [pr.buyYes, pr.buyNo, side]);

  // The placement verdict for the pair, from the SHARED validator the maker itself runs.
  const bandVerdict = useMemo(() => {
    if (!fin(pr.buyYes) || !fin(pr.sellYes) || perSideShares == null) return null;
    return validateQuotePair(
      { tick: pr.tick as number, scoringMid: pr.scoringMid as number, maxSpreadCents: pr.maxSpreadCents as number, minSize: pr.minSize as number },
      { side: 'BUY', price: pr.buyYes, size: perSideShares },
      { side: 'SELL', price: pr.sellYes, size: perSideShares },
    );
  }, [pr, perSideShares]);

  // The adverse-selection MODEL — the only input to the verdict that is not a direct measurement. Fed
  // the market's own snapshot; a 2–5% conservative move band, never presented as a net figure.
  const adverse = useMemo(() => {
    if (!feed || totalSizeUsd == null || offsetCents == null) return null;
    const snap: MarketSnapshot = {
      venue: 'polymarket',
      midpoint: feed.midpoint ?? null, maxSpread: feed.maxSpread ?? null, minSize: feed.minSize ?? null,
      dailyPool: feed.dailyPool ?? null, qualifyingLiquidity: feed.qualifyingLiquidity ?? null,
      bookDepthAtBand: feed.bookDepthAtBand ?? null, volatilityStdev: feed.volatilityStdev ?? null,
      twoSidedRequired: !!feed.twoSidedRequired, sides: feed.sides ?? null,
    };
    try {
      const e = estimateReward({ venue: 'polymarket', capital: totalSizeUsd, twoSided: side === 'both', distanceCents: offsetCents, market: snap, side: 'yes' });
      return { cost: e.adverseSelectionCost, source: e.adverseMoveSource, fillProb: e.fillProbability };
    } catch { return null; }
  }, [feed, totalSizeUsd, offsetCents, side]);

  // SECTION 1 · the verdict (lib/maker/worth-it — it compares, it computes no reward and no cost).
  const worth = useMemo(() => computeWorthIt({
    grossPerDay: pr.grossPerDay, adverseCostPerDay: adverse?.cost ?? null,
    ownImpactPct: pr.ownImpactPct, perSideShares, minSize: pr.minSize, poolDay: pr.poolDay,
  }), [pr, adverse, perSideShares]);

  // On a neg-risk event the feed carries BOTH the outcome label ("Jon Ossoff") and the parent question
  // ("Will Jon Ossoff win the 2028 …?"). The outcome is what you actually quote, so it is the heading;
  // the question is kept beneath it, because an outcome label alone does not say what resolves it.
  const outcome: string | null = ev?.groupItemTitle ?? null;
  const question: string | null = ev?.title ?? null;
  const title: string | null = outcome || question;
  const cd = countdown(ev?.hoursToResolution);
  const inUniverse = !!universe?.marketIds?.includes(marketId);

  // The ceiling in force. Default = the configured size: the bot may not commit more than what the
  // operator chose here, however many times a leg fills and re-quotes the opposite side.
  const effectiveCapUsd = cap?.capUsd ?? null;
  const capDefault = totalSizeUsd;
  const committable = useMemo(() => {
    if (totalSizeUsd == null) return null;
    if (effectiveCapUsd == null) return totalSizeUsd;
    return Math.min(totalSizeUsd, effectiveCapUsd);
  }, [totalSizeUsd, effectiveCapUsd]);

  // ── ACTIONS (each one an explicit operator tap) ──
  const saveLegs = useCallback(async () => {
    // FAIL CLOSED ON THE TICK. The venue rejects any price off its grid, so without the market's real
    // tick there is no price we can honestly write down. Refuse to build the order and say why.
    if (!pr.tickKnown) {
      setLegsSave('error');
      setLegsMsg('tick del mercato non leggibile: senza la griglia dei prezzi del venue non si può sapere quale prezzo è valido, quindi non salvo nessun ordine. Riprova quando il book torna leggibile.');
      return;
    }
    if (!fin(pr.buyYes) || !fin(pr.buyNo) || perSideShares == null || offsetCents == null) {
      setLegsSave('error'); setLegsMsg('prezzi o size non calcolabili — niente da salvare'); return;
    }
    // The two orders you can actually place holding only pUSD: BUY YES and BUY NO. A SELL of a token you
    // do not own is not placeable, and BUY NO at 1−p IS the sell-YES order — same order, honest name.
    // sizeShares is the CANONICAL unit (shares). Persisting it is what makes the engine quote the size
    // the operator actually chose: without it agent35 falls back to its own default and the panel's
    // dollar figure describes an order nobody placed.
    const legs: any[] = [];
    // Each side carries the share count that commits ITS half of the dollar budget at ITS own price.
    if (side === 'both' || side === 'yes') legs.push({ book: 'yes', kind: 'buy', price: pr.buyYes, mode: legMode, offsetC: -offsetCents, onFill: fillYes, sizeShares: perSideShares });
    if (side === 'both' || side === 'no') legs.push({ book: 'no', kind: 'buy', price: pr.buyNo, mode: legMode, offsetC: -offsetCents, onFill: fillNo, sizeShares: pr.perSideSharesNo });
    setLegsSave('saving'); setLegsMsg('');
    try {
      const r = await fetch('/api/rewards/legs', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketId, venue: 'polymarket', legs }),
      });
      if (r.status === 401) { setLegsSave('local'); setLegsMsg('salvato solo su questo dispositivo — il motore legge le regole dal server, quindi non le applicherà finché non accedi'); return; }
      if (!r.ok) { const e = await r.json().catch(() => ({})); setLegsSave('error'); setLegsMsg(e?.error ?? `HTTP ${r.status}`); return; }
      setLegsSave('saved'); setLegsMsg(`${legs.length} ordini configurati — il motore rilegge queste regole a ogni ciclo. Salvare NON piazza nulla.`);
    } catch (e: any) { setLegsSave('error'); setLegsMsg(e?.message ?? 'errore di salvataggio'); }
  }, [pr, perSideShares, offsetCents, side, legMode, fillYes, fillNo, marketId]);

  const addToUniverse = useCallback(async () => {
    setUniBusy(true); setUniMsg(null);
    try {
      const cur = await (await fetch('/api/maker/universe', { cache: 'no-store' })).json();
      const sel = cur?.selection ?? {};
      const allowlist: string[] = Array.isArray(sel.allowlist) ? sel.allowlist.map(String) : [];
      if (!allowlist.includes(marketId)) allowlist.push(marketId);
      const denylist: string[] = (Array.isArray(sel.denylist) ? sel.denylist.map(String) : []).filter((d: string) => d !== marketId);
      const r = await fetch('/api/maker/universe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters: sel.filters ?? {}, venues: sel.venues, allowlist, denylist, maxMarkets: sel.maxMarkets }),
      });
      const j = await r.json();
      if (!r.ok || j?.error) setUniMsg(j?.error ?? `HTTP ${r.status}`);
      else { setUniverse(j.resolved ?? null); setUniMsg('salvato nella lista del bot — nessun ordine piazzato'); }
    } catch (e: any) { setUniMsg(e?.message ?? 'errore'); }
    finally { setUniBusy(false); }
  }, [marketId]);

  const saveCap = useCallback(async () => {
    setCapMsg(null);
    const n = Number(capInput);
    if (!Number.isFinite(n) || n < 0) { setCapMsg('inserisci un numero ≥ 0'); return; }
    try {
      const r = await fetch('/api/maker/market-cap', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketId, capUsd: n }),
      });
      const j = await r.json();
      if (!r.ok || j?.error) { setCapMsg(j?.error ?? `HTTP ${r.status}`); return; }
      setCap(j); setCapMsg(j.note ?? 'tetto salvato');
    } catch (e: any) { setCapMsg(e?.message ?? 'errore'); }
  }, [marketId, capInput]);

  const runPreflight = useCallback(async () => {
    setPfRunning(true);
    try {
      const r = await fetch('/api/maker/preflight', { cache: 'no-store' });
      setPreflight(await r.json());
    } catch (e: any) { setPreflight({ checks: [], go: false, error: e?.message ?? 'errore' }); }
    finally { setPfRunning(false); }
  }, []);

  const doArm = useCallback(async () => {
    if (committable == null) return;
    setArming(true); setArmMsg(null);
    try {
      const r = await fetch('/api/maker/arm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalSizeUsd: committable, typedSizeConfirm: Number(typedTotal),
          perSideSizeUsd: committable / 2, universeMarketIds: [marketId],
          collateralCapUsd: effectiveCapUsd ?? undefined,
        }),
      });
      const j = await r.json();
      if (j.ok) { setArmMsg('ARMATO.'); setArmOpen(false); setTypedTotal(''); }
      else setArmMsg(`Rifiutato (${j.refusedBy || 'errore'}): ${j.reason || j.error || 'bloccato'}`);
      loadGates();
    } catch (e: any) { setArmMsg(e?.message ?? 'errore'); }
    finally { setArming(false); }
  }, [committable, typedTotal, marketId, effectiveCapUsd, loadGates]);

  const doDisarm = useCallback(async () => {
    try { await fetch('/api/maker/disarm', { method: 'POST' }); loadGates(); } catch { /* ignore */ }
  }, [loadGates]);

  const doKill = useCallback(async () => {
    setKilling(true); setKillMsg(null);
    try {
      const r = await fetch('/api/maker/kill', { method: 'POST' });
      const j = await r.json();
      setKillMsg(j?.ok
        ? `disarmato · ${j.cancelledTotal ?? 0} ordini cancellati${j.simulated ? ' (a vuoto — nessuna credenziale di cancellazione)' : ''}`
        : `KILL fallito: ${j?.error ?? j?.killError ?? 'errore'}`);
      loadGates();
    } catch (e: any) { setKillMsg(`richiesta fallita — niente confermato: ${e?.message ?? 'errore'}`); }
    finally { setKilling(false); }
  }, [loadGates]);

  // ── the four execution gates, resolved to a real status each ──
  const step1Ok = inUniverse;
  const step2Ok = gates?.gates?.funding?.pass === true;
  const step3Ok = gates?.gates?.mode?.pass === true;
  const preflightGo = preflight?.go === true;
  const armBlockers: string[] = [];
  if (!step1Ok) armBlockers.push('1 · il mercato non è nella lista del bot');
  if (!step2Ok) armBlockers.push(`2 · fondi non autorizzati (MAKER_FUNDING_APPROVED ${gates?.gates?.funding?.value === null ? 'non leggibile' : 'non attivo'})`);
  if (!step3Ok) armBlockers.push(`3 · motore non acceso (MAKER_MODE = ${gates?.gates?.mode?.value ?? '—'})`);
  if (!preflightGo) armBlockers.push(preflight ? '4 · preflight NON-GO — risolvi i controlli rossi' : '4 · preflight non ancora eseguito');
  if (committable == null) armBlockers.push('size non calcolabile — configura la size nella sezione 2');
  if (Number(typedTotal) !== committable) armBlockers.push('digita il collaterale esatto per confermare');
  const armDisabled = arming || armBlockers.length > 0;

  if (err) {
    return (
      <div className="mkt">
        <div className="mkt-shell">
          <Link href="/dashboard/liquidity-rewards" className="mkt-back">← elenco premi</Link>
          <p className="mkt-err">Mercato non disponibile: {err}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mkt">
      <div className="mkt-shell">
        <Link href="/dashboard/liquidity-rewards" className="mkt-back">← elenco premi</Link>

        {/* ══ 1 · HEAD + VERDICT ═══════════════════════════════════════════════════════════════ */}
        <header className="mkt-head" data-mkt-section="head">
          <div className="mkt-tags">
            <span className="mkt-tag">{ev?.venue ?? '—'}</span>
            <span className="mkt-tag">{ev?.category ?? '—'}</span>
            <span className="mkt-tag">neg-risk {rules?.negRisk === true ? 'sì' : rules?.negRisk === false ? 'no' : '—'}</span>
            {rules?.acceptingOrders === false && <span className="mkt-tag">ordini non accettati</span>}
          </div>
          <h1 className="mkt-title">{title ?? '—'}</h1>
          {outcome && question && outcome !== question && <p className="mkt-foot" style={{ margin: '-4px 0 8px' }}>{question}</p>}
          <div className="mkt-cd">
            <span>alla chiusura</span><b>{cd ?? '—'}</b>
            <span>· montepremi {fin(rules?.dailyPotUsd) ? `${usd(rules.dailyPotUsd, 0)}/giorno` : '—'}</span>
          </div>

          <div className={`mkt-verdict is-${worth.verdict === 'unknown' ? 'thin' : worth.verdict}`} data-mkt-verdict={worth.verdict}>
            <div className="mkt-verdict-h">
              <span className="mkt-verdict-t">{worth.headline.toUpperCase()}</span>
              <span className="mkt-verdict-n">
                lordo <Redacted value={fin(pr.grossPerDay) ? pr.grossPerDay : null} isPaid={isPaid}>{(v) => <>{usd(Number(v))}/giorno</>}</Redacted>
                {totalSizeUsd != null ? ` a ${usd(totalSizeUsd, 0)}` : ''}
              </span>
            </div>
            {worth.reasons.length > 0 ? (
              <ul>{worth.reasons.map((r) => <li key={r.code}>{r.detail}</li>)}</ul>
            ) : (
              <p className="mkt-foot">
                Nessun ostacolo misurato a questa size: il lordo supera la soglia di pagamento, la size
                per lato raggiunge il minimo premiante e il tuo peso sul book resta sotto il 20%.
              </p>
            )}
            <p className="mkt-foot">
              Il costo di adverse selection è una <strong>stima modellata</strong> (banda 2–5%,
              lib/rewards-estimate), non una misura: basta a dire «non conviene», non basta a stampare un
              netto. Il netto resta «—» nella sezione 4.
            </p>
          </div>
        </header>

        {/* ══ 2 · CONFIGURE ════════════════════════════════════════════════════════════════════ */}
        <Section id="config" n="2" title="Configura"
          sub="La size è il totale su entrambi i lati; la distanza è quanto ti scosti dal punto medio di scoring. Sono gli stessi due valori dell'elenco.">
          <div className="mkt-ctl">
            <div className="mkt-ctl-row">
              <label className="mkt-lab" htmlFor="mkt-size">
                <span>Size totale (USD)</span>
                {/* BOTH units, labelled separately: tu inserisci dollari, il venue conta shares. */}
                <span>{pr.perSideUsd != null ? `${usd(pr.perSideUsd, 0)} per lato` : '—'}
                  {perSideShares != null ? ` · ${perSideShares.toFixed(0)} shares YES` : ''}
                  {pr.perSideSharesNo != null ? ` / ${pr.perSideSharesNo.toFixed(0)} shares NO` : ''}</span>
              </label>
              <input id="mkt-size" className="mkt-input" type="number" inputMode="decimal" min={0}
                value={sizeInput} onChange={(e) => setSizeInput(e.target.value)} />
              <div className="mkt-chips">
                {[100, 200, 500, 1000].map((v) => (
                  <button key={v} type="button" className="mkt-chip" aria-pressed={Number(sizeInput) === v}
                    onClick={() => setSizeInput(String(v))}>${v}</button>
                ))}
              </div>
            </div>

            <div className="mkt-ctl-row">
              <label className="mkt-lab" htmlFor="mkt-dist">
                <span>Distanza dal punto medio</span>
                <span>{fin(pr.bandRadiusC) ? `banda ±${pr.bandRadiusC.toFixed(2)}¢` : '—'}</span>
              </label>
              <input id="mkt-dist" className="mkt-input" type="number" inputMode="decimal" min={0}
                step={fin(tick) ? tick * 100 : 0.1}
                value={distInput} onChange={(e) => setDistInput(e.target.value)} />
              <p className="mkt-foot">
                Tick del mercato {fin(tick) ? `${cents(tick, 2)}` : '—'} — i prezzi sotto sono già
                agganciati alla griglia: il venue rifiuta un prezzo più fine.
                {!pr.tickKnown
                  ? ' Il tick non è leggibile ora: nessun prezzo viene proposto e la configurazione non è salvabile, perché senza griglia non si sa quale prezzo il venue accetta.'
                  : fin(pr.snappedByC) && pr.snappedByC > 0
                    ? ` La griglia ha spostato la tua distanza di ${pr.snappedByC.toFixed(2)}¢: da ${fin(pr.buyYesRaw) ? cents(pr.buyYesRaw) : '—'} a ${fin(pr.buyYes) ? cents(pr.buyYes) : '—'} sul lato acquisto.`
                    : ''}
                {pr.anyOutOfBand ? ' Questa distanza porta un ordine FUORI banda: non matura premio.' : ''}
              </p>
            </div>

            <div className="mkt-ctl-row is-wide">
              <span className="mkt-lab"><span>Lato</span><span>Polymarket premia la quotazione a due lati</span></span>
              <div className="mkt-seg">
                {([['both', 'Entrambi'], ['yes', 'Compra YES'], ['no', 'Compra NO']] as [SideMode, string][]).map(([v, l]) => (
                  <button key={v} type="button" aria-pressed={side === v} onClick={() => setSide(v)}>{l}</button>
                ))}
              </div>
              <p className="mkt-foot">
                Un solo lato prende <strong>un terzo</strong> del punteggio quando il medio è fra 10¢ e
                90¢, e <strong>zero</strong> fuori da quell&rsquo;intervallo. «Compra NO» a {fin(pr.buyNo) ? cents(pr.buyNo) : '—'} è
                lo stesso ordine di «vendi YES» a {fin(pr.sellYes) ? cents(pr.sellYes) : '—'}: con i soli
                pUSD puoi immettere solo <strong>acquisti</strong> — una vendita consegna il token, quindi
                richiede di possederlo.
              </p>
            </div>
          </div>
        </Section>

        {/* ══ 3 · ONE BOOK ═════════════════════════════════════════════════════════════════════ */}
        <Section id="book" n="3" title="Book"
          sub="Un solo book. Il lato NO non è un secondo grafico: prezzo NO = 1 − prezzo YES sullo stesso livello.">
          <FeedBadge book={book} />
          <Ladder book={book} isPaid={isPaid} buyYes={pr.buyYes} sellYes={pr.sellYes} side={side} />
        </Section>

        {/* ══ 4 · NUMBERS ══════════════════════════════════════════════════════════════════════ */}
        <Section id="numbers" n="4" title="Numeri alla tua size"
          sub="Calcolati sulla quota quadratica pubblicata contro la profondità concorrente reale del feed.">
          <div className="mkt-nums">
            <div className="mkt-num">
              <div className="mkt-num-k">lordo / giorno</div>
              <div className="mkt-num-v is-green">
                <Redacted value={fin(pr.grossPerDay) ? pr.grossPerDay : null} isPaid={isPaid}>{(v) => <>{usd(Number(v))}</>}</Redacted>
              </div>
              <div className="mkt-num-s">
                {fin(pr.dayYieldPct) ? `${pr.dayYieldPct.toFixed(3)}%/giorno sulla size` : '—'} · al lordo del rischio
              </div>
            </div>
            <div className="mkt-num">
              <div className="mkt-num-k">tuo peso sul book</div>
              <div className="mkt-num-v">
                {pr.ownImpactPct == null ? D : (
                  <span className={`mkt-impact is-${pr.ownImpactBand}`}>
                    {pr.ownImpactPct < 100 ? pr.ownImpactPct.toFixed(1) : Math.round(pr.ownImpactPct)}%
                  </span>
                )}
              </div>
              <div className="mkt-num-s">
                {pr.ownImpactBand === 'high' ? 'oltre il 20% — diventi tu il book, la quota è un tetto'
                  : pr.ownImpactBand === 'mid' ? 'fra 5% e 20% — sposti il book in modo percettibile'
                  : pr.ownImpactBand === 'low' ? 'sotto il 5% — non sposti il book'
                  : 'profondità premiante non leggibile'}
              </div>
            </div>
            <div className="mkt-num">
              <div className="mkt-num-k">netto / giorno</div>
              <div className="mkt-num-v">{D}</div>
              <div className="mkt-num-s">
                l&rsquo;adverse selection non è misurata, solo modellata
                {adverse?.cost != null ? ` (stima ${usd(adverse.cost)}/giorno, ${adverse.source === 'market-vol' ? 'dalla volatilità del mercato' : 'banda prudenziale 2–5%'})` : ''}
                : un netto stampato da quel modello sarebbe una precisione che non abbiamo.
              </div>
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <div className="mkt-kv"><span>compra YES a</span><span><Redacted value={fin(pr.buyYes) ? pr.buyYes : null} isPaid={isPaid}>{(v) => <>{cents(Number(v))}</>}</Redacted></span></div>
            <div className="mkt-kv"><span>compra NO a</span><span><Redacted value={fin(pr.buyNo) ? pr.buyNo : null} isPaid={isPaid}>{(v) => <>{cents(Number(v))}</>}</Redacted></span></div>
            <div className="mkt-kv"><span>quote per lato</span><span>{perSideShares != null ? int(perSideShares) : D}{fin(pr.minSize) ? ` / min ${int(pr.minSize)}` : ''}</span></div>
            <div className="mkt-kv">
              <span>entrambi dentro la banda</span>
              <span>{bandVerdict == null ? D : bandVerdict.both
                ? <span className="mkt-pill is-ok">sì</span>
                : <span className="mkt-pill is-no">no — {bandVerdict.note}</span>}</span>
            </div>
          </div>
          {perSideShares != null && fin(pr.minSize) && perSideShares < pr.minSize && (
            <p className="mkt-foot"><strong>Sotto la size minima premiante.</strong> A {usd(totalSizeUsd ?? 0, 0)} totali
              restano {int(perSideShares)} quote per lato contro le {int(pr.minSize)} richieste: gli ordini
              riposano nel book ma non maturano nulla. Alza la size o lascia perdere questo mercato.</p>
          )}
          {bandVerdict && bandVerdict.reasons.length > 0 && (
            <ul className="mkt-blockers">
              {bandVerdict.reasons.map((r: any, i: number) => <li key={i}>{r.code} · {r.detail}</li>)}
            </ul>
          )}
        </Section>

        {/* ══ 5 · PER-ORDER RULES ══════════════════════════════════════════════════════════════ */}
        <Section id="rules" n="5" title="Regole per ordine"
          sub="Queste due scelte non sono promemoria: il motore le rilegge a ogni ciclo dalla riga dell'ordine (agent35-maker → lib/maker/quote-plan e lib/maker/fill-policy)."
        >
          <div className="mkt-ctl">
            <div className="mkt-ctl-row is-wide">
              <span className="mkt-lab"><span>Quando il punto medio si muove</span></span>
              <div className="mkt-seg is-2">
                <button type="button" aria-pressed={legMode === 'follow'} onClick={() => setLegMode('follow')}>Segue il medio</button>
                <button type="button" aria-pressed={legMode === 'pinned'} onClick={() => setLegMode('pinned')}>Resta al prezzo</button>
              </div>
              <p className="mkt-foot">
                <strong>Segue</strong>: l&rsquo;ordine mantiene la stessa distanza dal medio mentre il medio si
                sposta, quindi resta dentro la banda. Ogni ri-quotazione viene ricalcolata sul medio vivo,
                agganciata al tick e <strong>ripassata dal guard condiviso</strong> (lib/maker/venue-rules):
                fuori banda, fuori tick o sotto la size minima non viene emessa.
                {' '}<strong>Resta</strong>: il prezzo non si muove, e quando il medio scappa l&rsquo;ordine esce
                dalla banda e smette di maturare.
              </p>
            </div>

            <div className="mkt-ctl-row">
              <span className="mkt-lab"><span>Se viene fillato il lato YES</span></span>
              <div className="mkt-seg">
                <button type="button" aria-pressed={fillYes === 'close'} onClick={() => setFillYes('close')}>Chiudi</button>
                <button type="button" aria-pressed={fillYes === 'opposite'} onClick={() => setFillYes('opposite')}>Lato opposto</button>
                <button type="button" aria-pressed={fillYes === 'hold'} onClick={() => setFillYes('hold')}>Tieni</button>
              </div>
            </div>
            <div className="mkt-ctl-row">
              <span className="mkt-lab"><span>Se viene fillato il lato NO</span></span>
              <div className="mkt-seg">
                <button type="button" aria-pressed={fillNo === 'close'} onClick={() => setFillNo('close')}>Chiudi</button>
                <button type="button" aria-pressed={fillNo === 'opposite'} onClick={() => setFillNo('opposite')}>Lato opposto</button>
                <button type="button" aria-pressed={fillNo === 'hold'} onClick={() => setFillNo('hold')}>Tieni</button>
              </div>
            </div>
          </div>
          {/* What the book will actually hold. Two rows can be ONE resting position: say so inline,
              keep both rows, and never drop what the operator configured. */}
          {canonical && (
            <p className="mkt-foot">
              Sul book queste {canonical.positions.reduce((n, p) => n + p.legCount, 0)} righe diventano{' '}
              <strong>{canonical.positions.length} posizion{canonical.positions.length === 1 ? 'e' : 'i'}</strong>
              {' '}({canonical.positions.map((p) => p.label).join(' · ')}):{' '}
              {canonical.twoSided
                ? 'una in acquisto e una in vendita, quindi la quotazione è a due lati e non prende la penalità.'
                : 'tutte sullo stesso lato, quindi la quotazione è a un lato solo e il punteggio scende.'}
              {canonical.collapsed.length > 0 && (
                <> Attenzione: {canonical.collapsed.map((g) => `«${g.label}» è configurata ${g.legCount} volte`).join('; ')} —
                  comprare NO a q è vendere YES a 1−q, cioè lo stesso ordine sullo stesso lato: conta una
                  volta sola nel punteggio, ma impegna il capitale di entrambe le righe.</>
              )}
            </p>
          )}
          <p className="mkt-foot">
            <strong>Chiudi</strong> esce dall&rsquo;inventario e riduce l&rsquo;esposizione.
            <strong> Lato opposto</strong> ri-quota il complementare al prezzo speculare (il giro completo
            del market maker): <em>aumenta</em> l&rsquo;esposizione, ed è per questo che deve stare sotto il
            tetto della sezione 5b. <strong>Tieni</strong> non emette nulla.
            Su un segnale forte il news-guard può comunque forzare la chiusura, qualunque regola tu abbia scelto.
          </p>
          <button className="mkt-btn" type="button" onClick={saveLegs} disabled={legsSave === 'saving'}>
            {legsSave === 'saving' ? 'Salvo…' : 'Salva la configurazione degli ordini'}
          </button>
          {legsMsg && <p className="mkt-foot" style={{ color: legsSave === 'error' ? 'var(--ds-danger)' : undefined }}>{legsMsg}</p>}
          <p className="mkt-foot">Salvare scrive solo la configurazione. <strong>Non piazza nessun ordine.</strong></p>
        </Section>

        {/* ══ 5b · RISK LIMIT (operator) ═══════════════════════════════════════════════════════ */}
        {operator === true && (
        <Section id="risk" n="5b" title="Limite di rischio su questo mercato"
          sub="Il tetto massimo di collaterale che il bot può impegnare qui. È il limite che tiene sotto controllo l'accumulo di inventario: nemmeno fill ripetuti con la regola «lato opposto» possono superarlo.">
          <div className="mkt-ctl">
            <div className="mkt-ctl-row">
              <label className="mkt-lab" htmlFor="mkt-cap">
                <span>Tetto collaterale (USD)</span>
                <span>{cap ? `in vigore: ${cap.capUsd != null ? usd(cap.capUsd) : '—'} (${cap.source})` : '—'}</span>
              </label>
              <input id="mkt-cap" className="mkt-input" type="number" inputMode="decimal" min={0}
                placeholder={capDefault != null ? String(capDefault) : 'es. 200'}
                value={capInput} onChange={(e) => setCapInput(e.target.value)} />
              <button className="mkt-btn" type="button" onClick={saveCap}>Salva il tetto</button>
              {capDefault != null && (
                <button className="mkt-btn" type="button" onClick={() => setCapInput(String(capDefault))}>
                  Usa la size configurata ({usd(capDefault, 0)})
                </button>
              )}
            </div>
            <div className="mkt-ctl-row">
              <span className="mkt-lab"><span>Impegnabile ora / tetto</span>
                <span>{committable != null ? usd(committable) : '—'} / {effectiveCapUsd != null ? usd(effectiveCapUsd) : '—'}</span></span>
              <div className="mkt-meter">
                <i className={committable != null && effectiveCapUsd != null && committable > effectiveCapUsd ? 'is-over' : ''}
                  style={{ width: committable != null && effectiveCapUsd ? `${Math.min(100, (committable / effectiveCapUsd) * 100)}%` : '0%' }} />
              </div>
              <p className="mkt-foot">
                Predefinito: <strong>la size configurata</strong> ({capDefault != null ? usd(capDefault, 0) : '—'}) — mai oltre.
                {cap?.source === 'fallback' ? ` Nessun tetto impostato qui: vale il limite d'ambiente ${cap.fallbackUsd != null ? usd(cap.fallbackUsd, 0) : '—'}.` : ''}
                {cap?.source === 'unreadable' ? ' Archivio dei tetti illeggibile: il motore non impegna nulla (fail closed).' : ''}
              </p>
            </div>
          </div>
          {capMsg && <p className="mkt-foot">{capMsg}</p>}
          <p className="mkt-foot">
            Il motore lo rilegge a ogni ciclo (nessun riavvio) e ammette gli ordini partendo dal più
            vicino al medio: quello che non ci sta sotto il tetto semplicemente non viene impegnato.
          </p>
        </Section>
        )}

        {/* ══ 6 · EXECUTION (operator) ═════════════════════════════════════════════════════════ */}
        {operator === true && (
        <Section id="exec" n="6" title="Esecuzione"
          sub="Quattro passaggi, in ordine. Ognuno mostra il suo stato reale letto dal motore, non una spunta locale.">
          {gates?.engine?.unknownReason && (
            <p className="mkt-foot" style={{ color: 'var(--cc-amber)' }}>
              Stato dei gate non determinabile: {gates.engine.unknownReason}. Finché è così nessun
              passaggio può risultare verde.
            </p>
          )}

          {/* STEP 1 */}
          <div className="mkt-step" data-mkt-step="1">
            <span className={`mkt-step-d ${step1Ok ? 'is-ok' : 'is-no'}`}>{step1Ok ? '●' : '✕'}</span>
            <div>
              <div className="mkt-step-t">1 · Aggiungi all&rsquo;universo del bot</div>
              <div className="mkt-step-v">
                {step1Ok ? 'questo mercato è nella lista che il bot quoterebbe' : 'questo mercato NON è nella lista del bot'}
                {universe ? ` · ${universe.marketIds.length} mercati in lista` : ''}
                <br /><b>Salva solo la lista. Non piazza nulla.</b>
              </div>
              <button className="mkt-btn" type="button" onClick={addToUniverse} disabled={uniBusy || step1Ok}>
                {step1Ok ? 'Già in lista' : uniBusy ? 'Salvo…' : 'Aggiungi all’universo bot'}
              </button>
              {uniMsg && <div className="mkt-step-v">{uniMsg}</div>}
            </div>
          </div>

          {/* STEP 2 */}
          <div className="mkt-step" data-mkt-step="2">
            <span className={`mkt-step-d ${step2Ok ? 'is-ok' : gates?.gates?.funding?.value == null ? 'is-unk' : 'is-no'}`}>
              {step2Ok ? '●' : gates?.gates?.funding?.value == null ? '?' : '✕'}
            </span>
            <div>
              <div className="mkt-step-t">2 · Fondi autorizzati</div>
              <div className="mkt-step-v">
                <b>MAKER_FUNDING_APPROVED</b> = {gates?.gates?.funding?.value == null ? '— (non leggibile)' : String(gates.gates.funding.value)}
                <br />{gates?.gates?.funding?.how ?? 'stato non ancora letto'}
              </div>
            </div>
          </div>

          {/* STEP 3 */}
          <div className="mkt-step" data-mkt-step="3">
            <span className={`mkt-step-d ${step3Ok ? 'is-ok' : gates?.gates?.mode?.value == null ? 'is-unk' : 'is-no'}`}>
              {step3Ok ? '●' : gates?.gates?.mode?.value == null ? '?' : '✕'}
            </span>
            <div>
              <div className="mkt-step-t">3 · Motore acceso</div>
              <div className="mkt-step-v">
                <b>MAKER_MODE</b> = {gates?.gates?.mode?.value ?? '— (non leggibile)'}
                {' '}(scala: {(gates?.gates?.mode?.ladder ?? ['off', 'paper', 'live-min', 'live']).join(' → ')})
                <br />{gates?.gates?.mode?.how ?? 'stato non ancora letto'}
                {gates?.gates?.kill?.killed ? <><br /><b>KILL durevole attivo</b>{gates.gates.kill.reason ? ` — ${gates.gates.kill.reason}` : ''}</> : null}
              </div>
            </div>
          </div>

          {/* STEP 4 */}
          <div className="mkt-step" data-mkt-step="4">
            <span className={`mkt-step-d ${gates?.arming?.armed ? 'is-ok' : armBlockers.length ? 'is-no' : 'is-unk'}`}>
              {gates?.arming?.armed ? '●' : armBlockers.length ? '✕' : '○'}
            </span>
            <div>
              <div className="mkt-step-t">4 · ARMA E PIAZZA</div>
              <div className="mkt-step-v"><b>Questo fa partire ordini reali.</b> Due passaggi: apri il
                controllo, poi digita il collaterale esatto. Il server ri-esegue il preflight sull&rsquo;ARM.</div>

              {/* preflight — the arming gate, read live at click time */}
              <button className="mkt-btn" type="button" onClick={runPreflight} disabled={pfRunning}>
                {pfRunning ? 'Leggo lo stato reale…' : preflight ? `Ri-esegui preflight (${preflight.go ? 'GO' : 'NON-GO'})` : 'Esegui il preflight'}
              </button>
              {preflight?.error && <div className="mkt-step-v" style={{ color: 'var(--ds-danger)' }}>preflight fallito: {preflight.error}</div>}
              {preflight && !preflight.error && preflight.checks.map((c) => (
                <div key={c.key} className="mkt-step-v">
                  <span style={{ color: c.pass ? 'var(--cc-green)' : 'var(--ds-danger)', fontWeight: 800 }}>{c.pass ? '●' : '✕'}</span>{' '}
                  {c.label} — <b>{c.value}</b>{!c.pass && c.detail ? ` · ${c.detail}` : ''}
                </div>
              ))}

              {gates?.arming?.armed ? (
                <>
                  <div className="mkt-ttl" data-mkt-ttl>
                    ARMATO · {gates.arming.totalSizeUsd != null ? usd(gates.arming.totalSizeUsd) : '—'} ·
                    {' '}auto-disarmo fra <b>{fmtDur(ttl)}</b>
                    {gates.arming.ttlSeconds != null ? ` (TTL ${Math.round(gates.arming.ttlSeconds / 3600)}h)` : ''}
                    {gates.arming.expiresAt ? ` · scade ${gates.arming.expiresAt}` : ''}
                  </div>
                  <p className="mkt-foot">Alla scadenza il motore si disarma da solo e cancella gli ordini aperti. Non esiste un arm senza scadenza.</p>
                  <button className="mkt-btn" type="button" onClick={doDisarm}>DISARMA</button>
                </>
              ) : !armOpen ? (
                <button className="mkt-btn" type="button" onClick={() => setArmOpen(true)}>Abilita l&rsquo;armamento…</button>
              ) : (
                <>
                  <label className="mkt-lab" htmlFor="mkt-typed" style={{ marginTop: 8 }}>
                    <span>Digita il collaterale esatto per confermare</span>
                    <span>{committable != null ? usd(committable) : '—'}</span>
                  </label>
                  <input id="mkt-typed" className="mkt-input" type="number" inputMode="decimal"
                    value={typedTotal} onChange={(e) => setTypedTotal(e.target.value)} />
                  <button className="mkt-btn is-arm" type="button" onClick={doArm} disabled={armDisabled} data-mkt-arm>
                    {arming ? 'ARMO…' : 'ARMA E PIAZZA'}
                  </button>
                  <button className="mkt-btn" type="button" onClick={() => { setArmOpen(false); setTypedTotal(''); }}>Annulla</button>
                </>
              )}

              {/* The TTL is stated in EVERY state — before arming, while choosing, and once armed. An
                  expiry the operator only reads on the confirmation screen is an expiry they forget. */}
              {!gates?.arming?.armed && (
                <p className="mkt-foot" data-mkt-ttl-note>
                  Durata dell&rsquo;armamento: <strong>4h</strong> (predefinita, massimo 24h). Alla scadenza il
                  motore <strong>si disarma e cancella gli ordini da solo</strong>; l&rsquo;unico modo di
                  estenderla è un rinnovo esplicito, che ri-esegue il preflight. Non esiste un arm senza scadenza.
                </p>
              )}

              {armBlockers.length > 0 && !gates?.arming?.armed && (
                <ul className="mkt-blockers" data-mkt-blockers>
                  {armBlockers.map((b) => <li key={b}>manca: {b}</li>)}
                </ul>
              )}
              {armMsg && <div className="mkt-step-v"><b>{armMsg}</b></div>}
            </div>
          </div>
        </Section>
        )}

        {operator === false && (
          <p className="mkt-foot" data-mkt-section="exec-hidden">
            I controlli di esecuzione (limite di rischio, universo del bot, armamento, KILL) sono
            riservati all&rsquo;operatore e non sono raggiungibili da questa sessione.
          </p>
        )}

        {/* ══ 7 · MARKET DATA — the read-only declaration, collapsed ═══════════════════════════ */}
        <Section id="data" n="7" title="Dati del mercato" sub="Identificativi, date, regole complete del venue e sezione pUSD. Sola lettura.">
          <details className="mkt-data">
            <summary>Apri la scheda completa</summary>
            <EventTerminal marketId={marketId} embedded />
          </details>
        </Section>

        {/* ══ 8 · KILL — sticky, one tap, no dialog ═══════════════════════════════════════════ */}
        {operator === true && (
          <div className="mkt-kill" data-mkt-section="kill">
            <button className="mkt-killbtn" type="button" onClick={doKill} disabled={killing} data-mkt-kill
              aria-label="Disarma il maker e cancella tutti gli ordini adesso">
              {killing ? 'FERMO TUTTO…' : 'KILL — DISARMA E CANCELLA TUTTO'}
            </button>
            <p className="mkt-killnote">
              Un tocco, nessuna conferma. Gira sul server di Edgeradar, non nel browser. Sicuro anche a motore già spento.
              {killMsg ? ` · ${killMsg}` : ''}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** The liveness label. Never says "live" unless the socket actually drove this book. */
function FeedBadge({ book }: { book: BookPayload | null }) {
  if (!book) return <div className="mkt-feed"><span className="mkt-pill">—</span><span className="mkt-foot">book non ancora caricato</span></div>;
  const age = book.ageMs;
  const ageTxt = age == null ? '—' : age < 1000 ? `${age} ms` : `${(age / 1000).toFixed(1)} s`;
  const cls = book.feedState === 'live' ? 'is-live' : book.feedState === 'rest-fallback' ? 'is-rest' : 'is-stale';
  const label = book.feedState === 'live' ? 'LIVE · websocket' : book.feedState === 'rest-fallback' ? 'ISTANTANEA REST' : 'FERMO';
  return (
    <div className="mkt-feed" data-feed-state={book.feedState}>
      <span className={`mkt-pill ${cls}`}>{label}</span>
      <span className="mkt-foot" style={{ margin: 0 }}>età dato {ageTxt} · {book.reason}</span>
    </div>
  );
}

/**
 * ONE ladder. The reward band (mid ± max_spread/2) is highlighted, the scoring mid separates the two
 * stacks, and the levels where the configured orders would land are marked inline — which is what the
 * separate "open the book" page used to be for. In-band is tested with the SSOT (lib/rewards-live-band).
 */
function Ladder({ book, isPaid, buyYes, sellYes, side }: {
  book: BookPayload | null; isPaid: boolean;
  buyYes: number | null; sellYes: number | null; side: SideMode;
}) {
  const yes = book?.yes ?? null;
  const mid = book?.scoringMid ?? null;
  const msc = book?.maxSpreadCents ?? null;
  const marks = (p: number) => (mid != null && msc != null ? inBand(p, mid, msc) : null);

  if (!yes || (!yes.bids.length && !yes.asks.length)) {
    return (
      <div className="mkt-book">
        <div className="mkt-lv"><span className="mkt-lv-p">—</span>
          <span className="mkt-lv-f">{isPaid ? 'nessun livello leggibile per questo mercato adesso' : 'book riservato'}</span>
          <span /><span /></div>
      </div>
    );
  }

  const maxSize = Math.max(...yes.bids.map((l) => l.size), ...yes.asks.map((l) => l.size), 1);
  // Where a configured order lands: the nearest ladder level at or beyond it, on its own side.
  const nearBuy = side !== 'no' && fin(buyYes) ? buyYes : null;
  const nearSell = side !== 'yes' && fin(sellYes) ? sellYes : null;

  const row = (l: { price: number; size: number }, kind: 'bid' | 'ask') => {
    const ib = marks(l.price);
    const yoursHere = (kind === 'bid' && nearBuy != null && Math.abs(l.price - nearBuy) < 1e-9)
      || (kind === 'ask' && nearSell != null && Math.abs(l.price - nearSell) < 1e-9);
    return (
      <div key={`${kind}-${l.price}`} className={`mkt-lv is-${kind} ${ib ? 'in-band' : ''}`}>
        <span className="mkt-lv-bar" style={{ ['--w' as any]: `${(l.size / maxSize) * 100}%` }} />
        <span className="mkt-lv-p">{cents(l.price)}</span>
        <span className="mkt-lv-y">{yoursHere ? (kind === 'bid' ? '◂ il tuo BUY YES' : '◂ il tuo BUY NO') : ''}</span>
        <span className="mkt-lv-s">{int(l.size)}</span>
        <span className="mkt-lv-f">{ib == null ? '' : ib ? 'in banda' : 'fuori'}</span>
      </div>
    );
  };

  // Your order can also sit at a price with no resting level — say so rather than silently omitting it.
  const bidPrices = new Set(yes.bids.map((l) => l.price));
  const askPrices = new Set(yes.asks.map((l) => l.price));
  const orphanBuy = nearBuy != null && !bidPrices.has(nearBuy) ? nearBuy : null;
  const orphanSell = nearSell != null && !askPrices.has(nearSell) ? nearSell : null;

  return (
    <>
      <div className="mkt-book">
        {yes.asks.slice().reverse().map((l) => row(l, 'ask'))}
        {!yes.asks.length && <div className="mkt-lv"><span className="mkt-lv-p">—</span><span className="mkt-lv-f">nessuna offerta</span><span /><span /></div>}
        <div className="mkt-mid">
          <span>medio di scoring</span>
          <b><Redacted value={mid} isPaid={isPaid}>{(v) => <>{cents(Number(v))}</>}</Redacted></b>
          {fin(book?.bandLo) && fin(book?.bandHi) && <span>banda premiante {cents(book!.bandLo!)} … {cents(book!.bandHi!)}</span>}
          {fin(book?.plainMid) && fin(mid) && Math.abs(book!.plainMid! - mid) > 1e-9 && (
            <span>medio semplice {cents(book!.plainMid!)} — solo riferimento, i premi non lo usano</span>
          )}
        </div>
        {yes.bids.map((l) => row(l, 'bid'))}
        {!yes.bids.length && <div className="mkt-lv"><span className="mkt-lv-p">—</span><span className="mkt-lv-f">nessuna domanda</span><span /><span /></div>}
      </div>

      {(orphanBuy != null || orphanSell != null) && (
        <div className="mkt-you">
          <span>I tuoi ordini cadrebbero su un livello oggi vuoto</span>
          <b>
            {orphanBuy != null ? `BUY YES ${cents(orphanBuy)}${marks(orphanBuy) ? ' · in banda' : ' · FUORI banda'}` : ''}
            {orphanBuy != null && orphanSell != null ? ' · ' : ''}
            {orphanSell != null ? `BUY NO ${cents(1 - orphanSell)} (≡ SELL YES ${cents(orphanSell)})${marks(orphanSell) ? ' · in banda' : ' · FUORI banda'}` : ''}
          </b>
        </div>
      )}
      <p className="mkt-foot">
        Primi {book?.ladderCap ?? '—'} livelli per lato: il book può essere più profondo. Le righe
        evidenziate sono dentro la banda premiante; fuori da lì un ordine riposa ma vale 0.
      </p>
    </>
  );
}
