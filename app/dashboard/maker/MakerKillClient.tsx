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
// POST /api/maker/kill — the SAME endpoint scripts/kill-maker.sh calls. It sets the DURABLE global kill
// (data/safety-kill-switch.json, which agent35 re-reads every tick and a pm2 restart cannot clear),
// withdraws the arming authorization, and runs the cancel sweep. `killed` is the load-bearing field:
// cancelling orders without disarming the engine just lets it re-quote them.
interface KillResponse {
  ok: boolean;
  at: string;
  killed: boolean | null;
  killError: string | null;
  armingDisarmed: boolean | null;
  cancel: VenueResult[];
  cancelError: string | null;
  simulated: boolean;
  cancelledTotal: number;
  error?: string;
}
interface StatusResponse {
  at: string;
  deadmanSeconds: number;
  heartbeat: { ageSec: number | null; cycle: number | null; mode: string | null; openOrderCount: number | null; lastError: string | null } | null;
  watchdog: { lastTriggerTs: number | null; lastTriggerIso: string | null; lastStalenessSec: number | null; triggeredForEpisode: boolean } | null;
}

type Phase = 'idle' | 'confirm' | 'killing' | 'done' | 'error';

const dash = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));

export default function MakerKillClient() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<KillResponse | null>(null);
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

  // ONE code path. This is the same POST /api/maker/kill that scripts/kill-maker.sh makes — the button
  // and the script are the same action, not two implementations that can drift apart. It sets the durable
  // switch AND sweeps the orders; cancelling without disarming would let the engine re-quote.
  const doKill = useCallback(async () => {
    setPhase('killing');
    setTopError(null);
    try {
      const r = await fetch('/api/maker/kill', { method: 'POST' });
      const body = (await r.json()) as KillResponse;
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

      {/* THE CONTROL IS THE FIRST THING ON THE PAGE. In an emergency nothing may sit above it — no
          heading to read past, no status panel to scroll through. The title comes after the button. */}
      {phase === 'idle' && (
        <button className="mkill-btn mkill-red" onClick={() => setPhase('confirm')} aria-label="Kill the maker">
          KILL MAKER
        </button>
      )}

      {phase === 'confirm' && (
        <>
          <div className="mkill-confirmrow">
            <button className="mkill-btn mkill-red" onClick={doKill} aria-label="Confirm kill the maker">
              CONFIRM KILL — TAP AGAIN
            </button>
            <button className="mkill-abort" onClick={() => setPhase('idle')}>Back</button>
          </div>
          <p className="mkill-note">One more tap disarms the maker durably and cancels every resting order.</p>
        </>
      )}

      {phase === 'killing' && (
        <button className="mkill-btn mkill-red" disabled style={{ opacity: 0.7, cursor: 'wait' }}>
          KILLING…
        </button>
      )}

      {(phase === 'done' || phase === 'error') && (
        <button className="mkill-btn mkill-red" onClick={() => { setPhase('idle'); }}>
          KILL MAKER
        </button>
      )}

      <h1 className="mkill-h1">Maker kill switch</h1>
      <p className="mkill-sub">
        Disarms the maker durably and cancels every resting order on every configured venue. The durable
        part is what stops the engine: a pm2 restart cannot clear it, and agent35 re-reads it every tick.
        This runs inside the Edgeradar backend, so it works even when the maker is unresponsive and even
        when polymarket.com is unreachable from this browser. It never places an order.
        The same action from a shell: <code>./scripts/kill-maker.sh</code>
      </p>

      {/* ── result state (venue-authoritative) ── */}
      {phase === 'error' && (
        <div className="mkill-results">
          <div className="mkill-vrow mkill-vfail">
            <div className="mkill-vname mkill-warn">Request failed — the maker was NOT killed</div>
            <div className="mkill-vdetail">
              {dash(topError)} — run <code>./scripts/kill-maker.sh</code> from a shell; it confirms the
              durable switch by re-reading it.
            </div>
          </div>
        </div>
      )}

      {phase === 'done' && result && (
        <div className="mkill-results">
          {/* The load-bearing outcome: is the DURABLE switch set? Cancelling orders without disarming
              the engine only invites it to re-quote them, so this is reported first and separately. */}
          <div className={`mkill-vrow ${result.killed === true ? 'mkill-vok' : 'mkill-vfail'}`}>
            <div className={`mkill-vname ${result.killed === true ? '' : 'mkill-warn'}`}>
              {result.killed === true ? 'Maker DISARMED — durable kill set' : 'Durable kill NOT set'}
            </div>
            <div className="mkill-vdetail">
              {result.killed === true
                ? `agent35 stands down on its next tick. A pm2 restart cannot clear this.${result.armingDisarmed ? ' Arming authorization withdrawn.' : ''}`
                : `${dash(result.killError)} — the engine may still be armed. Run ./scripts/kill-maker.sh, which confirms by re-reading the state file.`}
            </div>
          </div>
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
          {result.cancel?.map((v) => {
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
