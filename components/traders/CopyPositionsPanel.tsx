'use client';

// CopyPositionsPanel — two clearly-separated lanes on a trader's profile:
//   1. COPIED positions (engine-owned, agent21 paper engine) — with an always-available
//      manual override: "Partial close…" (percent slider) + "Close all". The remaining
//      size stays engine-managed after a partial close (no re-arm).
//   2. MANUAL positions (dashed, visually distinct) — a lane the copy engine NEVER reads or
//      touches (physically separate table). Add / partial-close / remove here are independent.
//
// Every number is null-safe (fmt* → "—", never "NaN"/"null"/"$0"). Mobile-first: single
// column under ~760px, min-w-0 text containers, tabular numbers with nowrap, ≥44px targets.

import { useCallback, useEffect, useState } from 'react';
import { fmtPrice, fmtSize, fmtPnl, fmtUpdated } from './format';
import CollectionStoppedNote from '@/app/components/CollectionStoppedNote';

const ACCENT = '#0c9d6e';

interface CopiedPos {
  id: string; cid: string | null; market: string; outcome: string; category?: string;
  shares: number | null; entryAvg: number | null; openedAt?: number | null;
  pendingClosePct: number | null; updatedAt: string | null;
}
interface CopyConfigView { walletAddr: string; exitMode: string; pctPerOrder: number; positions: CopiedPos[] }
interface ManualPos {
  id: string; traderId: string; market: string; conditionId: string | null; outcome: string;
  side: string; entryPrice: number | null; size: number | null; status: string; closedPct: number;
  createdAt: string;
}

export default function CopyPositionsPanel({ address }: { address: string }) {
  const [copied, setCopied]   = useState<CopiedPos[] | null>(null);
  const [copyAuth, setCopyAuth] = useState<boolean>(true);
  const [manual, setManual]   = useState<ManualPos[] | null>(null);
  const [manualAuth, setManualAuth] = useState<boolean>(true);
  const [busy, setBusy]       = useState<string | null>(null);
  const [msg, setMsg]         = useState<string | null>(null);
  const [copyStale, setCopyStale] = useState<boolean>(false);       // top-level stopped flag from /api/copy/paper
  const [copyUpdatedAt, setCopyUpdatedAt] = useState<string | null>(null);

  const loadCopied = useCallback(async () => {
    try {
      const r = await fetch('/api/copy/paper', { cache: 'no-store' });
      if (r.status === 401) { setCopyAuth(false); setCopied([]); return; }
      setCopyAuth(true);
      const d = await r.json();
      setCopyStale(!!d.stale);
      setCopyUpdatedAt(d.updatedAt ?? null);
      const wl = address.toLowerCase();
      const mine = (d.configs ?? []) as CopyConfigView[];
      // Only positions copied from THIS trader's wallet.
      const rows = mine.filter(c => (c.walletAddr ?? '').toLowerCase() === wl).flatMap(c => c.positions ?? []);
      setCopied(rows);
    } catch { setCopied([]); }
  }, [address]);

  const loadManual = useCallback(async () => {
    try {
      const r = await fetch(`/api/traders/manual-positions?traderId=${encodeURIComponent(address)}`, { cache: 'no-store' });
      if (r.status === 401) { setManualAuth(false); setManual([]); return; }
      setManualAuth(true);
      const d = await r.json();
      setManual((d.positions ?? []) as ManualPos[]);
    } catch { setManual([]); }
  }, [address]);

  useEffect(() => { loadCopied(); loadManual(); }, [loadCopied, loadManual]);

  // ── copy-engine override close ──
  async function closeCopied(positionId: string, closePercent: number) {
    setBusy(positionId); setMsg(null);
    try {
      const r = await fetch('/api/copy/close', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId, closePercent }),
      });
      const d = await r.json();
      if (!r.ok) { setMsg(d.error ?? 'close failed'); return; }
      setMsg(d.note ?? 'Close queued.');
      await loadCopied();  // reflects pendingClosePct overlay immediately
    } catch { setMsg('network error'); } finally { setBusy(null); }
  }

  return (
    <div className="mt-5 space-y-5">
      {/* ── COPIED (engine-owned) ── */}
      <section className="rounded-xl border border-line bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-line flex items-center justify-between gap-2 flex-wrap">
          <div className="min-w-0">
            <h3 className="font-display font-bold text-ink text-[15px]">Copied positions</h3>
            <p className="font-body text-[11px] text-muted mt-0.5">Managed by the copy engine (paper). Auto-closes when the trader exits — you can override any time.</p>
          </div>
          <span className="shrink-0 font-body text-[10px] uppercase tracking-wide px-2 py-1 rounded-md" style={{ color: ACCENT, background: 'rgba(12,157,110,.10)' }}>engine-owned</span>
        </div>

        {copyStale && (
          <div className="px-4 pt-3">
            <CollectionStoppedNote asOf={copyUpdatedAt} />
          </div>
        )}

        {!copyAuth ? (
          <Empty>Sign in to see and manage your copied positions from this trader.</Empty>
        ) : copied == null ? (
          <Empty>Loading…</Empty>
        ) : copied.length === 0 ? (
          <Empty>No copied positions from this trader yet. Copies appear here once the engine mirrors a fill.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {copied.map(p => (
              <CopiedRow key={p.id} p={p} busy={busy === p.id} onClose={closeCopied} />
            ))}
          </ul>
        )}
        {msg && <p className="px-4 py-2 font-body text-[11px] text-muted border-t border-line">{msg}</p>}
      </section>

      {/* ── MANUAL (isolated lane) ── */}
      <ManualBlock
        address={address} manual={manual} manualAuth={manualAuth}
        onChanged={loadManual}
      />
    </div>
  );
}

