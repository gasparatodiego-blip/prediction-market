'use client';

// MakerArmingPanel — the operator's arming + KILL console, embedded on the liquidity-rewards tab.
//
// OPERATOR-ONLY: every /api/maker/* action is gated by ADMIN_ACCESS_SECRET in middleware. This panel
// probes that gate on mount and renders NOTHING for a non-admin visitor (the public rewards board is
// unchanged for everyone else). For the operator it is a persistent control.
//
// This build ships the KILL first (the thing that must always work). The preflight table, the two-step
// ARM control and the TTL countdown are layered in by later commits; the markers below (data-maker-*) are
// the stable hooks the compiled-bundle proof greps for.

import { useCallback, useEffect, useState } from 'react';

interface VenueResult {
  venue: string;
  ok: boolean;
  error: string | null;
  cancelled: number | null;
  venueOpenBefore: number | null;
  simulated?: boolean;
}
interface KillResponse {
  ok: boolean;
  at: string;
  killed: boolean | null;
  killError: string | null;
  cancel: VenueResult[];
  cancelError: string | null;
  simulated: boolean;
  cancelledTotal: number;
  error?: string;
}

interface PreflightCheck { key: string; label: string; pass: boolean; value: string; detail: string }
interface PreflightResponse { at: string; checks: PreflightCheck[]; go: boolean; error?: string }

interface ArmStatus {
  armed: boolean; source: string; expiresInSec: number | null; expiresAt: string | null;
  armedAt: string | null; totalSizeUsd: number | null; ttlSeconds: number | null; collateralCapUsd: number | null;
}
interface PreviewMarket { marketId: string; title: string; mid: number | null; bid: number | null; ask: number | null; sizePerSideUsd: number | null; collateralUsd: number | null; readable: boolean }
interface ArmPreview { readable: boolean; blockedReason: string | null; markets: PreviewMarket[]; totalCollateralUsd: number | null; perSideSizeUsd: number | null; ttlSeconds: number | null }

const money = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `$${v.toFixed(2)}`);
const price = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : v.toFixed(3));

const dash = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));

