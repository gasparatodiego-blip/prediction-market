'use client';

// MakerArmingPanel — the operator's arming + KILL console, embedded on the liquidity-rewards tab.
//
// OPERATOR-ONLY: every /api/maker/* action is gated by ADMIN_ACCESS_SECRET in middleware. This panel
// probes that gate on mount and renders NOTHING for a non-admin visitor (the public rewards board is
// unchanged for everyone else). For the operator it is a persistent control.
//
// EXCHANGE SURFACE. The state instrument is a COMPACT BADGE beside the title, not a 46px ring: the ring
// spent a third of the first screen saying one word. The facts it used to carry — arming TTL, total size,
// open exposure, collateral cap — are now four monospaced figures in a dense strip, all visible at once.
//
// KILL and RIPRISTINA live in a FIXED bottom bar. They are the two actions that must be reachable at the
// worst possible moment, and hunting for a scrolled-away button is exactly the failure this avoids. Each
// exists ONCE in the tree (the markers below are the stable hooks), with the same handlers and the same
// enable logic as before: KILL is never blocked, RIPRISTINA is live only while the kill actually is.

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

// ── RIPRISTINA ── the green counterpart to the red KILL. Its result is a LIST OF STEPS, each with its own
// evidence, because this feature exists precisely because "the orders table is empty" was once accepted as
// proof of a clean state and was not proof at all.
interface ResetStep { key: string; ok: boolean; label: string; evidence: unknown; at: string }
interface ResetDiagnosis {
  readable: boolean; openNotionalUsd: number | null;
  fromConfirmedPositionsUsd: number; fromUnresolvedOrdersUsd: number;
  unknowns: Array<{ idempotencyKey: string; notionalUsd: number; assumed?: string; stale?: boolean }>;
  note: string;
}
interface ResetResponse {
  ok: boolean; at: string; latencyMs?: number; steps: ResetStep[];
  before?: ResetDiagnosis; after?: ResetDiagnosis;
  cancelled?: Array<{ orderId: string; ok: boolean; cancelled: boolean; alreadyGone: boolean; reason: string | null }>;
  resolved?: { fills: number; nofills: number; stillUnknown: number; ran: boolean };
  killCleared?: boolean; venueOrdersAfter?: number; openNotionalAfter?: number | null;
  reason: string | null; error?: string;
}
interface ResetState {
  kill: { killed: boolean; readable: boolean; reason: string | null; at: number | null };
  diagnosis: ResetDiagnosis;
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
  const [countdown, setCountdown] = useState<number | null>(null); // live TTL seconds remaining
  // ── RIPRISTINA state. `resetState` is polled read-only and drives whether the button is enabled at all.
  const [resetState, setResetState] = useState<ResetState | null>(null);
  const [resetting, setResetting] = useState(false);
  const [reset, setReset] = useState<ResetResponse | null>(null);
  const [resetErr, setResetErr] = useState<string | null>(null);

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