function CopiedRow({ p, busy, onClose }: { p: CopiedPos; busy: boolean; onClose: (id: string, pct: number) => void }) {
  const [showSlider, setShowSlider] = useState(false);
  const [pct, setPct] = useState(50);
  const pending = p.pendingClosePct != null;
  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-body text-[13px] text-ink font-medium truncate">{p.market || '—'}</p>
          <p className="font-body text-[11px] text-muted mt-0.5">
            <span className="uppercase">{p.outcome || '—'}</span>
            {p.category ? <span> · {p.category}</span> : null}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="font-mono text-[13px] text-ink tabular-nums whitespace-nowrap">{fmtSize(p.shares)} sh</p>
          <p className="font-mono text-[11px] text-muted tabular-nums whitespace-nowrap">@ {fmtPrice(p.entryAvg)}</p>
        </div>
      </div>

      <div className="mt-1 flex items-center justify-between gap-2 flex-wrap">
        <span className="font-body text-[10px] text-faint whitespace-nowrap">synced {fmtUpdated(p.updatedAt)}</span>
        {pending && (
          <span className="font-body text-[10px] px-1.5 py-0.5 rounded" style={{ color: '#b7791f', background: 'rgba(214,158,46,.12)' }}>
            closing {p.pendingClosePct}% — applies next sync
          </span>
        )}
      </div>

      {showSlider ? (
        <div className="mt-2 rounded-lg border border-line bg-bg/40 px-3 py-2">
          <div className="flex items-center justify-between font-body text-[11px] text-muted">
            <span>Partial close</span>
            <span className="font-mono tabular-nums text-ink">{pct}%</span>
          </div>
          <input type="range" min={1} max={99} value={pct} onChange={e => setPct(Number(e.target.value))}
            className="w-full mt-1" style={{ accentColor: ACCENT }} aria-label="close percent" />
          <div className="mt-2 flex items-center gap-2">
            <button disabled={busy} onClick={() => { onClose(p.id, pct); setShowSlider(false); }}
              className="min-h-[44px] flex-1 rounded-lg font-body text-[13px] font-semibold text-white disabled:opacity-50"
              style={{ background: ACCENT }}>
              {busy ? '…' : `Close ${pct}%`}
            </button>
            <button onClick={() => setShowSlider(false)}
              className="min-h-[44px] px-3 rounded-lg font-body text-[13px] text-muted border border-line">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <button disabled={busy} onClick={() => setShowSlider(true)}
            className="min-h-[44px] flex-1 rounded-lg font-body text-[12px] font-medium text-ink border border-line hover:bg-bg/50 disabled:opacity-50">
            Partial close…
          </button>
          <button disabled={busy} onClick={() => onClose(p.id, 100)}
            className="min-h-[44px] flex-1 rounded-lg font-body text-[12px] font-semibold text-white disabled:opacity-50"
            style={{ background: ACCENT }}>
            {busy ? '…' : 'Close all'}
          </button>
        </div>
      )}
    </li>
  );
}

