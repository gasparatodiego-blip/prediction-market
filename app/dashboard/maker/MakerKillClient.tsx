'use client';

import { useCallback, useEffect, useState } from 'react';

// ── shapes returned by /api/maker/cancel and /api/maker/status ──────────────────
interface VenueResult {
  venue: string;
  ok: boolean;
  error: string | null;
  cancelled: number | null;
  venueOpenBefore: number | null;
  simulated?: boolean;
  markets?: { market: string; cancelled: number | null; ok: boolean; error: string | null }[];
}
interface CancelResponse {
  ok: boolean;
  at: string;
  results: VenueResult[];
  error?: string;
}
interface StatusResponse {
  at: string;
  deadmanSeconds: number;
  heartbeat: { ageSec: number | null; cycle: number | null; mode: string | null; openOrderCount: number | null; lastError: string | null } | null;
  watchdog: { lastTriggerTs: number | null; lastTriggerIso: string | null; lastStalenessSec: number | null; triggeredForEpisode: boolean } | null;
}

type Phase = 'idle' | 'confirm' | 'cancelling' | 'done' | 'error';

const dash = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));

export default function MakerKillClient() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<CancelResponse | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [topError, setTopError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/maker/status', { cache: 'no-store' });
      if (r.ok) setStatus((await r.json()) as StatusResponse);
    } catch {
      /* read-only panel just shows — on failure */
    }
  }, []);

  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 10_000);
    return () => clearInterval(t);
  }, [loadStatus]);

  const doCancel = useCallback(async () => {
    setPhase('cancelling');
    setTopError(null);
    try {
      const r = await fetch('/api/maker/cancel', { method: 'POST' });
      const body = (await r.json()) as CancelResponse;
      setResult(body);
      setPhase('done');
      loadStatus();
    } catch (e) {
      setTopError((e as Error).message || 'request failed');
      setPhase('error');
    }
  }, [loadStatus]);

  const believedOpen = status?.heartbeat?.openOrderCount ?? null;

  return (
    <div className="mkill-root">
      <style>{`
        .mkill-root { max-width: 720px; margin: 0 auto; padding: 20px 16px 48px; color: #E6E9EF;
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
        .mkill-h1 { font-size: 20px; font-weight: 700; margin: 0 0 4px; }
        .mkill-sub { font-size: 13px; color: #9AA4B2; margin: 0 0 20px; line-height: 1.45; }
        .mkill-btn { width: 100%; min-height: 56px; border: none; border-radius: 10px; cursor: pointer;
          font-size: 17px; font-weight: 800; letter-spacing: .3px; color: #fff; touch-action: manipulation; }
        .mkill-btn:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
        .mkill-red { background: #D21F32; }
        .mkill-red:hover { background: #B81A2B; }
        .mkill-confirmrow { display: flex; gap: 10px; }
        .mkill-abort { min-height: 56px; min-width: 96px; border-radius: 10px; border: 1px solid #3A4150;
          background: #1C2230; color: #E6E9EF; font-size: 15px; font-weight: 600; cursor: pointer; }
        .mkill-note { font-size: 12px; color: #9AA4B2; margin: 10px 2px 0; line-height: 1.4; }
        .mkill-panel { margin-top: 26px; border: 1px solid #262C39; border-radius: 10px; overflow: hidden; }
        .mkill-panel-h { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px;
          color: #8B95A5; padding: 10px 14px; border-bottom: 1px solid #262C39; background: #141922; }
        .mkill-grid { display: grid; grid-template-columns: 1fr 1fr; }
        .mkill-cell { padding: 12px 14px; border-bottom: 1px solid #1C222E; }
        .mkill-cell:nth-child(odd) { border-right: 1px solid #1C222E; }
        .mkill-label { font-size: 11px; color: #8B95A5; margin-bottom: 4px; }
        .mkill-val { font-size: 16px; font-weight: 700; white-space: nowrap; }
        .mkill-results { margin-top: 22px; }
        .mkill-vrow { padding: 12px 14px; border: 1px solid #262C39; border-radius: 8px; margin-bottom: 10px; }
        .mkill-vok { border-left: 4px solid #2E9E5B; }
        .mkill-vfail { border-left: 4px solid #D21F32; }
        .mkill-vname { font-weight: 700; font-size: 15px; }
        .mkill-vdetail { font-size: 13px; color: #B7C0CE; margin-top: 4px; line-height: 1.45; }
        .mkill-vnum { white-space: nowrap; font-variant-numeric: tabular-nums; }
        .mkill-warn { color: #E8B23A; }
        .mkill-partial { color: #E8B23A; font-weight: 700; margin-bottom: 8px; }
        @media (max-width: 760px) {
          .mkill-grid { grid-template-columns: 1fr; }
          .mkill-cell:nth-child(odd) { border-right: none; }
          .mkill-confirmrow { flex-direction: column; }
        }
      `}</style>

      <h1 className="mkill-h1">Maker kill switch</h1>
      <p className="mkill-sub">
        Cancels every resting order on every configured venue immediately. This calls the venue cancel path
        directly — it does not go through the maker process, so it works even when the maker is unresponsive.
        This never places an order.
      </p>

      {/* ── the always-visible kill control ── */}
      {phase === 'idle' && (
        <button className="mkill-btn mkill-red" onClick={() => setPhase('confirm')} aria-label="Cancel all orders">
          CANCEL ALL ORDERS
        </button>
      )}

      {phase === 'confirm' && (
        <>
          <div className="mkill-confirmrow">
            <button className="mkill-btn mkill-red" onClick={doCancel} aria-label="Confirm cancel all orders">
              CONFIRM CANCEL — TAP AGAIN
            </button>
            <button className="mkill-abort" onClick={() => setPhase('idle')}>Back</button>
          </div>
          <p className="mkill-note">One more tap will cancel all orders on every configured venue.</p>
        </>
      )}

      {phase === 'cancelling' && (
        <button className="mkill-btn mkill-red" disabled style={{ opacity: 0.7, cursor: 'wait' }}>
          CANCELLING…
        </button>
      )}

      {(phase === 'done' || phase === 'error') && (
        <button className="mkill-btn mkill-red" onClick={() => { setPhase('idle'); }}>
          CANCEL ALL ORDERS
        </button>
      )}

      {/* ── result state (venue-authoritative) ── */}
      {phase === 'error' && (
        <div className="mkill-results">
          <div className="mkill-vrow mkill-vfail">
            <div className="mkill-vname mkill-warn">Request failed — no venue was confirmed cancelled</div>
            <div className="mkill-vdetail">{dash(topError)}</div>
          </div>
        </div>
      )}

      {phase === 'done' && result && (
        <div className="mkill-results">
          {!result.ok && (
            <div className="mkill-partial">
              {result.error ? 'Failed' : 'Partial — one or more venues did not confirm. Figures below are per venue.'}
            </div>
          )}
          {result.error && (
            <div className="mkill-vrow mkill-vfail">
              <div className="mkill-vname mkill-warn">Error</div>
              <div className="mkill-vdetail">{dash(result.error)}</div>
            </div>
          )}
          {result.results?.map((v) => {
            const venueName = v.venue.charAt(0).toUpperCase() + v.venue.slice(1);
            const believedDiffers =
              believedOpen !== null && v.venueOpenBefore !== null && believedOpen !== v.venueOpenBefore;
            return (
              <div key={v.venue} className={`mkill-vrow ${v.ok ? 'mkill-vok' : 'mkill-vfail'}`}>
                {v.ok ? (
                  <>
                    <div className="mkill-vname">
                      {venueName}: <span className="mkill-vnum">{dash(v.cancelled)}</span> cancelled
                      {v.simulated ? <span className="mkill-warn"> (dry-run — maker disarmed, no live orders)</span> : null}
                    </div>
                    <div className="mkill-vdetail">
                      Venue-reported open before cancel: <span className="mkill-vnum">{dash(v.venueOpenBefore)}</span> (authoritative).
                      {believedDiffers && (
                        <>
                          {' '}Our last heartbeat believed <span className="mkill-vnum">{dash(believedOpen)}</span> —
                          <span className="mkill-warn"> venue figure is authoritative.</span>
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="mkill-vname mkill-warn">{venueName}: FAILED — not cancelled</div>
                    <div className="mkill-vdetail">{dash(v.error)}</div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── read-only status panel (no controls) ── */}
      <div className="mkill-panel">
        <div className="mkill-panel-h">Live status (read-only)</div>
        <div className="mkill-grid">
          <div className="mkill-cell">
            <div className="mkill-label">Heartbeat age</div>
            <div className="mkill-val">{status?.heartbeat?.ageSec != null ? `${status.heartbeat.ageSec}s` : '—'}</div>
          </div>
          <div className="mkill-cell">
            <div className="mkill-label">MAKER_MODE</div>
            <div className="mkill-val">{dash(status?.heartbeat?.mode)}</div>
          </div>
          <div className="mkill-cell">
            <div className="mkill-label">Open orders (last heartbeat)</div>
            <div className="mkill-val">{status?.heartbeat?.openOrderCount != null ? status.heartbeat.openOrderCount : '—'}</div>
          </div>
          <div className="mkill-cell">
            <div className="mkill-label">Watchdog last trigger</div>
            <div className="mkill-val">{dash(status?.watchdog?.lastTriggerIso)}</div>
          </div>
        </div>
      </div>
      <p className="mkill-note">
        Dead-man threshold: {status?.deadmanSeconds != null ? `${status.deadmanSeconds}s` : '—'}. A stopped
        heartbeat past this triggers an automatic cancel-all by the watchdog. A same-host watchdog does not
        survive host death — the venue-native order expiry is the only layer that does.
      </p>
    </div>
  );
}
