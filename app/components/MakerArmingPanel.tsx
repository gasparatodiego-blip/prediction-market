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

const dash = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));

export default function MakerArmingPanel() {
  // null = still probing; true = operator (admin session); false = not admin → render nothing.
  const [operator, setOperator] = useState<boolean | null>(null);
  const [killing, setKilling] = useState(false);
  const [kill, setKill] = useState<KillResponse | null>(null);
  const [killErr, setKillErr] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [pfRunning, setPfRunning] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/maker/status', { cache: 'no-store' });
        if (alive) setOperator(r.ok);
      } catch {
        if (alive) setOperator(false);
      }
    })();
    return () => { alive = false; };
  }, []);

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
    </div>
  );
}
