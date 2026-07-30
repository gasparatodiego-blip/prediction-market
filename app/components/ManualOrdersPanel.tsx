'use client';

// ManualOrdersPanel — ORDINI MANUALI. The operator's hand-driving console for ONE market, embedded on
// the liquidity-rewards tab beneath the arming console.
//
// OPERATOR-ONLY: every /api/maker/* route is gated by ADMIN_ACCESS_SECRET in middleware. This panel
// probes that gate on mount and renders NOTHING for a non-admin visitor, exactly like MakerArmingPanel —
// the public rewards board is unchanged for everyone else.
//
// EVERY CONTROL IS WIRED TO A REAL ENDPOINT. There is no mock row, no stubbed button and no placeholder
// state anywhere in this file:
//   Prendi in gestione manuale / Restituisci  → POST   /api/maker/manual/mode
//   Piazza ordine                             → POST   /api/maker/manual/order
//   Aggiorna / auto-refresh                   → GET    /api/maker/manual/orders   (venue truth)
//   Cancella (per riga)                       → POST   /api/maker/manual/cancel
//   Riprezza → Conferma (per riga)            → POST   /api/maker/manual/replace  (cancel+ripiazza)
//   banner, cap, stato, pin, isolamento       → GET    /api/maker/manual/config
//
// NOTHING IS HARDCODED. The kill banner is the durable kill file re-read on every poll; the caps are
// data/safety-risk-limits.json; the market, its tick, its band and its min size are the live feed; the
// placement mode is the server's own MANUAL_ORDER_PLACEMENT. A value the server could not read renders
// as "—" or as an explicit warning — never as a fabricated zero.
//
// The band/tick/min-size feedback under the form CALLS the shared validator (lib/maker/venue-rules), the
// same function the server re-runs and the board's warning uses. It is never reimplemented here, so the
// form cannot paint green something the server would refuse. The server remains the authority.

import { useCallback, useEffect, useMemo, useState } from 'react';
// The shared guard, and the shared derivation of the furthest QUALIFYING prices. Both come from the same
// module the server re-runs before a send, so the form's hints can never be looser than the refusal.
import { validateQuote, inBandPriceBounds } from '@/lib/maker/venue-rules';

interface KillState { readable: boolean; killed: boolean; scope: string | null; reason: string | null; by: string | null; at: number | null }
interface PlacementState { mode: 'dry-run' | 'send'; key: string; sends: boolean; note: string }
interface EngineState { fresh: boolean; ageSec: number | null; mode: string | null; canWrite: boolean | null; pinnedMarketId: string | null; unknownReason: string | null; manualMarketIds: string[] }
interface IsolationState { marketId: string; manual: boolean; readable: boolean; reason: string; record: { at?: number; atIso?: string; by?: string | null; reason?: string | null } | null; engineAcknowledged: boolean | null }
interface CapsState {
  readable: boolean; error: string | null; source: string;
  maxOrderNotionalUsd: number | null; maxOpenNotionalUsd: number | null; maxOrdersPerWindow: number | null;
  maxDailyLossUsd: number | null; venues: string[]; venueAllowed?: boolean;
  liveMinCapUsd: number | null; effectiveOrderCapUsd: number | null;
}
interface MarketRules {
  readable: boolean; missing: string[]; marketId: string; title: string;
  mid: number | null; tick: number | null; maxSpreadCents: number | null; minSize: number | null;
  tokenId: string | null; tokenIdNo: string | null; negRisk: boolean | null;
  bandRadiusCents: number | null; feedLive: boolean; feedAgeSec: number | null;
  midSource: 'live-book' | 'board-row' | null; midAgeSec: number | null;
  bestBid: number | null; bestAsk: number | null;
  books: { yes: { tokenId: string | null; scoringMid: number | null }; no: { tokenId: string | null; scoringMid: number | null } };
}
interface ManualConfig {
  at: string; kill: KillState; placement: PlacementState; engine: EngineState;
  isolation: IsolationState | null; caps: CapsState; market: MarketRules | null; operatorUser: string;
}
interface RestingOrder {
  orderId: string | null; marketId: string | null; tokenId: string | null; side: string | null;
  price: number | null; size: number | null; sizeMatched: number | null; sizeRemaining: number | null;
  status: string; createdMs: number | null; ageSec: number | null; source: string; notionalUsd: number | null;
}
interface OrdersResponse { ok: boolean; error: string | null; simulated: boolean; count: number; orders: RestingOrder[]; at: string }
interface PlaceResult {
  ok: boolean; sent: boolean; dryRun?: boolean; placement?: string; gate: string | null; reason: string | null;
  orderId?: string | null; notionalUsd?: number | null; wouldSend?: Record<string, unknown> | null;
  ambiguous?: boolean;
}
// The "modify" response is a DIFFERENT shape, and the difference matters: `oldCancelled:true` with
// `ok:false` is the case where nothing is resting for that leg right now, and the operator must see it.
interface ReplaceResult {
  ok: boolean; replaced?: boolean; oldCancelled?: boolean; gate: string | null; reason: string | null;
  place?: { ok: boolean; sent: boolean; gate: string | null; reason: string | null };
}