// ── Manual lane (isolated) ──
function ManualBlock({ address, manual, manualAuth, onChanged }: {
  address: string; manual: ManualPos[] | null; manualAuth: boolean; onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ market: '', outcome: 'Yes', side: 'BUY', entryPrice: '', size: '' });

  async function add() {
    setBusy(true); setErr(null);
    const entryPrice = Number(form.entryPrice), size = Number(form.size);
    if (!form.market.trim()) { setErr('Market required'); setBusy(false); return; }
    if (!(entryPrice > 0 && entryPrice < 1)) { setErr('Entry price must be between 0 and 1'); setBusy(false); return; }
    if (!(size > 0)) { setErr('Size must be > 0'); setBusy(false); return; }
    try {
      const r = await fetch('/api/traders/manual-positions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ traderId: address, market: form.market.trim(), outcome: form.outcome.trim() || '—', side: form.side, entryPrice, size }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(d.error ?? 'add failed'); return; }
      setForm({ market: '', outcome: 'Yes', side: 'BUY', entryPrice: '', size: '' });
      setAdding(false); onChanged();
    } catch { setErr('network error'); } finally { setBusy(false); }
  }

  async function closeManual(id: string, closePercent: number) {
    setBusy(true);
    try {
      await fetch('/api/traders/manual-positions', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, closePercent }),
      });
      onChanged();
    } finally { setBusy(false); }
  }
  async function removeManual(id: string) {
    setBusy(true);
    try { await fetch(`/api/traders/manual-positions?id=${encodeURIComponent(id)}`, { method: 'DELETE' }); onChanged(); }
    finally { setBusy(false); }
  }

  return (
    <section className="rounded-xl border border-dashed border-line bg-surface/60 overflow-hidden">
      <div className="px-4 py-3 border-b border-dashed border-line flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h3 className="font-display font-bold text-ink text-[15px] flex items-center gap-2">
            Manual positions
            <span className="font-body text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-line text-muted">manual add</span>
          </h3>
          <p className="font-body text-[11px] text-muted mt-0.5">Your own entries. This lane is <span className="text-ink font-medium">never read or touched by the copy engine</span> — separate storage.</p>
        </div>
        <button onClick={() => setAdding(a => !a)} className="shrink-0 min-h-[44px] px-3 rounded-lg font-body text-[12px] font-medium border border-line text-ink hover:bg-bg/50">
          + Add manual position
        </button>
      </div>

      {!manualAuth ? (
        <Empty>Sign in to add and manage manual positions.</Empty>
      ) : (
        <>
          {adding && (
            <div className="px-4 py-3 border-b border-dashed border-line grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input value={form.market} onChange={e => setForm(f => ({ ...f, market: e.target.value }))} placeholder="Market / question"
                className="sm:col-span-2 min-h-[44px] rounded-lg border border-line bg-bg/40 px-3 font-body text-[13px] text-ink min-w-0" />
              <input value={form.outcome} onChange={e => setForm(f => ({ ...f, outcome: e.target.value }))} placeholder="Outcome (e.g. Yes)"
                className="min-h-[44px] rounded-lg border border-line bg-bg/40 px-3 font-body text-[13px] text-ink min-w-0" />
              <select value={form.side} onChange={e => setForm(f => ({ ...f, side: e.target.value }))}
                className="min-h-[44px] rounded-lg border border-line bg-bg/40 px-3 font-body text-[13px] text-ink min-w-0">
                <option value="BUY">BUY</option><option value="SELL">SELL</option>
              </select>
              <input value={form.entryPrice} onChange={e => setForm(f => ({ ...f, entryPrice: e.target.value }))} placeholder="Entry price (0–1)" inputMode="decimal"
                className="min-h-[44px] rounded-lg border border-line bg-bg/40 px-3 font-body text-[13px] text-ink tabular-nums min-w-0" />
              <input value={form.size} onChange={e => setForm(f => ({ ...f, size: e.target.value }))} placeholder="Size (shares)" inputMode="decimal"
                className="min-h-[44px] rounded-lg border border-line bg-bg/40 px-3 font-body text-[13px] text-ink tabular-nums min-w-0" />
              <div className="sm:col-span-2 flex items-center gap-2">
                <button disabled={busy} onClick={add} className="min-h-[44px] flex-1 rounded-lg font-body text-[13px] font-semibold text-white disabled:opacity-50" style={{ background: ACCENT }}>
                  {busy ? '…' : 'Add'}
                </button>
                {err && <span className="font-body text-[11px] text-red-500">{err}</span>}
              </div>
            </div>
          )}

          {manual == null ? <Empty>Loading…</Empty>
            : manual.length === 0 ? <Empty>No manual positions on this trader yet.</Empty>
            : (
              <ul className="divide-y divide-line">
                {manual.map(m => (
                  <li key={m.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-body text-[13px] text-ink font-medium truncate">{m.market || '—'}</p>
                        <p className="font-body text-[11px] text-muted mt-0.5">
                          <span className="uppercase">{m.side}</span> <span className="uppercase">{m.outcome || '—'}</span>
                          {m.status === 'closed' ? <span className="ml-1 text-faint">· closed</span> : m.closedPct > 0 ? <span className="ml-1 text-faint">· {m.closedPct}% closed</span> : null}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-mono text-[13px] text-ink tabular-nums whitespace-nowrap">{fmtSize(m.size)} sh</p>
                        <p className="font-mono text-[11px] text-muted tabular-nums whitespace-nowrap">@ {fmtPrice(m.entryPrice)}</p>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <button disabled={busy || m.status === 'closed'} onClick={() => closeManual(m.id, 50)}
                        className="min-h-[44px] flex-1 rounded-lg font-body text-[12px] text-ink border border-line hover:bg-bg/50 disabled:opacity-40">Close 50%</button>
                      <button disabled={busy || m.status === 'closed'} onClick={() => closeManual(m.id, 100)}
                        className="min-h-[44px] flex-1 rounded-lg font-body text-[12px] font-semibold text-white disabled:opacity-40" style={{ background: ACCENT }}>Close all</button>
                      <button disabled={busy} onClick={() => removeManual(m.id)}
                        className="min-h-[44px] px-3 rounded-lg font-body text-[12px] text-muted border border-line" aria-label="remove">✕</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </>
      )}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-8 text-center text-muted font-body text-[13px]">{children}</div>;
}
