'use client';

import { useCallback, useEffect, useState } from 'react';

// The active bot universe (public GET) + the confirmation flow to PROMOTE the browsed filters into the
// bot's operating universe (gated POST). Browsing NEVER auto-syncs — promotion is a deliberate two-step
// action. The gap between "I am looking at this" and "the bot trades this" is the safety property.

interface Resolved {
  marketIds: string[];
  markets: { marketId: string; title: string; dailyPool: number | null; venue: string | null }[];
  matchedBeforeCap: number;
  truncated: boolean;
  maxMarkets: number;
  kalshiSelected: boolean;
}
interface Selection {
  filters: Record<string, unknown>;
  venues: string[];
  allowlist: string[];
  denylist: string[];
  maxMarkets: number;
  updatedAt: string | null;
  updatedBy: string | null;
  isDefault: boolean;
}
interface UniverseResp { selection: Selection; resolved: Resolved }

const FILTER_KEYS = ['venue', 'category', 'minPool', 'minDepth', 'maxSpread', 'maxCompetition', 'hideThin'] as const;

function filterRows(f: Record<string, unknown>): [string, string][] {
  const g = (k: string) => {
    const v = (f || {})[k];
    return v == null || v === '' ? null : String(v);
  };
  return [
    ['Piattaforma', g('venue') || 'tutte'],
    ['Categoria', g('category') || 'qualsiasi'],
    ['Paga almeno', g('minPool') ? `$${g('minPool')}/giorno` : 'qualsiasi'],
    ['Libro almeno', g('minDepth') ? `$${g('minDepth')}` : 'qualsiasi'],
    ['Spread max', g('maxSpread') ? `${g('maxSpread')}¢` : 'qualsiasi'],
    ['Concorrenza max', g('maxCompetition') ? `${g('maxCompetition')}%` : 'qualsiasi'],
    ['Nascondi sottili', g('hideThin') === '1' || g('hideThin') === 'true' ? 'sì' : 'no'],
  ];
}

function paramsToObj(qs: string): Record<string, string> {
  const o: Record<string, string> = {};
  new URLSearchParams(qs).forEach((v, k) => { o[k] = v; });
  return o;
}
function normQs(obj: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    const v = (obj || {})[k];
    if (v != null && v !== '') p.set(k, String(v));
  }
  p.sort();
  return p.toString();
}

// Statements of FACT about what the numbers mean. Always shown, never a tooltip, never dismissible.
function Disclosures({ kalshi }: { kalshi: boolean }) {
  return (
    <div className="bu-disc">
      <p>Le cifre sono <strong>maturato lordo</strong> — il tasso del montepremi dichiarato dal programma, non il profitto netto.</p>
      <p><strong>Il P&amp;L di inventario quando i tuoi ordini vengono eseguiti non è incluso</strong> in nessuna cifra di questa pagina.</p>
      {kalshi && (
        <p>Un mercato selezionato è su <strong>Kalshi</strong>: il programma di incentivi è riservato ai membri residenti negli Stati Uniti, quindi quei premi potrebbero non essere riscuotibili da questo operatore.</p>
      )}
    </div>
  );
}