export default function MakerArmingPanel() {
  // null = still probing; true = operator (admin session); false = not admin → render nothing.
  const [operator, setOperator] = useState<boolean | null>(null);
  const [killing, setKilling] = useState(false);
  const [kill, setKill] = useState<KillResponse | null>(null);
  const [killErr, setKillErr] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [pfRunning, setPfRunning] = useState(false);
  const [armStatus, setArmStatus] = useState<ArmStatus | null>(null);
  const [armOpen, setArmOpen] = useState(false); // step 1: the deliberate reveal (no accidental tap)
  const [perSide, setPerSide] = useState('');
  const [typedTotal, setTypedTotal] = useState(''); // step 2: type the exact total to confirm
  const [preview, setPreview] = useState<ArmPreview | null>(null);
  const [arming, setArming] = useState(false);
  const [armMsg, setArmMsg] = useState<string | null>(null);

  const loadArmStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/maker/arm', { cache: 'no-store' });
      if (r.ok) setArmStatus((await r.json()) as ArmStatus);
    } catch { /* read-only; leave prior status */ }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/maker/status', { cache: 'no-store' });
        if (!alive) return;
        setOperator(r.ok);
        if (r.ok) loadArmStatus();
      } catch {
        if (alive) setOperator(false);
      }
    })();
    const t = setInterval(() => { if (alive) loadArmStatus(); }, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, [loadArmStatus]);

  const loadPreview = useCallback(async (perSideVal: string) => {
    const qs = perSideVal ? `?perSide=${encodeURIComponent(perSideVal)}` : '';
    try {
      const r = await fetch(`/api/maker/arm-preview${qs}`, { cache: 'no-store' });
      setPreview((await r.json()) as ArmPreview);
    } catch (e) {
      setPreview({ readable: false, blockedReason: (e as Error).message, markets: [], totalCollateralUsd: null, perSideSizeUsd: null, ttlSeconds: null });
    }
  }, []);

  const doArm = useCallback(async () => {
    if (!preview?.readable || preview.totalCollateralUsd == null) return;
    setArming(true);
    setArmMsg(null);
    try {
      const r = await fetch('/api/maker/arm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalSizeUsd: preview.totalCollateralUsd,
          typedSizeConfirm: Number(typedTotal),
          perSideSizeUsd: perSide ? Number(perSide) : undefined,
          universeMarketIds: preview.markets.map((m) => m.marketId),
        }),
      });
      const body = await r.json();
      if (body.ok) { setArmMsg('ARMED.'); setArmOpen(false); setTypedTotal(''); }
      else setArmMsg(`Refused (${body.refusedBy || 'error'}): ${body.reason || body.error || 'blocked'}`);
      loadArmStatus();
    } catch (e) {
      setArmMsg((e as Error).message);
    } finally {
      setArming(false);
    }
  }, [preview, typedTotal, perSide, loadArmStatus]);

  const doDisarm = useCallback(async () => {
    try { await fetch('/api/maker/disarm', { method: 'POST' }); loadArmStatus(); } catch { /* ignore */ }
  }, [loadArmStatus]);

  // The KILL is ONE action — no confirmation dialog stands between the operator and stopping the maker.
  const doKill = useCallback(async () => {
    setKilling(true);
    setKillErr(null);
    try {
      const r = await fetch('/api/maker/kill', { method: 'POST' });
      setKill((await r.json()) as KillResponse);
    } catch (e) {
      setKillErr((e as Error).message || 'request failed');
    } finally {
      setKilling(false);
    }
  }, []);

  // Preflight is deliberate + slow (it signs an order offline and reads chain state) → run on demand, never
  // on mount. It reads REAL state every time; there is no cached "armable" flag.
  const runPreflight = useCallback(async () => {
    setPfRunning(true);
    try {
      const r = await fetch('/api/maker/preflight', { cache: 'no-store' });
      setPreflight((await r.json()) as PreflightResponse);
    } catch (e) {
      setPreflight({ at: new Date().toISOString(), checks: [], go: false, error: (e as Error).message });
    } finally {
      setPfRunning(false);
    }
  }, []);

  if (operator !== true) return null;

  return (
    <div className="mkarm-root" data-maker-panel>
      <style>{`
        .mkarm-root { max-width: 980px; margin: 0 auto 8px; padding: 14px 16px 18px; color: #E6E9EF;
          border: 1px solid #2A3040; border-radius: 12px; background: #10141C;
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
        .mkarm-hrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
        .mkarm-title { font-size: 13px; font-weight: 800; letter-spacing: .4px; text-transform: uppercase; color: #9AA4B2; }
        .mkarm-badge { font-size: 11px; font-weight: 700; color: #E8B23A; border: 1px solid #4a3c12; background: #211a08;
          padding: 3px 8px; border-radius: 999px; }
        .mkarm-killbtn { min-height: 48px; padding: 0 22px; border: none; border-radius: 10px; cursor: pointer;
          font-size: 15px; font-weight: 800; letter-spacing: .4px; color: #fff; background: #D21F32; touch-action: manipulation; }
        .mkarm-killbtn:hover { background: #B81A2B; }
        .mkarm-killbtn:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
        .mkarm-killbtn:disabled { opacity: .6; cursor: wait; }
        .mkarm-note { font-size: 12px; color: #8B95A5; margin: 4px 2px 0; line-height: 1.45; }
        .mkarm-res { margin-top: 12px; font-size: 13px; color: #B7C0CE; line-height: 1.5; }
        .mkarm-warn { color: #E8B23A; }
        .mkarm-ok { color: #57C98A; }
        .mkarm-num { font-variant-numeric: tabular-nums; white-space: nowrap; }
        .mkarm-sec { margin-top: 20px; border-top: 1px solid #232937; padding-top: 16px; }
        .mkarm-sech { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
        .mkarm-sectitle { font-size: 12px; font-weight: 800; letter-spacing: .4px; text-transform: uppercase; color: #9AA4B2; }
        .mkarm-btn { min-height: 38px; padding: 0 16px; border: 1px solid #2E5FBE; border-radius: 8px; cursor: pointer;
          font-size: 13px; font-weight: 700; color: #DCE6FF; background: #16233E; touch-action: manipulation; }
        .mkarm-btn:hover { background: #1B2C4E; }
        .mkarm-btn:disabled { opacity: .6; cursor: wait; }
        .mkarm-verdict { font-size: 13px; font-weight: 800; padding: 3px 10px; border-radius: 999px; }
        .mkarm-go { color: #57C98A; border: 1px solid #205038; background: #0d1f16; }
        .mkarm-nogo { color: #E8B23A; border: 1px solid #4a3c12; background: #211a08; }
        .mkarm-check { display: grid; grid-template-columns: 20px 1fr auto; gap: 10px; align-items: baseline;
          padding: 8px 0; border-bottom: 1px solid #1a2030; font-size: 13px; }
        .mkarm-dot { font-weight: 900; }
        .mkarm-dot-green { color: #57C98A; }
        .mkarm-dot-red { color: #E5574E; }
        .mkarm-clabel { color: #C4CCD8; line-height: 1.4; }
        .mkarm-cdetail { color: #8B95A5; font-size: 12px; margin-top: 2px; line-height: 1.4; }
        .mkarm-cval { color: #E6E9EF; font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
        .mkarm-cval-red { color: #E5574E; }
        .mkarm-armed { border: 1px solid #205038; background: #0d1f16; border-radius: 10px; padding: 12px 14px; }
        .mkarm-armed-t { font-weight: 800; color: #57C98A; font-size: 14px; }
        .mkarm-toggle { min-height: 40px; padding: 0 16px; border: 1px solid #3A4150; border-radius: 8px; cursor: pointer;
          font-size: 13px; font-weight: 700; color: #E6E9EF; background: #1C2230; }
        .mkarm-toggle:hover { background: #232a3a; }
        .mkarm-input { width: 140px; padding: 8px 10px; border: 1px solid #2E5FBE; border-radius: 8px; background: #0d1420;
          color: #E6E9EF; font-size: 14px; font-variant-numeric: tabular-nums; }
        .mkarm-inrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 10px 0; font-size: 13px; color: #C4CCD8; }
        .mkarm-ptbl { margin: 10px 0; font-size: 13px; }
        .mkarm-prow { display: grid; grid-template-columns: 1fr auto auto auto; gap: 10px; padding: 6px 0;
          border-bottom: 1px solid #1a2030; align-items: baseline; }
        .mkarm-phead { color: #8B95A5; font-size: 11px; text-transform: uppercase; letter-spacing: .4px; }
        .mkarm-armbtn { min-height: 44px; padding: 0 20px; border: none; border-radius: 10px; cursor: pointer;
          font-size: 15px; font-weight: 800; color: #06210f; background: #57C98A; }
        .mkarm-armbtn:disabled { background: #2b3a30; color: #6b7a70; cursor: not-allowed; }
        .mkarm-disarm { min-height: 40px; padding: 0 18px; border: 1px solid #4a3c12; border-radius: 8px; cursor: pointer;
          font-size: 13px; font-weight: 700; color: #E8B23A; background: #1a1608; }
      `}</style>

      <div className="mkarm-hrow">
        <span className="mkarm-title">Maker · arming console</span>
        <span className="mkarm-badge" data-maker-disarmed>DISARMED · MAKER_MODE off</span>
      </div>

      {/* ── KILL: one tap, no confirmation dialog. Runs server-side; never depends on polymarket.com. ── */}
      <button
        className="mkarm-killbtn"
        data-maker-kill
        onClick={doKill}
        disabled={killing}
        aria-label="Kill the maker and cancel all resting orders now"
      >
        {killing ? 'KILLING…' : 'KILL — DISARM & CANCEL ALL'}
      </button>
      <p className="mkarm-note">
        One tap disarms the maker (durable global kill) and cancels every resting order — entirely on the
        Edgeradar server, no browser call to polymarket.com. Safe even when the maker is already off.
      </p>

      {killErr && <div className="mkarm-res mkarm-warn">Request failed — nothing confirmed: {dash(killErr)}</div>}

      {kill && (
        <div className="mkarm-res">
          <div>
            Disarm (durable kill): {kill.killed ? <span className="mkarm-ok">SET</span> : <span className="mkarm-warn">FAILED — {dash(kill.killError)}</span>}
          </div>
          {kill.cancelError ? (
            <div className="mkarm-warn">Cancel sweep error: {dash(kill.cancelError)}</div>
          ) : (
            <div>
              Cancel sweep:{' '}
              <span className="mkarm-num">{kill.cancelledTotal}</span> cancelled
              {kill.simulated ? <span className="mkarm-warn"> (dry-run — no cancel creds / disarmed build)</span> : <span className="mkarm-ok"> (live)</span>}
              {kill.cancel?.map((v) => (
                <span key={v.venue}>
                  {' · '}{v.venue}: venue-open-before <span className="mkarm-num">{dash(v.venueOpenBefore)}</span>
                  {v.ok ? '' : <span className="mkarm-warn"> (FAILED: {dash(v.error)})</span>}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── PREFLIGHT: the arming gate. Real values read at click time; any red check blocks arming. ── */}
      <div className="mkarm-sec" data-maker-preflight>
        <div className="mkarm-sech">
          <span className="mkarm-sectitle">Preflight — arming gate</span>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {preflight && !preflight.error && (
              <span className={`mkarm-verdict ${preflight.go ? 'mkarm-go' : 'mkarm-nogo'}`}>
                {preflight.go ? 'GO' : 'NO-GO'}
              </span>
            )}
            <button className="mkarm-btn" onClick={runPreflight} disabled={pfRunning}>
              {pfRunning ? 'Reading real state…' : 'Run preflight'}
            </button>
          </div>
        </div>

        {preflight?.error && <div className="mkarm-res mkarm-warn">Preflight failed: {dash(preflight.error)}</div>}

        {preflight && !preflight.error && preflight.checks.map((c) => (
          <div key={c.key} className="mkarm-check">
            <span className={`mkarm-dot ${c.pass ? 'mkarm-dot-green' : 'mkarm-dot-red'}`}>{c.pass ? '●' : '✕'}</span>
            <span>
              <span className="mkarm-clabel">{c.label}</span>
              {!c.pass && c.detail && <div className="mkarm-cdetail">{c.detail}</div>}
            </span>
            <span className={`mkarm-cval ${c.pass ? '' : 'mkarm-cval-red'}`}>{dash(c.value)}</span>
          </div>
        ))}

        {preflight && !preflight.error && (
          <p className="mkarm-note">
            {preflight.go
              ? 'All checks pass — arming would be permitted (still gated by MAKER_MODE + MAKER_FUNDING_APPROVED).'
              : 'A red check blocks arming. There is no override — fix the red item and re-run. Read live; never cached.'}
          </p>
        )}
      </div>

      {/* ── ARM control: two-step (deliberate reveal, then type the exact total). Gated on a fresh preflight. ── */}
      <div className="mkarm-sec" data-maker-arm>
        <div className="mkarm-sech">
          <span className="mkarm-sectitle">Arm control</span>
          {armStatus?.armed
            ? <span className="mkarm-verdict mkarm-go">ARMED</span>
            : <span className="mkarm-verdict mkarm-nogo">DISARMED</span>}
        </div>

        {armStatus?.armed ? (
          <div className="mkarm-armed">
            <div className="mkarm-armed-t">Maker is ARMED (record only — placement still needs MAKER_MODE + funding)</div>
            <div className="mkarm-res">
              Total size {money(armStatus.totalSizeUsd)} · TTL {armStatus.ttlSeconds != null ? `${Math.round(armStatus.ttlSeconds / 3600)}h` : '—'} ·
              expires <span className="mkarm-num">{dash(armStatus.expiresAt)}</span>
              {armStatus.expiresInSec != null && <> (<span className="mkarm-num">{armStatus.expiresInSec}</span>s)</>}
            </div>
            <div style={{ marginTop: 10 }}>
              <button className="mkarm-disarm" onClick={doDisarm}>DISARM</button>
            </div>
          </div>
        ) : !armOpen ? (
          <>
            <button className="mkarm-toggle" onClick={() => { setArmOpen(true); loadPreview(perSide); }}>
              Enable arming…
            </button>
            <p className="mkarm-note">Step 1 of 2 — a deliberate reveal, so a stray tap cannot arm.</p>
          </>
        ) : (
          <>
            <div className="mkarm-inrow">
              <span>Size per side (USD):</span>
              <input
                className="mkarm-input" type="number" inputMode="decimal" placeholder="e.g. 200"
                value={perSide}
                onChange={(e) => { setPerSide(e.target.value); loadPreview(e.target.value); }}
              />
            </div>

            {/* What you're about to arm — every number real or "—"; blocked if unreadable. */}
            {preview && (
              <div className="mkarm-ptbl">
                <div className="mkarm-prow mkarm-phead"><span>Market</span><span>Bid</span><span>Ask</span><span>Size</span></div>
                {preview.markets.map((m) => (
                  <div key={m.marketId} className="mkarm-prow">
                    <span className="mkarm-clabel">{m.title || m.marketId.slice(0, 10)}</span>
                    <span className="mkarm-num">{price(m.bid)}</span>
                    <span className="mkarm-num">{price(m.ask)}</span>
                    <span className="mkarm-num">{money(m.sizePerSideUsd)}</span>
                  </div>
                ))}
                <div className="mkarm-res">
                  Total collateral <b className="mkarm-num">{money(preview.totalCollateralUsd)}</b> ·
                  TTL 4h (default) {!preview.readable && <span className="mkarm-warn"> · {dash(preview.blockedReason)} — arming blocked</span>}
                </div>
              </div>
            )}

            <div className="mkarm-inrow">
              <span>Step 2 — type the total collateral to confirm{preview?.totalCollateralUsd != null ? ` (${money(preview.totalCollateralUsd)})` : ''}:</span>
              <input
                className="mkarm-input" type="number" inputMode="decimal" placeholder="type total"
                value={typedTotal} onChange={(e) => setTypedTotal(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 }}>
              <button
                className="mkarm-armbtn"
                onClick={doArm}
                disabled={
                  arming ||
                  !preview?.readable ||
                  preview?.totalCollateralUsd == null ||
                  Number(typedTotal) !== preview?.totalCollateralUsd ||
                  preflight?.go !== true
                }
              >
                {arming ? 'ARMING…' : 'ARM'}
              </button>
              <button className="mkarm-toggle" onClick={() => { setArmOpen(false); setTypedTotal(''); }}>Cancel</button>
            </div>
            <p className="mkarm-note">
              {preflight?.go !== true
                ? 'Run the preflight first — arming is refused while any check is red (server re-runs it fresh on ARM).'
                : 'ARM enables only when the typed total matches exactly and the preflight is GO.'}
            </p>
          </>
        )}

        {armMsg && <div className="mkarm-res mkarm-warn">{dash(armMsg)}</div>}
      </div>
    </div>
  );
}