  const doRenew = useCallback(async () => {
    setArmMsg(null);
    try {
      const r = await fetch('/api/maker/renew', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await r.json();
      if (!body.ok) setArmMsg(`Renew refused (${body.refusedBy || 'error'}): ${body.reason || body.error || ''}`);
      loadArmStatus();
    } catch (e) { setArmMsg((e as Error).message); }
  }, [loadArmStatus]);

  // Live TTL countdown: seed from the server's expiresInSec, tick locally, and when it hits 0 refetch —
  // the server auto-disarms the record the instant it is read past expiry (readArming enforces the TTL).
  useEffect(() => {
    setCountdown(armStatus?.armed ? armStatus.expiresInSec ?? null : null);
  }, [armStatus]);
  useEffect(() => {
    if (countdown == null) return;
    if (countdown <= 0) { loadArmStatus(); return; }
    const t = setTimeout(() => setCountdown((c) => (c == null ? null : c - 1)), 1_000);
    return () => clearTimeout(t);
  }, [countdown, loadArmStatus]);

  const fmtDur = (s: number | null): string => {
    if (s == null) return '—';
    if (s <= 0) return 'expired';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

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

  // ── RIPRISTINA ── read-only poll: is the kill on, and what would the reset be fixing? Cheap, and it is
  // the SINGLE source for both the button's enabled state and the "before" numbers, so the two cannot
  // disagree for a few seconds and leave a green button pointing at a kill that is already clear.
  const loadResetState = useCallback(async () => {
    try {
      const r = await fetch('/api/maker/manual/reset', { cache: 'no-store' });
      if (!r.ok) return;
      setResetState((await r.json()) as ResetState);
    } catch { /* keep the last good state; the button simply stays as it was */ }
  }, []);

  // The reset is NOT instant — it makes several real venue round trips (read, cancel, re-read, cross-check
  // trades, re-read again). `resetting` disables the button for the whole sequence so a second tap cannot
  // start a parallel run, and the caption says which kind of work is in flight rather than a bare spinner.
  const doReset = useCallback(async () => {
    setResetting(true);
    setResetErr(null);
    setReset(null);
    try {
      const r = await fetch('/api/maker/manual/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'ripristino dal pannello operatore' }),
      });
      setReset((await r.json()) as ResetResponse);
      await loadResetState();
      await loadArmStatus();
    } catch (e) {
      setResetErr((e as Error).message || 'request failed');
    } finally {
      setResetting(false);
    }
  }, [loadResetState, loadArmStatus]);

  // Its OWN effect, deliberately separate from the arming poll above: this feature must not alter the
  // arming console's fetch cadence or its lifecycle in any way.
  useEffect(() => {
    if (operator !== true) return;
    loadResetState();
    const t = setInterval(loadResetState, 10_000);
    return () => clearInterval(t);
  }, [operator, loadResetState]);

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

  // ── "IL BOT STA LAVORANDO?" ───────────────────────────────────────────────────────────────────────
  // Questo pannello E' la fonte di quel fatto: legge /api/maker/status e lo stato del kill. La console
  // qui sotto non lo ri-deduce apposta — un fatto solo, letto in un posto solo.
  //
  // Quattro stati, come nel resto della console. Il grigio "non lo sappiamo" non si veste mai da rosso
  // "e' fermo": se lo stato del kill non e' leggibile, non sappiamo se il bot gira, e dire "fermo"
  // sarebbe una deduzione. L'ordine dei controlli e' deliberato: il kill vince su tutto, perche' un
  // maker armato con il kill attivo non sta comunque piazzando niente.
  const bot: { state: 'ok' | 'warn' | 'bad' | 'unknown'; label: string; detail: string } =
    resetState?.kill.readable === false
      ? {
        state: 'unknown',
        label: 'NON LO SAPPIAMO',
        detail: `Lo stato del kill-switch non è leggibile${resetState.kill.reason ? `: ${resetState.kill.reason}` : ''}. Non è né «gira» né «fermo».`,
      }
      : resetState?.kill.killed === true
        ? {
          state: 'bad',
          label: 'FERMATO DAL KILL',
          detail: 'Il kill-switch è attivo: nessun ordine viene piazzato finché non premi RIPRISTINA.',
        }
        : armStatus == null
          ? { state: 'unknown', label: 'IN LETTURA…', detail: 'Stato di arming non ancora ricevuto dal server.' }
          : armStatus.armed
            ? {
              state: 'ok',
              label: 'ARMATO',
              detail: `Il maker può piazzare${countdown != null ? `, e resta armato ancora ${Math.max(0, Math.round(countdown / 60))} min` : ''}. L'arming scade da solo: è un dead-man's switch, non un interruttore.`,
            }
            : {
              state: 'warn',
              label: 'FERMO — NON ARMATO',
              detail: 'Il maker non piazza nulla. Gli ordini già a riposo sul venue restano dove sono: disarmare non li cancella.',
            };

  const badgeClass = bot.state === 'ok' ? 'is-ok' : bot.state === 'bad' ? 'is-bad' : bot.state === 'warn' ? 'is-warn' : '';
  const killOn = resetState?.kill.killed === true;

  return (
    <div className="mkarm-root exch" data-maker-panel>
      <style>{CSS}</style>

      {/* ── HEADER — the state is a COMPACT BADGE beside the title, not a ring. ──────────────────────
          Qui c'era un badge con il testo fisso «DISARMED · MAKER_MODE off»: una stringa scritta a mano,
          che continuava a dire DISARMED anche con armStatus.armed a true. Una cifra o un'etichetta che
          non puo' cambiare non e' uno stato, e' una decorazione che a volte mente. Adesso lo stato viene
          letto, e quando non e' leggibile lo dice. Il colore non e' mai l'unico canale: la risposta sta
          nel testo del badge, e la riga sotto la spiega per esteso. */}
      <div className="mkarm-hrow">
        <span className="mkarm-title">Maker · arming</span>
        <span className={`ex-badge ${badgeClass}`} data-maker-botstate={bot.state}>{bot.label}</span>
      </div>
      <p className="mkarm-detail">{bot.detail}</p>

      {/* ── THE FOUR FIGURES, ALL VISIBLE. Each renders even when it is zero or unreadable: a missing
             number is read as "nothing to worry about", which is the one thing it never means. ─────── */}
      <div className="ex-stats" data-maker-stats>
        <div className="ex-stat">
          <span className="ex-stat-k">Auto-disarm fra</span>
          <span className="ex-stat-v" style={{ color: countdown == null ? 'var(--ex-txt-2)' : countdown < 300 ? 'var(--ex-gold)' : 'var(--ex-green)' }} data-maker-ttl-countdown>
            {fmtDur(countdown)}
          </span>
          <span className="ex-stat-s">
            {armStatus?.armed ? `scade ${dash(armStatus.expiresAt)}` : 'non armato — nessun timer in corso'}
          </span>
        </div>
        <div className="ex-stat">
          <span className="ex-stat-k">Size armata</span>
          <span className="ex-stat-v">{money(armStatus?.totalSizeUsd)}</span>
          <span className="ex-stat-s">
            {armStatus?.armed
              ? `TTL ${armStatus.ttlSeconds != null ? `${Math.round(armStatus.ttlSeconds / 3600)}h` : '—'}`
              : 'nessun arming attivo'}
          </span>
        </div>
        <div className="ex-stat">
          <span className="ex-stat-k">Esposizione aperta</span>
          <span className="ex-stat-v">{money(resetState?.diagnosis.openNotionalUsd)}</span>
          <span className="ex-stat-s">vista dal gate cap</span>
          {resetState?.diagnosis.readable === false && (
            <p className="ex-why">Non leggibile: il gate cap non ha potuto misurare l&apos;esposizione — non è «zero».</p>
          )}
          {(resetState?.diagnosis.fromUnresolvedOrdersUsd ?? 0) > 0 && (
            <p className="ex-why">
              {money(resetState!.diagnosis.fromUnresolvedOrdersUsd)} da {resetState!.diagnosis.unknowns.length} ordini
              inviati mai riconciliati, non da posizioni reali.
            </p>
          )}
        </div>
        <div className="ex-stat">
          <span className="ex-stat-k">Cap collaterale</span>
          <span className="ex-stat-v">{money(armStatus?.collateralCapUsd)}</span>
          <span className="ex-stat-s">tetto per arming</span>
        </div>
      </div>

      {killErr && <div className="ex-banner is-bad mkarm-mt">Request failed — nothing confirmed: {dash(killErr)}</div>}

      {/* ── RIPRISTINA: what it would fix, before you press it ────────────────────────────────────────
          Shown only while the kill is on. The split between confirmed positions and unresolved orders is
          the whole point: a total alone is what made "$67.04 open exposure with an empty orders table"
          unexplainable in the first place. */}
      {killOn && resetState?.diagnosis && (
        <div className="ex-banner is-bad mkarm-mt" data-maker-reset-preview>
          Kill-switch <b>ATTIVO</b>{resetState.kill.reason ? ` — ${resetState.kill.reason}` : ''}. Esposizione aperta{' '}
          <b className="ex-n">{money(resetState.diagnosis.openNotionalUsd)}</b>
          {resetState.diagnosis.fromUnresolvedOrdersUsd > 0 && (
            <> — di cui <b className="ex-n">{money(resetState.diagnosis.fromUnresolvedOrdersUsd)}</b> da{' '}
              <b className="ex-n">{resetState.diagnosis.unknowns.length}</b> ordini inviati mai riconciliati.</>
          )}
          <div className="mkarm-note">{resetState.diagnosis.note}</div>
        </div>
      )}

      {resetErr && <div className="ex-banner is-bad mkarm-mt">Ripristino fallito — nulla è confermato: {dash(resetErr)}</div>}

      {/* ── RIPRISTINA: the result, step by step, each with its evidence ─────────────────────────────── */}
      {reset && (
        <div className={`ex-banner mkarm-mt ${reset.ok ? 'is-ok' : 'is-warn'}`} data-maker-reset-result>
          <div className="mkarm-strong">
            {reset.ok ? (
              <>RIPRISTINO COMPLETO — <span className="ex-n">{reset.venueOrdersAfter}</span> ordini confermati sul venue,
                esposizione aperta <span className="ex-n">{money(reset.openNotionalAfter ?? null)}</span> confermata sul
                gate cap, kill-switch disattivato alle <span className="ex-n">{new Date(reset.at).toLocaleTimeString()}</span></>
            ) : (
              <>RIPRISTINO INCOMPLETO — {dash(reset.reason || reset.error)}</>
            )}
          </div>

          {/* What was actually found and cancelled, when there was anything. */}
          {reset.cancelled && reset.cancelled.length > 0 && (
            <div className="mkarm-note">
              Residui trovati sul venue e cancellati: {reset.cancelled.map((c) => `${c.orderId.slice(0, 10)}…${c.cancelled ? ' cancellato' : c.alreadyGone ? ' già assente' : ' NON cancellato'}`).join(' · ')}
            </div>
          )}
          {reset.resolved?.ran && (reset.resolved.nofills > 0 || reset.resolved.fills > 0 || reset.resolved.stillUnknown > 0) && (
            <div className="mkarm-note">
              Riconciliazione: <span className="ex-n">{reset.resolved.fills}</span> risolti come eseguiti,{' '}
              <span className="ex-n">{reset.resolved.nofills}</span> come NON eseguiti,{' '}
              <span className="ex-n">{reset.resolved.stillUnknown}</span> ancora sconosciuti.
            </div>
          )}

          {reset.steps.map((st) => (
            <div key={st.key}>
              <div className="mkarm-step">
                <span className={st.ok ? 'ex-up' : 'ex-dn'}>{st.ok ? '✓' : '✗'}</span>
                <span>{st.label}</span>
              </div>
              {st.evidence != null && (
                <div className="mkarm-evi">{JSON.stringify(st.evidence)}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {kill && (
        <div className="mkarm-res" data-maker-kill-result>
          <div>
            Disarm (durable kill): {kill.killed ? <span className="ex-up">SET</span> : <span className="ex-dn">FAILED — {dash(kill.killError)}</span>}
          </div>
          {kill.cancelError ? (
            <div className="ex-dn">Cancel sweep error: {dash(kill.cancelError)}</div>
          ) : (
            <div>
              Cancel sweep: <span className="ex-n">{kill.cancelledTotal}</span> cancelled
              {kill.simulated ? <span className="ex-gold"> (dry-run — no cancel creds / disarmed build)</span> : <span className="ex-up"> (live)</span>}
              {kill.cancel?.map((v) => (
                <span key={v.venue}>
                  {' · '}{v.venue}: venue-open-before <span className="ex-n">{dash(v.venueOpenBefore)}</span>
                  {v.ok ? '' : <span className="ex-dn"> (FAILED: {dash(v.error)})</span>}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── PREFLIGHT: the arming gate. Real values read at click time; any red check blocks arming. ── */}
      <div className="mkarm-sec" data-maker-preflight>
        <div className="ex-sech">
          <span className="ex-sech-t">Preflight — arming gate</span>
          <div className="mkarm-inline">
            {preflight && !preflight.error && (
              <span className={`ex-badge ${preflight.go ? 'is-ok' : 'is-warn'}`}>{preflight.go ? 'GO' : 'NO-GO'}</span>
            )}
            <button className="ex-btn is-sm" onClick={runPreflight} disabled={pfRunning}>
              {pfRunning ? 'Reading real state…' : 'Run preflight'}
            </button>
          </div>
        </div>

        {preflight?.error && <div className="ex-banner is-bad">Preflight failed: {dash(preflight.error)}</div>}

        {preflight && !preflight.error && preflight.checks.length > 0 && (
          <div className="ex-panel ex-rows">
            {preflight.checks.map((c) => (
              <div key={c.key} className="ex-row">
                <div className="ex-row-main">
                  <div className="ex-row-t">
                    <span className={c.pass ? 'ex-up' : 'ex-dn'}>{c.pass ? '●' : '✕'}</span> {c.label}
                  </div>
                  {!c.pass && c.detail && <div className="ex-row-s">{c.detail}</div>}
                </div>
                <div className="ex-row-nums">
                  <span className={`ex-num-v ${c.pass ? '' : 'ex-dn'}`}>{dash(c.value)}</span>
                </div>
              </div>
            ))}
          </div>
        )}

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
        <div className="ex-sech">
          <span className="ex-sech-t">Arm control</span>
          {armStatus?.armed
            ? <span className="ex-badge is-ok">ARMED</span>
            : <span className="ex-badge is-warn">DISARMED</span>}
        </div>

        {armStatus?.armed ? (
          <div className="ex-panel mkarm-pad">
            <div className="mkarm-strong ex-up">Maker is ARMED (record only — placement still needs MAKER_MODE + funding)</div>
            <div className="ex-kvs mkarm-mt">
              <div className="ex-kv"><span className="ex-kv-k">Total size</span><span className="ex-kv-v">{money(armStatus.totalSizeUsd)}</span></div>
              <div className="ex-kv"><span className="ex-kv-k">TTL</span><span className="ex-kv-v">{armStatus.ttlSeconds != null ? `${Math.round(armStatus.ttlSeconds / 3600)}h` : '—'}</span></div>
              <div className="ex-kv"><span className="ex-kv-k">Auto-disarm</span><span className="ex-kv-v" style={{ color: countdown != null && countdown < 300 ? 'var(--ex-gold)' : 'var(--ex-green)' }}>{fmtDur(countdown)}</span></div>
            </div>
            <div className="mkarm-note">Expires <span className="ex-n">{dash(armStatus.expiresAt)}</span></div>
            <div className="mkarm-btns">
              <button className="ex-btn" onClick={doDisarm}>DISARM</button>
              <button className="ex-btn" onClick={doRenew}>RENEW (re-runs preflight)</button>
            </div>
          </div>
        ) : !armOpen ? (
          <>
            <button className="ex-btn is-gold" data-maker-arm-open onClick={() => { setArmOpen(true); loadPreview(perSide); }}>
              ARMA IL BOT…
            </button>
            <p className="mkarm-note">Step 1 of 2 — a deliberate reveal, so a stray tap cannot arm.</p>
          </>
        ) : (
          <>
            <div className="mkarm-inrow">
              <span>Size per side (USD):</span>
              <input
                className="ex-input mkarm-w140" type="number" inputMode="decimal" placeholder="e.g. 200"
                value={perSide}
                onChange={(e) => { setPerSide(e.target.value); loadPreview(e.target.value); }}
              />
            </div>

            {/* What you're about to arm — every number real or "—"; blocked if unreadable. */}
            {preview && (
              <>
                <div className="ex-panel ex-rows mkarm-mt">
                  {preview.markets.map((m) => (
                    <div key={m.marketId} className="ex-row">
                      <div className="ex-row-main">
                        <div className="ex-row-t">{m.title || m.marketId.slice(0, 10)}</div>
                        <div className="ex-row-s">{m.marketId.slice(0, 18)}…</div>
                      </div>
                      <div className="ex-row-nums">
                        <span className="ex-num"><span className="ex-num-k">bid</span><span className="ex-num-v">{price(m.bid)}</span></span>
                        <span className="ex-num"><span className="ex-num-k">ask</span><span className="ex-num-v">{price(m.ask)}</span></span>
                        <span className="ex-num"><span className="ex-num-k">size/lato</span><span className="ex-num-v">{money(m.sizePerSideUsd)}</span></span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mkarm-note">
                  Total collateral <b className="ex-n">{money(preview.totalCollateralUsd)}</b> · TTL 4h (default)
                </div>
                {!preview.readable && (
                  <p className="ex-why">{dash(preview.blockedReason)} — arming blocked.</p>
                )}
              </>
            )}

            <div className="mkarm-inrow">
              <span>Step 2 — type the total collateral to confirm{preview?.totalCollateralUsd != null ? ` (${money(preview.totalCollateralUsd)})` : ''}:</span>
              <input
                className="ex-input mkarm-w140" type="number" inputMode="decimal" placeholder="type total"
                value={typedTotal} onChange={(e) => setTypedTotal(e.target.value)}
              />
            </div>

            <div className="mkarm-btns">
              <button
                className="ex-btn is-gold"
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
              <button className="ex-btn" onClick={() => { setArmOpen(false); setTypedTotal(''); }}>Cancel</button>
            </div>
            <p className="mkarm-note">
              {preflight?.go !== true
                ? 'Run the preflight first — arming is refused while any check is red (server re-runs it fresh on ARM).'
                : 'ARM enables only when the typed total matches exactly and the preflight is GO.'}
            </p>
          </>
        )}

        {armMsg && <div className="ex-banner is-warn mkarm-mt">{dash(armMsg)}</div>}
      </div>

      <p className="mkarm-note">
        One tap disarms the maker (durable global kill) and cancels every resting order — entirely on the
        Edgeradar server, no browser call to polymarket.com. Safe even when the maker is already off.
      </p>

      {/* ── THE FIXED ACTION BAR ─────────────────────────────────────────────────────────────────────
          KILL is always enabled: stopping must never be blocked. RIPRISTINA is enabled ONLY while the
          kill is actually on — with the kill already clear there is nothing to restore, and a live green
          button would invite a pointless round of venue calls. Both stay reachable at any scroll depth. */}
      <div className="ex-actionbar-spacer" aria-hidden="true" />
      <div className="ex-actionbar" data-maker-actionbar>
        <button
          className="ex-btn is-green"
          data-maker-reset
          onClick={doReset}
          disabled={resetting || !killOn}
          title={killOn
            ? 'Cancella eventuali residui, riconcilia l\'esposizione contro il venue, disattiva il kill-switch e verifica che TUTTO sia a zero'
            : 'Disponibile solo con il kill-switch attivo: adesso non c\'è nulla da ripristinare'}
          aria-label="Ripristina: riarma e verifica che lo stato sia pulito"
        >
          {resetting ? 'VERIFICO…' : 'RIPRISTINA'}
        </button>
        <button
          className="ex-btn is-danger"
          data-maker-kill
          onClick={doKill}
          disabled={killing}
          aria-label="Kill the maker and cancel all resting orders now"
        >
          {killing ? 'KILLING…' : 'KILL — DISARM & CANCEL ALL'}
        </button>
      </div>
    </div>
  );
}

// NOTE: keep this stylesheet free of the characters React escapes in text nodes — quotes, angle brackets,
// ampersands. As the child of a style element they are serialised escaped on the server and raw on the
// client, which is a hydration mismatch that takes the whole root down to client rendering.
const CSS = `
.mkarm-root { max-width: 1080px; margin: 0 auto; padding: 12px 14px 4px; }
.mkarm-hrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mkarm-title { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
  color: var(--ex-txt-2); }
.mkarm-detail { font-size: 12px; color: var(--ex-txt-2); line-height: 1.5; margin: 6px 0 12px;
  overflow-wrap: anywhere; }
.mkarm-mt { margin-top: 12px; }
.mkarm-pad { padding: 12px; }
.mkarm-strong { font-weight: 700; font-size: 13px; line-height: 1.4; }
.mkarm-note { font-size: 11px; color: var(--ex-txt-3); line-height: 1.5; margin: 8px 0 0; overflow-wrap: anywhere; }
.mkarm-res { font-size: 12.5px; color: var(--ex-txt-2); line-height: 1.6; margin-top: 12px; overflow-wrap: anywhere; }
.mkarm-sec { margin-top: 18px; border-top: 1px solid var(--ex-line); padding-top: 4px; }
.mkarm-inline { display: flex; gap: 8px; align-items: center; }
.mkarm-btns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.mkarm-inrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 12px 0 0;
  font-size: 12.5px; color: var(--ex-txt-2); }
.mkarm-w140 { width: 140px; }
.mkarm-step { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; font-size: 12.5px; line-height: 1.45; }
.mkarm-evi { color: var(--ex-txt-3); font-family: var(--ex-mono); font-size: 10.5px;
  white-space: pre-wrap; word-break: break-word; margin: 2px 0 0 20px; }
`;