export default function MakerUniverseControl({ apiQuery }: { apiQuery: string }) {
  const [active, setActive] = useState<UniverseResp | null>(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<UniverseResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadActive = useCallback(async () => {
    try {
      const r = await fetch('/api/maker/universe', { cache: 'no-store' });
      if (r.ok) setActive(await r.json());
    } catch { /* leave prior */ }
  }, []);
  useEffect(() => { loadActive(); }, [loadActive]);

  const maxHint = active?.selection?.maxMarkets ?? 5;

  const openPanel = useCallback(async () => {
    setMsg(null);
    try {
      const r = await fetch(`/api/maker/universe?preview=1&${apiQuery}${apiQuery ? '&' : ''}maxMarkets=${maxHint}`, { cache: 'no-store' });
      if (r.ok) { setPreview(await r.json()); setOpen(true); }
      else setMsg({ ok: false, text: 'Impossibile calcolare l’anteprima.' });
    } catch { setMsg({ ok: false, text: 'Impossibile calcolare l’anteprima.' }); }
  }, [apiQuery, maxHint]);

  const confirm = useCallback(async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/maker/universe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters: paramsToObj(apiQuery), venues: ['polymarket'], maxMarkets: maxHint }),
      });
      if (r.status === 401) setMsg({ ok: false, text: 'Serve l’accesso admin per cambiare l’universo del bot — /settings/login.' });
      else if (!r.ok) { const d = await r.json().catch(() => ({})); setMsg({ ok: false, text: d.error || 'Impossibile impostare l’universo del bot.' }); }
      else { setMsg({ ok: true, text: 'Universo del bot aggiornato.' }); setOpen(false); await loadActive(); }
    } catch { setMsg({ ok: false, text: 'Impossibile impostare l’universo del bot.' }); }
    finally { setBusy(false); }
  }, [apiQuery, maxHint, loadActive]);

  const browsedQs = normQs(paramsToObj(apiQuery));
  const activeQs = active ? normQs(active.selection.filters) : '';
  const differs = !!active && browsedQs !== activeQs;

  const ar = active?.resolved;
  const pr = preview?.resolved;

  return (
    <div className="bu-root">
      <style>{`
        .bu-root { border: 1px solid var(--ds-line,#262C39); border-radius: 12px; margin: 14px 0; overflow: hidden;
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
        .bu-head { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;
          padding: 12px 14px; background: var(--ds-surface,#141922); border-bottom:1px solid var(--ds-line,#262C39); }
        .bu-title { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.6px; color: var(--ds-muted,#8B95A5); }
        .bu-btn { min-height:44px; padding:0 16px; border:none; border-radius:10px; background:#0FBE82; color:#062; font-weight:800;
          font-size:14px; cursor:pointer; white-space:nowrap; touch-action:manipulation; color:#053626; }
        .bu-btn:hover { background:#0A9D6B; }
        .bu-btn:focus-visible { outline:3px solid #0FBE82; outline-offset:2px; }
        .bu-body { padding: 12px 14px; }
        .bu-grid { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:8px 18px; }
        .bu-kv { display:flex; justify-content:space-between; gap:10px; font-size:13px; border-bottom:1px dotted var(--ds-line,#222); padding:3px 0; }
        .bu-k { color: var(--ds-muted,#8B95A5); } .bu-v { font-weight:700; white-space:nowrap; }
        .bu-count { font-size:15px; font-weight:800; margin:8px 0 2px; white-space:nowrap; }
        .bu-sub { font-size:12px; color: var(--ds-muted,#8B95A5); }
        .bu-diff { margin-top:10px; font-size:12.5px; color: var(--ds-muted,#7C8698); }
        .bu-names { margin:8px 0 0; padding-left:0; list-style:none; }
        .bu-names li { font-size:13px; padding:3px 0; border-bottom:1px solid var(--ds-line,#1c222e); display:flex; justify-content:space-between; gap:10px; }
        .bu-names .p { color: var(--ds-muted,#8B95A5); white-space:nowrap; }
        .bu-panel { margin-top:12px; border:1px solid #0FBE82; border-radius:10px; padding:12px 14px; background: var(--ds-surface,#10151d); }
        .bu-panel h4 { margin:0 0 8px; font-size:14px; font-weight:800; }
        .bu-replaced { margin-top:10px; padding-top:8px; border-top:1px dashed var(--ds-line,#333); font-size:12.5px; color: var(--ds-muted,#8B95A5); }
        .bu-actions { display:flex; gap:10px; margin-top:12px; flex-wrap:wrap; }
        .bu-confirm { min-height:44px; padding:0 18px; border:none; border-radius:10px; background:#0FBE82; color:#053626; font-weight:800; cursor:pointer; }
        .bu-cancel { min-height:44px; padding:0 16px; border:1px solid var(--ds-line,#3A4150); border-radius:10px; background:transparent; color:inherit; cursor:pointer; }
        .bu-disc { margin-top:10px; padding:10px 12px; border-radius:8px; background: var(--ds-surface,#0f141b); border:1px solid var(--ds-line,#262C39); }
        .bu-disc p { margin:0 0 6px; font-size:12px; line-height:1.45; color: var(--ds-muted,#9aa4b2); } .bu-disc p:last-child { margin-bottom:0; }
        .bu-disc strong { color: inherit; font-weight:800; }
        .bu-msg-ok { color:#0A9D6B; font-size:13px; margin-top:8px; } .bu-msg-err { color:#E5564E; font-size:13px; margin-top:8px; }
        @media (max-width:760px){ .bu-grid{ grid-template-columns:1fr; } .bu-head{ flex-direction:column; align-items:stretch; } .bu-btn{ width:100%; } }
      `}</style>

      {/* ── ALWAYS-VISIBLE ACTIVE UNIVERSE ── */}
      <div className="bu-head">
        <span className="bu-title">Universo del bot · cosa quota agent35</span>
        <button className="bu-btn" onClick={openPanel} aria-label="Imposta come universo del bot">Imposta come universo del bot</button>
      </div>
      <div className="bu-body">
        {!active ? (
          <div className="bu-sub">Carico l’universo attuale del bot…</div>
        ) : (
          <>
            <div className="bu-count">
              {ar ? `${ar.marketIds.length} mercat${ar.marketIds.length === 1 ? 'o' : 'i'}` : '—'}
              {ar?.truncated ? <span className="bu-sub"> · primi {ar.maxMarkets} di {ar.matchedBeforeCap} per montepremi</span> : null}
            </div>
            <div className="bu-sub" style={{ marginBottom: 8 }}>
              {active.selection.isDefault
                ? 'Predefinito (mai impostato): solo Polymarket, nessun vincolo, massimo 5.'
                : `Impostato ${active.selection.updatedAt ? new Date(active.selection.updatedAt).toLocaleString() : ''}`}
            </div>
            <div className="bu-grid">
              {filterRows(active.selection.filters).map(([k, v]) => (
                <div className="bu-kv" key={k}><span className="bu-k">{k}</span><span className="bu-v">{v}</span></div>
              ))}
            </div>
            {differs && (
              <div className="bu-diff">I tuoi filtri di navigazione sono diversi dall&rsquo;universo attivo del bot. Navigare non cambia cosa quota il bot — usa &laquo;Imposta come universo del bot&raquo; per promuoverli.</div>
            )}
            <Disclosures kalshi={!!ar?.kalshiSelected} />
          </>
        )}

        {/* ── CONFIRMATION PANEL ── */}
        {open && preview && (
          <div className="bu-panel">
            <h4>Impostare l&rsquo;universo del bot su questi filtri?</h4>
            <div className="bu-grid">
              {filterRows(preview.selection.filters).map(([k, v]) => (
                <div className="bu-kv" key={k}><span className="bu-k">{k}</span><span className="bu-v">{v}</span></div>
              ))}
            </div>
            <div className="bu-count" style={{ marginTop: 10 }}>
              {pr ? `${pr.marketIds.length} mercat${pr.marketIds.length === 1 ? 'o verrà quotato' : 'i verranno quotati'}` : '—'}
              {pr?.truncated ? <span className="bu-sub"> · limitato a {pr.maxMarkets} di {pr.matchedBeforeCap} per montepremi</span> : null}
            </div>
            {pr && pr.markets.length > 0 && (
              <ul className="bu-names">
                {pr.markets.map((m) => (
                  <li key={m.marketId}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</span>
                    <span className="p">{m.dailyPool != null ? `$${m.dailyPool}/giorno` : '—'}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="bu-replaced">
              Sostituisce: {active?.selection.isDefault
                ? 'il predefinito (solo Polymarket, nessun vincolo, massimo 5).'
                : `la selezione impostata ${active?.selection.updatedAt ? new Date(active.selection.updatedAt).toLocaleString() : ''} (${filterRows(active?.selection.filters || {}).map(([k, v]) => `${k} ${v}`).join(' · ')}).`}
            </div>
            <Disclosures kalshi={!!pr?.kalshiSelected} />
            <div className="bu-actions">
              <button className="bu-confirm" disabled={busy} onClick={confirm}>{busy ? 'Imposto…' : 'Conferma — imposta universo'}</button>
              <button className="bu-cancel" disabled={busy} onClick={() => { setOpen(false); setMsg(null); }}>Annulla</button>
            </div>
          </div>
        )}
        {msg && <div className={msg.ok ? 'bu-msg-ok' : 'bu-msg-err'}>{msg.text}</div>}
      </div>
    </div>
  );
}