const dash = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));
const money = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `$${v.toFixed(2)}`);
const px = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : v.toFixed(3));
const age = (s: number | null): string => {
  if (s === null || s === undefined) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

export default function ManualOrdersPanel() {
  // null = still probing the admin gate; true = operator; false = not admin → render nothing.
  const [operator, setOperator] = useState<boolean | null>(null);
  const [cfg, setCfg] = useState<ManualConfig | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [orders, setOrders] = useState<OrdersResponse | null>(null);
  const [loadingOrders, setLoadingOrders] = useState(false);

  const [book, setBook] = useState<'yes' | 'no'>('yes');
  const [price, setPrice] = useState('');
  const [size, setSize] = useState('');
  const [placing, setPlacing] = useState(false);
  const [result, setResult] = useState<PlaceResult | null>(null);

  const [busyMode, setBusyMode] = useState(false);
  const [busyOrder, setBusyOrder] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editPrice, setEditPrice] = useState('');
  const [editSize, setEditSize] = useState('');
  const [rowMsg, setRowMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      const r = await fetch('/api/maker/manual/config', { cache: 'no-store' });
      if (!r.ok) { setOperator(false); return; }
      setOperator(true);
      const body = (await r.json()) as ManualConfig & { error?: string };
      if (body.error) { setCfgErr(body.error); return; }
      setCfgErr(null);
      setCfg(body);
    } catch (e) {
      setCfgErr((e as Error).message);
    }
  }, []);

  const loadOrders = useCallback(async (marketId: string | null) => {
    setLoadingOrders(true);
    try {
      const qs = marketId ? `?marketId=${encodeURIComponent(marketId)}` : '';
      const r = await fetch(`/api/maker/manual/orders${qs}`, { cache: 'no-store' });
      setOrders((await r.json()) as OrdersResponse);
    } catch (e) {
      setOrders({ ok: false, error: (e as Error).message, simulated: false, count: 0, orders: [], at: new Date().toISOString() });
    } finally {
      setLoadingOrders(false);
    }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  // The banner, the caps and the isolation state are LIVE state, so they are re-read on a timer rather
  // than snapshotted at mount — a kill set from the console above must show here within seconds.
  useEffect(() => {
    if (operator !== true) return;
    const t = setInterval(loadConfig, 10_000);
    return () => clearInterval(t);
  }, [operator, loadConfig]);

  const marketId = cfg?.market?.marketId ?? cfg?.engine.pinnedMarketId ?? null;

  useEffect(() => {
    if (operator !== true || !marketId) return;
    loadOrders(marketId);
    const t = setInterval(() => loadOrders(marketId), 20_000);
    return () => clearInterval(t);
  }, [operator, marketId, loadOrders]);

  const rules = cfg?.market ?? null;
  const scoringMid = rules ? (book === 'no' ? rules.books.no.scoringMid : rules.books.yes.scoringMid) : null;
  const priceNum = Number(price);
  const sizeNum = Number(size);
  const notional = Number.isFinite(priceNum) && Number.isFinite(sizeNum) && priceNum > 0 && sizeNum > 0 ? priceNum * sizeNum : null;
  const capUsd = cfg?.caps.effectiveOrderCapUsd ?? null;
  const overCap = notional != null && capUsd != null && notional > capUsd + 1e-9;
  const killed = cfg?.kill.killed === true || cfg?.kill.readable === false;
  const manualOn = cfg?.isolation?.manual === true && cfg?.isolation?.readable === true;

  // The SHARED validator — never a local reimplementation of the band, the tick or the min size.
  const verdict = useMemo(() => {
    if (!rules || !rules.readable || !Number.isFinite(priceNum) || !Number.isFinite(sizeNum)) return null;
    return validateQuote(
      { tick: rules.tick, scoringMid, maxSpreadCents: rules.maxSpreadCents, minSize: rules.minSize },
      { side: 'BUY', price: priceNum, size: sizeNum },
    );
  }, [rules, scoringMid, priceNum, sizeNum]);

  // ── PRE-FLIGHT HINTS ──────────────────────────────────────────────────────────────────────────────
  // Everything below answers the operator BEFORE they press the button, with the market's real numbers.
  // None of it relaxes anything: the server re-runs the identical guard, and these bounds are prices the
  // guard itself accepted (lib/maker/venue-rules.inBandPriceBounds probes through validateQuote).
  const bounds = useMemo(() => {
    if (!rules?.readable) return { readable: false, lo: null, hi: null, tick: null };
    return inBandPriceBounds({ tick: rules.tick, scoringMid, maxSpreadCents: rules.maxSpreadCents, minSize: rules.minSize });
  }, [rules, scoringMid]);

  const minSize = rules?.minSize ?? null;
  // Typed a size, it is a number, and it is under the market's minimum → say so with both numbers.
  const sizeBelowMin = Number.isFinite(sizeNum) && sizeNum > 0 && minSize != null && sizeNum < minSize;
  // The tick-snapped price nearest to what was typed — what "0.5203 is not on the grid" should offer.
  const snappedPrice = useMemo(() => {
    const t = rules?.tick;
    if (!Number.isFinite(priceNum) || !t || t <= 0) return null;
    return +(Math.round(priceNum / t) * t).toFixed(10);
  }, [priceNum, rules]);
  const priceOffTick = Number.isFinite(priceNum) && snappedPrice != null && Math.abs(priceNum - snappedPrice) > (rules!.tick as number) / 1000;
  // Out of band, and WHICH side of it — so the hint can name the exact nearest qualifying price.
  const priceOutOfBand =
    Number.isFinite(priceNum) && bounds.readable && bounds.lo != null && bounds.hi != null &&
    (priceNum < bounds.lo - 1e-12 || priceNum > bounds.hi + 1e-12);
  const nearestInBand = !priceOutOfBand ? null : (priceNum > (bounds.hi as number) ? bounds.hi : bounds.lo);

  const canPlace =
    !placing && !killed && manualOn && !overCap &&
    !!rules?.readable && verdict?.valid === true && notional != null;

  const setManual = useCallback(async (manual: boolean) => {
    if (!marketId) return;
    setBusyMode(true);
    try {
      await fetch('/api/maker/manual/mode', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketId, manual, reason: manual ? 'pannello ordini manuali' : 'restituito al motore dal pannello' }),
      });
      await loadConfig();
    } finally { setBusyMode(false); }
  }, [marketId, loadConfig]);

  const doPlace = useCallback(async () => {
    if (!marketId) return;
    setPlacing(true); setResult(null);
    try {
      const r = await fetch('/api/maker/manual/order', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketId, book, price: priceNum, size: sizeNum }),
      });
      setResult((await r.json()) as PlaceResult);
      await loadOrders(marketId);
    } catch (e) {
      setResult({ ok: false, sent: false, gate: 'request-failed', reason: (e as Error).message });
    } finally { setPlacing(false); }
  }, [marketId, book, priceNum, sizeNum, loadOrders]);

  const doCancel = useCallback(async (orderId: string) => {
    setBusyOrder(orderId); setRowMsg(null);
    try {
      const r = await fetch('/api/maker/manual/cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, marketId: marketId ?? undefined }),
      });
      const b = await r.json();
      setRowMsg({
        id: orderId, ok: b.ok === true,
        text: b.ok
          ? (b.cancelled ? 'cancellato (confermato dal venue)' : b.alreadyGone ? 'nessun ordine a riposo con questo id (già cancellato o eseguito)' : b.simulated ? 'simulato: nessuna credenziale, nulla è stato inviato' : 'ok')
          : `rifiutato: ${dash(b.reason || b.error)}`,
      });
      await loadOrders(marketId);
    } catch (e) {
      setRowMsg({ id: orderId, ok: false, text: (e as Error).message });
    } finally { setBusyOrder(null); }
  }, [marketId, loadOrders]);

  const doReplace = useCallback(async (orderId: string) => {
    setBusyOrder(orderId); setRowMsg(null);
    try {
      const r = await fetch('/api/maker/manual/replace', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, marketId: marketId ?? undefined, book, price: Number(editPrice), size: Number(editSize) }),
      });
      const b = (await r.json()) as ReplaceResult;
      setRowMsg({
        id: orderId, ok: b.ok === true,
        text: b.ok
          ? (b.place?.sent ? 'sostituito (inviato)' : 'vecchio cancellato, nuovo costruito e validato — non inviato (dry-run)')
          : dash(b.reason),
      });
      setEditing(null);
      await loadOrders(marketId);
    } catch (e) {
      setRowMsg({ id: orderId, ok: false, text: (e as Error).message });
    } finally { setBusyOrder(null); }
  }, [marketId, book, editPrice, editSize, loadOrders]);

  if (operator !== true) return null;

  return (
    <div className="mkman-root" data-manual-panel>
      <style>{`
        .mkman-root { max-width: 980px; margin: 0 auto 8px; padding: 14px 16px 18px; color: #E6E9EF;
          border: 1px solid #2A3040; border-radius: 12px; background: #10141C;
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
        .mkman-hrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
        .mkman-title { font-size: 13px; font-weight: 800; letter-spacing: .4px; text-transform: uppercase; color: #9AA4B2; }
        .mkman-badge { font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 999px; }
        .mkman-badge-warn { color: #E8B23A; border: 1px solid #4a3c12; background: #211a08; }
        .mkman-badge-ok { color: #57C98A; border: 1px solid #205038; background: #0d1f16; }
        .mkman-badge-red { color: #FF9C93; border: 1px solid #5c1f1a; background: #240d0b; }
        .mkman-banner { border-radius: 10px; padding: 11px 14px; margin-bottom: 14px; font-size: 13px; line-height: 1.5; }
        .mkman-banner-red { color: #FFC9C4; border: 1px solid #5c1f1a; background: #1a0b0a; }
        .mkman-banner-ok { color: #A9E3C4; border: 1px solid #205038; background: #0d1f16; }
        .mkman-banner-t { font-weight: 800; letter-spacing: .3px; }
        .mkman-sec { margin-top: 20px; border-top: 1px solid #232937; padding-top: 16px; }
        .mkman-sech { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
        .mkman-sectitle { font-size: 12px; font-weight: 800; letter-spacing: .4px; text-transform: uppercase; color: #9AA4B2; }
        /* These two carry server-authored prose that can contain a bare 66-char market id (e.g. the
           isolation reason). Without a break rule the id refuses to wrap and pushes the whole page into
           horizontal scroll on a phone — so they break anywhere rather than overflow. */
        .mkman-note { font-size: 12px; color: #8B95A5; margin: 4px 2px 0; line-height: 1.45; overflow-wrap: anywhere; }
        .mkman-res { margin-top: 12px; font-size: 13px; color: #B7C0CE; line-height: 1.5; overflow-wrap: anywhere; }
        .mkman-warn { color: #E8B23A; }
        .mkman-ok { color: #57C98A; }
        .mkman-bad { color: #E5574E; }
        .mkman-num { font-variant-numeric: tabular-nums; white-space: nowrap; }
        .mkman-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px 18px; }
        .mkman-kv { font-size: 13px; }
        .mkman-k { color: #8B95A5; font-size: 11px; text-transform: uppercase; letter-spacing: .4px; display: block; }
        .mkman-v { color: #E6E9EF; font-weight: 700; font-variant-numeric: tabular-nums; }
        .mkman-mkt { border: 1px solid #232937; border-radius: 10px; padding: 10px 12px; background: #0d1119; margin-bottom: 12px; }
        .mkman-mkt-t { font-weight: 700; font-size: 14px; color: #E6E9EF; }
        .mkman-mkt-id { font-size: 11px; color: #6E7889; word-break: break-all; font-variant-numeric: tabular-nums; }
        .mkman-inrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 10px 0; font-size: 13px; color: #C4CCD8; }
        .mkman-input { width: 130px; padding: 8px 10px; border: 1px solid #2E5FBE; border-radius: 8px; background: #0d1420;
          color: #E6E9EF; font-size: 14px; font-variant-numeric: tabular-nums; }
        .mkman-input:disabled { opacity: .5; cursor: not-allowed; border-color: #2E3646; }
        .mkman-input-sm { width: 92px; padding: 5px 8px; font-size: 13px; }
        .mkman-input-bad { border-color: #8d2a24; background: #1a0d0c; }
        .mkman-field { margin: 10px 0; }
        .mkman-hint { font-size: 12px; color: #8B95A5; line-height: 1.45; flex: 1 1 220px; min-width: 0; }
        .mkman-hint b { color: #C4CCD8; }
        .mkman-flag { margin: 6px 0 0; padding: 8px 11px; border-radius: 8px; font-size: 12.5px; line-height: 1.55;
          display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .mkman-flag-bad { color: #FFC9C4; border: 1px solid #5c1f1a; background: #1a0b0a; }
        .mkman-flag-warn { color: #F0D08A; border: 1px solid #4a3c12; background: #1a1608; }
        .mkman-fix { min-height: 32px; padding: 0 12px; border: 1px solid #2E5FBE; border-radius: 7px; cursor: pointer;
          font-size: 12px; font-weight: 700; color: #DCE6FF; background: #16233E; white-space: nowrap;
          touch-action: manipulation; }
        .mkman-fix:hover { background: #1B2C4E; }
        .mkman-fix:disabled { opacity: .55; cursor: not-allowed; }
        .mkman-toggle { display: inline-flex; border: 1px solid #2E3646; border-radius: 8px; overflow: hidden; }
        .mkman-tbtn { min-height: 38px; padding: 0 18px; border: none; cursor: pointer; font-size: 13px; font-weight: 800;
          color: #9AA4B2; background: #141926; letter-spacing: .4px; }
        .mkman-tbtn:hover { background: #1b2233; }
        .mkman-tbtn-on-yes { color: #06210f; background: #57C98A; }
        .mkman-tbtn-on-no { color: #26100d; background: #E8916A; }
        .mkman-btn { min-height: 38px; padding: 0 16px; border: 1px solid #2E5FBE; border-radius: 8px; cursor: pointer;
          font-size: 13px; font-weight: 700; color: #DCE6FF; background: #16233E; touch-action: manipulation; }
        .mkman-btn:hover { background: #1B2C4E; }
        .mkman-btn:disabled { opacity: .55; cursor: not-allowed; }
        .mkman-place { min-height: 46px; padding: 0 24px; border: none; border-radius: 10px; cursor: pointer;
          font-size: 15px; font-weight: 800; color: #06210f; background: #57C98A; letter-spacing: .3px; }
        .mkman-place:disabled { background: #2b3a30; color: #6b7a70; cursor: not-allowed; }
        .mkman-take { min-height: 40px; padding: 0 18px; border: 1px solid #2E5FBE; border-radius: 8px; cursor: pointer;
          font-size: 13px; font-weight: 700; color: #DCE6FF; background: #16233E; }
        .mkman-give { min-height: 40px; padding: 0 18px; border: 1px solid #4a3c12; border-radius: 8px; cursor: pointer;
          font-size: 13px; font-weight: 700; color: #E8B23A; background: #1a1608; }
        .mkman-tbl { margin-top: 10px; font-size: 13px; overflow-x: auto; }
        .mkman-row { display: grid; grid-template-columns: 62px 78px 92px 118px 78px 92px 1fr; gap: 10px; padding: 8px 0;
          border-bottom: 1px solid #1a2030; align-items: center; min-width: 720px; }
        .mkman-head { color: #8B95A5; font-size: 11px; text-transform: uppercase; letter-spacing: .4px; }
        .mkman-src { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 999px; white-space: nowrap; }
        .mkman-src-manual { color: #DCE6FF; border: 1px solid #2E5FBE; background: #16233E; }
        .mkman-src-auto { color: #9AA4B2; border: 1px solid #2E3646; background: #141926; }
        .mkman-cancel { min-height: 32px; padding: 0 12px; border: 1px solid #5c1f1a; border-radius: 7px; cursor: pointer;
          font-size: 12px; font-weight: 700; color: #FF9C93; background: #1a0b0a; }
        .mkman-cancel:disabled { opacity: .55; cursor: wait; }
        .mkman-edit { min-height: 32px; padding: 0 12px; border: 1px solid #2E3646; border-radius: 7px; cursor: pointer;
          font-size: 12px; font-weight: 700; color: #C4CCD8; background: #1C2230; margin-right: 6px; }
        .mkman-empty { color: #8B95A5; font-size: 13px; padding: 14px 2px; }
        .mkman-reasons { margin: 8px 0 0; padding-left: 18px; font-size: 12px; color: #E8B23A; line-height: 1.5; }
        .mkman-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #9AA4B2;
          background: #0d1119; border: 1px solid #232937; border-radius: 6px; padding: 8px 10px; margin-top: 8px;
          white-space: pre-wrap; word-break: break-all; max-height: 220px; overflow: auto; }
      `}</style>

      <div className="mkman-hrow">
        <span className="mkman-title">Ordini manuali · una mano sola su un mercato</span>
        <span className={`mkman-badge ${cfg?.placement.sends ? 'mkman-badge-red' : 'mkman-badge-warn'}`} data-manual-placement>
          {cfg ? (cfg.placement.sends ? 'MANUAL_ORDER_PLACEMENT · SEND' : 'MANUAL_ORDER_PLACEMENT · DRY-RUN') : '—'}
        </span>
      </div>

      {cfgErr && <div className="mkman-banner mkman-banner-red">Stato non leggibile: {dash(cfgErr)}</div>}

      {/* ── BANNER KILL-SWITCH — the durable file, re-read every 10s. Never a static value. ── */}
      {cfg && (
        <div className={`mkman-banner ${killed ? 'mkman-banner-red' : 'mkman-banner-ok'}`} data-manual-kill-banner>
          <div className="mkman-banner-t">
            {cfg.kill.readable === false
              ? 'KILL-SWITCH NON LEGGIBILE — trattato come ATTIVO (fail closed)'
              : cfg.kill.killed
                ? 'KILL-SWITCH GLOBALE ATTIVO — nessun ordine può essere piazzato'
                : 'Kill-switch non attivo'}
          </div>
          <div>
            {cfg.kill.killed || cfg.kill.readable === false ? (
              <>
                {dash(cfg.kill.reason)}
                {cfg.kill.by ? ` · impostato da ${cfg.kill.by}` : ''}
                {cfg.kill.at ? ` · ${new Date(cfg.kill.at).toISOString()}` : ''}
                {' — il bottone «Piazza ordine» resta disabilitato finché è attivo. Le cancellazioni restano sempre possibili.'}
              </>
            ) : (
              'Il piazzamento è permesso dal kill-switch. Restano in vigore cap, venue-rules, gestione manuale e validateOrder.'
            )}
          </div>
        </div>
      )}

      {/* ── STATO: piazzamento manuale, motore automatico, isolamento ── */}
      <div className="mkman-sec" data-manual-status>
        <div className="mkman-sech">
          <span className="mkman-sectitle">Stato · piazzamento e isolamento dal motore</span>
          {cfg?.isolation && (
            <span className={`mkman-badge ${manualOn ? 'mkman-badge-ok' : 'mkman-badge-warn'}`}>
              {cfg.isolation.readable === false ? 'PROPRIETÀ NON LEGGIBILE' : manualOn ? 'GESTIONE MANUALE ATTIVA' : 'MERCATO DEL MOTORE'}
            </span>
          )}
        </div>

        <div className="mkman-grid">
          <div className="mkman-kv">
            <span className="mkman-k">Piazzamento manuale</span>
            <span className="mkman-v">{cfg ? cfg.placement.mode : '—'}</span>
          </div>
          <div className="mkman-kv">
            <span className="mkman-k">MAKER_MODE (motore)</span>
            <span className="mkman-v">{dash(cfg?.engine.mode)}</span>
          </div>
          <div className="mkman-kv">
            <span className="mkman-k">Stato motore</span>
            <span className="mkman-v">{cfg?.engine.fresh ? `fresco (${age(cfg.engine.ageSec)})` : '—'}</span>
          </div>
          <div className="mkman-kv">
            <span className="mkman-k">Il motore ha recepito</span>
            <span className="mkman-v">
              {cfg?.isolation?.engineAcknowledged === true ? <span className="mkman-ok">sì</span>
                : cfg?.isolation?.engineAcknowledged === false ? <span className="mkman-warn">non ancora</span>
                  : '—'}
            </span>
          </div>
        </div>

        <p className="mkman-note">{cfg ? cfg.placement.note : ''}</p>
        {cfg && !cfg.engine.fresh && (
          <p className="mkman-note mkman-warn">Motore: {dash(cfg.engine.unknownReason)} — «il motore ha recepito» resta «—», perché non sapere è diverso da sapere di no.</p>
        )}

        {cfg?.isolation && (
          <>
            <div className="mkman-res">{dash(cfg.isolation.reason)}</div>
            <div className="mkman-inrow">
              {manualOn ? (
                <button className="mkman-give" onClick={() => setManual(false)} disabled={busyMode} data-manual-release>
                  {busyMode ? '…' : 'Restituisci il mercato al motore'}
                </button>
              ) : (
                <button className="mkman-take" onClick={() => setManual(true)} disabled={busyMode} data-manual-take>
                  {busyMode ? '…' : 'Prendi il mercato in gestione manuale'}
                </button>
              )}
              {cfg.isolation.record?.atIso && manualOn && (
                <span className="mkman-note">dal {cfg.isolation.record.atIso}{cfg.isolation.record.by ? ` · ${cfg.isolation.record.by}` : ''}</span>
              )}
            </div>
            <p className="mkman-note">
              Prendere il mercato in gestione manuale ferma agent35 <b>solo qui</b>: dal ciclo successivo (~3s) non
              piazza e non cancella più nulla su questo mercato, e ogni altro mercato resta invariato. Non tocca il
              kill-switch globale, non arma niente e non disarma niente. Il KILL continua a cancellare tutto,
              anche gli ordini manuali.
            </p>
          </>
        )}
      </div>

      {/* ── FORM ── */}
      <div className="mkman-sec" data-manual-form>
        <div className="mkman-sech">
          <span className="mkman-sectitle">Nuovo ordine a mano</span>
          <span className="mkman-note">
            Tetto per ordine <b className="mkman-num">{money(capUsd)}</b>
            {cfg?.caps.readable
              ? ` (il più stretto fra safety-risk-limits ${money(cfg.caps.maxOrderNotionalUsd)} e il cap live-min ${money(cfg.caps.liveMinCapUsd)})`
              : ' — limiti NON leggibili, ogni ordine è rifiutato'}
          </span>
        </div>

        {/* Il mercato pinnato, preselezionato: è quello a cui il motore stesso è vincolato. */}
        {rules ? (
          <div className="mkman-mkt">
            <div className="mkman-mkt-t">{dash(rules.title)}</div>
            <div className="mkman-mkt-id">{dash(rules.marketId)}</div>
            <div className="mkman-grid" style={{ marginTop: 10 }}>
              <div className="mkman-kv"><span className="mkman-k">Mid di scoring ({book.toUpperCase()})</span><span className="mkman-v">{px(scoringMid)}</span></div>
              <div className="mkman-kv"><span className="mkman-k">Banda premio</span><span className="mkman-v">±{rules.bandRadiusCents != null ? rules.bandRadiusCents.toFixed(2) : '—'}¢</span></div>
              <div className="mkman-kv"><span className="mkman-k">Tick</span><span className="mkman-v">{dash(rules.tick)}</span></div>
              <div className="mkman-kv"><span className="mkman-k">Size minima premiata</span><span className="mkman-v">{dash(rules.minSize)}</span></div>
              <div className="mkman-kv"><span className="mkman-k">Best bid / ask (YES)</span><span className="mkman-v">{px(rules.bestBid)} / {px(rules.bestAsk)}</span></div>
              <div className="mkman-kv"><span className="mkman-k">negRisk</span><span className="mkman-v">{rules.negRisk === null ? '—' : String(rules.negRisk)}</span></div>
            </div>
            {rules.midSource !== 'live-book' && (
              <p className="mkman-note mkman-warn">
                Attenzione: il mid non viene dal book live di agent34 ma dalla riga della board
                ({dash(rules.midSource)}, {age(rules.midAgeSec)} fa). La banda è giudicata contro quel numero.
              </p>
            )}
          </div>
        ) : (
          <div className="mkman-banner mkman-banner-red">
            Nessun mercato pinnato leggibile{cfg?.engine.unknownReason ? ` — ${cfg.engine.unknownReason}` : ''}. Il form è disabilitato.
          </div>
        )}

        {rules && !rules.readable && (
          <div className="mkman-banner mkman-banner-red">
            Regole di venue non leggibili (mancano: {rules.missing.join(', ')}) — nessun ordine è giudicabile su
            questo mercato, quindi tutti sono rifiutati. Mai una banda o un tick indovinati.
          </div>
        )}

        <div className="mkman-inrow">
          <span>Lato:</span>
          <div className="mkman-toggle" role="group" aria-label="Lato dell'ordine">
            <button
              className={`mkman-tbtn ${book === 'yes' ? 'mkman-tbtn-on-yes' : ''}`}
              onClick={() => setBook('yes')} data-manual-book-yes
            >YES</button>
            <button
              className={`mkman-tbtn ${book === 'no' ? 'mkman-tbtn-on-no' : ''}`}
              onClick={() => setBook('no')} data-manual-book-no
            >NO</button>
          </div>
          <span className="mkman-note">
            Acquisto sul book scelto. Un ordine NO a q è un ordine YES a 1−q, quindi la banda è misurata nel
            book del lato selezionato — lo stesso specchio che usa il motore.
          </span>
        </div>

        {/* ── PREZZO ── the qualifying range is stated next to the field, not discovered by being refused. */}
        <div className="mkman-field" data-manual-field-price>
          <div className="mkman-inrow">
            <span>Prezzo:</span>
            <input
              className={`mkman-input ${priceOutOfBand || priceOffTick ? 'mkman-input-bad' : ''}`}
              type="number" inputMode="decimal" step={rules?.tick ?? 0.001}
              placeholder={scoringMid != null ? scoringMid.toFixed(3) : 'prezzo'}
              value={price} onChange={(e) => setPrice(e.target.value)}
              disabled={!rules?.readable} data-manual-price
            />
            <span className="mkman-hint" data-manual-price-range>
              {bounds.readable && bounds.lo != null && bounds.hi != null ? (
                <>In banda da <b className="mkman-num">{bounds.lo}</b> a <b className="mkman-num">{bounds.hi}</b> (mid {px(scoringMid)}, banda ±{rules?.bandRadiusCents != null ? rules.bandRadiusCents.toFixed(2) : '—'}¢)</>
              ) : (
                <>Banda non leggibile per questo mercato — nessun limite viene indovinato.</>
              )}
            </span>
          </div>
          {priceOutOfBand && (
            <div className="mkman-flag mkman-flag-bad" data-manual-price-warn>
              <span>
                Fuori banda: <b className="mkman-num">{priceNum}</b> non matura nulla.{' '}
                {priceNum > (bounds.hi as number)
                  ? <>Il prezzo <b>massimo</b> che resta in banda è <b className="mkman-num">{`${bounds.hi}`}</b>.</>
                  : <>Il prezzo <b>minimo</b> che resta in banda è <b className="mkman-num">{`${bounds.lo}`}</b>.</>}
              </span>
              {nearestInBand != null && (
                <button className="mkman-fix" onClick={() => setPrice(String(nearestInBand))} data-manual-use-band>
                  Usa {nearestInBand}
                </button>
              )}
            </div>
          )}
          {!priceOutOfBand && priceOffTick && snappedPrice != null && (
            <div className="mkman-flag mkman-flag-warn" data-manual-tick-warn>
              <span>
                Fuori griglia: il tick di questo mercato è <b className="mkman-num">{`${rules?.tick}`}</b>, quindi{' '}
                <b className="mkman-num">{priceNum}</b> non è piazzabile. Il prezzo valido più vicino è{' '}
                <b className="mkman-num">{`${snappedPrice}`}</b>.
              </span>
              <button className="mkman-fix" onClick={() => setPrice(String(snappedPrice))} data-manual-use-tick>
                Usa {snappedPrice}
              </button>
            </div>
          )}
        </div>

        {/* ── SIZE ── the market's own minimum sits beside the field, with a one-click fill. */}
        <div className="mkman-field" data-manual-field-size>
          <div className="mkman-inrow">
            <span>Size (share):</span>
            <input
              className={`mkman-input ${sizeBelowMin ? 'mkman-input-bad' : ''}`}
              type="number" inputMode="decimal" step={1}
              placeholder={minSize != null ? String(minSize) : 'size'}
              value={size} onChange={(e) => setSize(e.target.value)}
              disabled={!rules?.readable} data-manual-size
            />
            {minSize != null && (
              <button className="mkman-fix" onClick={() => setSize(String(minSize))} disabled={!rules?.readable} data-manual-use-min>
                Usa minimo
              </button>
            )}
            <span className="mkman-hint" data-manual-min-size>
              Size minima premiata: <b className="mkman-num">{minSize != null ? minSize : '—'}</b>
              {minSize != null && scoringMid != null ? ` (≈ ${money(minSize * scoringMid)} di controvalore)` : ''}
            </span>
          </div>
          {sizeBelowMin && (
            <div className="mkman-flag mkman-flag-bad" data-manual-size-warn>
              <span>
                Minimo richiesto: <b className="mkman-num">{minSize}</b> — il tuo valore{' '}
                <b className="mkman-num">{`(${sizeNum})`}</b> è sotto soglia di{' '}
                <b className="mkman-num">{`${+((minSize as number) - sizeNum).toFixed(4)} share`}</b>.
                Un ordine sotto il minimo è valido sul CLOB ma <b>non matura alcun premio</b>.
              </span>
              <button className="mkman-fix" onClick={() => setSize(String(minSize))} data-manual-use-min-inline>
                Usa {minSize}
              </button>
            </div>
          )}
        </div>

        <div className="mkman-inrow">
          <span className="mkman-note">
            Controvalore <b className={`mkman-num ${overCap ? 'mkman-bad' : ''}`}>{money(notional)}</b>
            {capUsd != null ? ` / ${money(capUsd)}` : ''}
          </span>
        </div>

        {/* Verdetto del guard CONDIVISO — la stessa funzione che il server rieseguirà. */}
        {verdict && !verdict.valid && (
          <ul className="mkman-reasons" data-manual-verdict>
            {verdict.reasons.map((r) => <li key={r.code}><b>{r.code}</b> — {r.detail}</li>)}
          </ul>
        )}
        {verdict?.valid && !overCap && (
          <div className="mkman-res mkman-ok" data-manual-verdict>
            Il guard condiviso (lib/maker/venue-rules) accetta questa quota: sul tick, dentro la banda, sopra la
            size minima. Il server la rivaliderà comunque prima di qualsiasi invio.
          </div>
        )}
        {overCap && (
          <div className="mkman-res mkman-bad">
            Controvalore {money(notional)} oltre il tetto per ordine {money(capUsd)} — il bottone resta disabilitato.
          </div>
        )}

        <div className="mkman-inrow" style={{ marginTop: 14 }}>
          <button className="mkman-place" onClick={doPlace} disabled={!canPlace} data-manual-place>
            {placing ? 'INVIO…' : cfg?.placement.sends ? 'PIAZZA ORDINE (INVIA DAVVERO)' : 'Piazza ordine (dry-run)'}
          </button>
          {!canPlace && (
            <span className="mkman-note mkman-warn">
              {killed ? 'Bloccato dal kill-switch globale.'
                : !manualOn ? 'Prendi prima il mercato in gestione manuale: il pannello non piazza dove il motore può ancora agire.'
                  : overCap ? 'Oltre il tetto per ordine.'
                    : !rules?.readable ? 'Regole di venue non leggibili.'
                      : verdict && !verdict.valid ? 'La quota non passa il guard condiviso.'
                        : 'Inserisci prezzo e size.'}
            </span>
          )}
        </div>

        {result && (
          <div className={`mkman-res ${result.ok ? 'mkman-ok' : 'mkman-warn'}`} data-manual-result>
            {result.ok ? (
              result.sent
                ? <>Ordine <b>INVIATO</b> al venue{result.orderId ? <> · orderId <span className="mkman-num">{result.orderId}</span></> : null}.</>
                : <>Ordine <b>costruito, firmato e validato</b> da validateOrder(), <b>NON inviato</b> (placement={dash(result.placement)}). Nulla ha raggiunto POST /order.</>
            ) : (
              <>Rifiutato al gate <b>{dash(result.gate)}</b>: {dash(result.reason)}</>
            )}
            {result.wouldSend && (
              <div className="mkman-code">{JSON.stringify(result.wouldSend, null, 2)}</div>
            )}
          </div>
        )}
      </div>

      {/* ── ORDINI ATTIVI ── */}
      <div className="mkman-sec" data-manual-orders>
        <div className="mkman-sech">
          <span className="mkman-sectitle">Ordini a riposo sul venue</span>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {orders && <span className="mkman-note">letto {new Date(orders.at).toLocaleTimeString()}</span>}
            <button className="mkman-btn" onClick={() => loadOrders(marketId)} disabled={loadingOrders} data-manual-refresh>
              {loadingOrders ? 'Lettura…' : 'Aggiorna'}
            </button>
          </div>
        </div>

        {orders && orders.ok === false && (
          <div className="mkman-res mkman-bad">
            Lettura del venue FALLITA: {dash(orders.error)} — non sappiamo cosa ci sia a riposo. Questa non è una lista vuota.
          </div>
        )}
        {orders?.simulated && orders.ok !== false && (
          <div className="mkman-res mkman-warn">
            Nessuna credenziale disponibile: il venue non è stato interrogato. «0 ordini» qui significa «non
            abbiamo letto», non «non hai ordini».
          </div>
        )}

        <div className="mkman-tbl">
          <div className="mkman-row mkman-head">
            <span>Lato</span><span>Prezzo</span><span>Size</span><span>Stato</span><span>Età</span><span>Sorgente</span><span>Azioni</span>
          </div>
          {orders && orders.orders.length === 0 && orders.ok !== false && !orders.simulated && (
            <div className="mkman-empty">Nessun ordine a riposo sul venue per questo mercato (letto dal venue, non dedotto).</div>
          )}
          {orders?.orders.map((o) => (
            <div key={o.orderId ?? Math.random()} className="mkman-row">
              <span className="mkman-v">{dash(o.side)}</span>
              <span className="mkman-num">{px(o.price)}</span>
              <span className="mkman-num">
                {dash(o.sizeRemaining ?? o.size)}
                {o.sizeMatched ? <span className="mkman-note"> ({o.sizeMatched} eseg.)</span> : null}
              </span>
              <span>{dash(o.status)}</span>
              <span className="mkman-num">{age(o.ageSec)}</span>
              <span>
                <span className={`mkman-src ${o.source === 'manual-ui' ? 'mkman-src-manual' : 'mkman-src-auto'}`}>
                  {o.source === 'manual-ui' ? 'manuale' : o.source === 'agent35' ? 'agent35' : '—'}
                </span>
              </span>
              <span>
                {editing === o.orderId ? (
                  <>
                    <input className="mkman-input mkman-input-sm" type="number" step={rules?.tick ?? 0.001}
                      value={editPrice} onChange={(e) => setEditPrice(e.target.value)} placeholder="prezzo" />
                    <input className="mkman-input mkman-input-sm" type="number" step={1}
                      value={editSize} onChange={(e) => setEditSize(e.target.value)} placeholder="size" style={{ marginLeft: 6 }} />
                    <button className="mkman-btn" style={{ marginLeft: 6, minHeight: 32 }}
                      onClick={() => o.orderId && doReplace(o.orderId)} disabled={busyOrder === o.orderId}>
                      {busyOrder === o.orderId ? '…' : 'Conferma'}
                    </button>
                    <button className="mkman-edit" style={{ marginLeft: 6 }} onClick={() => setEditing(null)}>Annulla</button>
                  </>
                ) : (
                  <>
                    {/* RIPREZZA — the price/size edit. Named for what it does to a resting order rather
                        than for the generic "modify" the venue does not actually offer. Prefilled with
                        the order's current price and remaining size, so the operator changes one number. */}
                    <button className="mkman-edit" data-manual-reprice
                      onClick={() => { setEditing(o.orderId); setEditPrice(o.price != null ? String(o.price) : ''); setEditSize(o.sizeRemaining != null ? String(o.sizeRemaining) : ''); }}>
                      Riprezza
                    </button>
                    <button className="mkman-cancel" onClick={() => o.orderId && doCancel(o.orderId)}
                      disabled={busyOrder === o.orderId} data-manual-cancel>
                      {busyOrder === o.orderId ? '…' : 'Cancella'}
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>

        {rowMsg && (
          <div className={`mkman-res ${rowMsg.ok ? 'mkman-ok' : 'mkman-warn'}`}>{rowMsg.text}</div>
        )}

        <p className="mkman-note">
          «Riprezza» è una sequenza <b>cancella → ripiazza</b> eseguita interamente sul server in una sola chiamata:
          il CLOB di Polymarket non espone nessun endpoint di modifica ordine. Il nuovo ordine viene validato
          <b> prima</b> di cancellare il vecchio, e fra i due passi esiste una finestra reale senza ordine a riposo.
          Le cancellazioni passano dall&apos;adapter cancel-only, che non possiede la chiave di firma e non può
          strutturalmente piazzare nulla.
        </p>
      </div>
    </div>
  );
}
