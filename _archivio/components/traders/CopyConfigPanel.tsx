'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { X, Check, Lock, Shield, Loader2 } from 'lucide-react';
import { Redacted } from '@/app/components/ui/Redacted';
import { AUTO_EXECUTE_ENABLED } from '@/lib/flags';
import { fmtSize, fmtPnl, fmtWallet, pnlColor, catText, type OpenPosition, type ClosedTrade } from './format';
import { WinRate } from './parts';

// ── Copy-config panel ─────────────────────────────────────────────────────────
// Opens from a trader's COPY button (leaderboard row + detail page). Wires to
// real data only: category chips are DATA-DERIVED from the trader's actual
// positions/closed trades; the mirror list uses their real open positions.
// Dollar figures come from the real (redactable) currentValue — never fabricated;
// share counts are public. Paper-only: live execution stays OFF while
// AUTO_EXECUTE_ENABLED=false. Persists via /api/copy/config (server-side slots).

interface SavedConfig {
  walletAddr: string; categories: string[]; pctPerOrder: number;
  maxOpenPositions: number; exitMode: string; tpPct: number | null; slPct: number | null; mode: string;
}

// Display-order hint only — NOT a filter. sortCats appends any category not
// listed here (unknown index → sorted last), so every data-derived category the
// trader actually holds still renders. Mirrors lib/category.js CATEGORY_ORDER.
const CAT_ORDER = ['Politics','Elections','Mentions','Crypto','Sports','Economy','Financials','Business','Tech','Pop Culture','World','Weather','Health','other'];
function sortCats(cats: string[]): string[] {
  return [...cats].sort((a, b) => {
    const ia = CAT_ORDER.indexOf(a), ib = CAT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

export default function CopyConfigPanel({
  wallet, name, tier, pnlUsdc, winRate, wilsonScore, resolvedMarkets,
  positionsOpen: preOpen, tradesClosed: preClosed, onClose, onSaved,
}: {
  wallet:        string;
  name:          string;
  tier:          'free' | 'pro';
  pnlUsdc?:        number | null;   // all-time resolved P&L (redacted → null for free)
  winRate?:        number | null;
  wilsonScore?:    number | null;
  resolvedMarkets?: number;         // sample size
  positionsOpen?: OpenPosition[] | null;   // preloaded (detail page); else fetched
  tradesClosed?:  ClosedTrade[]  | null;
  onClose:       () => void;
  onSaved:       () => void;                // parent refreshes server slot state
}) {
  const [positions, setPositions] = useState<OpenPosition[]>(preOpen ?? []);
  const [closed, setClosed]       = useState<ClosedTrade[]>(preClosed ?? []);
  const [loading, setLoading]     = useState(!preOpen);
  const [slots, setSlots]         = useState<{ used: number; limit: number } | null>(null);

  // Config state
  const [selected, setSelected]   = useState<Set<string>>(new Set());
  const [pct, setPct]             = useState(5);
  const [maxOpen, setMaxOpen]     = useState(5);
  const [exitMode, setExitMode]   = useState<'mirror' | 'tpsl'>('mirror');
  const [tp, setTp]               = useState(30);
  const [sl, setSl]               = useState(20);

  const [saving, setSaving]       = useState(false);
  const [saved, setSavedFlag]     = useState(false);
  const [err, setErr]             = useState('');
  const [needAuth, setNeedAuth]   = useState(false);
  const [hasExisting, setHasExisting] = useState(false);

  // Fetch trader profile if positions weren't preloaded (leaderboard row path).
  useEffect(() => {
    if (preOpen) return;
    let live = true;
    (async () => {
      try {
        const r = await fetch(`/api/leaderboard/profile/${wallet.toLowerCase()}`);
        const d = await r.json();
        if (!live) return;
        setPositions(d.profile?.positionsOpen ?? []);
        setClosed(d.profile?.tradesClosed ?? []);
      } catch { /* leave empty — no fabrication */ }
      finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
  }, [wallet, preOpen]);

  // Load server slot state + any existing config for this wallet (prefill).
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch('/api/copy/config');
        if (r.status === 401) { if (live) setSlots(null); return; }
        const d = await r.json();
        if (!live) return;
        setSlots(d.slots ?? null);
        const existing: SavedConfig | undefined = (d.configs ?? []).find(
          (c: SavedConfig) => c.walletAddr.toLowerCase() === wallet.toLowerCase());
        if (existing) {
          setHasExisting(true);
          setSelected(new Set(existing.categories));
          setPct(existing.pctPerOrder);
          setMaxOpen(existing.maxOpenPositions);
          setExitMode(existing.exitMode === 'tpsl' ? 'tpsl' : 'mirror');
          if (existing.tpPct != null) setTp(existing.tpPct);
          if (existing.slPct != null) setSl(existing.slPct);
        }
      } catch { /* stays null → treated as free/unauth */ }
    })();
    return () => { live = false; };
  }, [wallet]);

  // DATA-DERIVED category chips: distinct categories across the trader's real
  // open positions + closed trades. Never a hardcoded list.
  const traderCats = useMemo(() => {
    const s = new Set<string>();
    for (const p of positions) if (p.category) s.add(p.category);
    for (const t of closed)    if (t.category) s.add(t.category);
    return sortCats(Array.from(s));
  }, [positions, closed]);

  // Default selection once cats are known and nothing chosen yet: crypto if the
  // trader has it, else leave empty (empty = all categories, no filter).
  const [defaulted, setDefaulted] = useState(false);
  useEffect(() => {
    if (defaulted || traderCats.length === 0) return;
    if (selected.size === 0 && traderCats.includes('Crypto')) setSelected(new Set(['Crypto']));
    setDefaulted(true);
  }, [traderCats, defaulted, selected.size]);

  const toggleCat = useCallback((c: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(c) ? next.delete(c) : next.add(c);
      return next;
    });
  }, []);

  // Mirror list: real open positions, filtered by selected categories (empty =
  // all), biggest first, capped at maxOpen. Real numbers only.
  const shown = useMemo(() => {
    const filtered = selected.size === 0
      ? positions
      : positions.filter(p => selected.has(p.category || 'other'));
    return [...filtered]
      .sort((a, b) => (b.currentValue ?? b.size ?? 0) - (a.currentValue ?? a.size ?? 0))
      .slice(0, maxOpen);
  }, [positions, selected, maxOpen]);

  const hasValue   = shown.some(p => p.currentValue != null);
  const totalTheir = hasValue ? shown.reduce((s, p) => s + (p.currentValue ?? 0), 0) : null;
  const totalYours = totalTheir != null ? totalTheir * pct / 100 : null;

  async function save() {
    setSaving(true); setErr(''); setNeedAuth(false);
    try {
      const r = await fetch('/api/copy/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddr: wallet,
          categories: Array.from(selected),
          pctPerOrder: pct,
          maxOpenPositions: maxOpen,
          exitMode,
          ...(exitMode === 'tpsl' ? { tpPct: tp, slPct: sl } : {}),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 401) { setNeedAuth(true); return; }
      if (!r.ok) { setErr(d.error || 'Could not save the configuration.'); if (d.slots) setSlots(d.slots); return; }
      if (d.slots) setSlots(d.slots);
      setSavedFlag(true);
      onSaved();
      setTimeout(onClose, 900);
    } catch (e: any) {
      setErr(e.message || 'Network error.');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true); setErr('');
    try {
      const r = await fetch(`/api/copy/config?walletAddr=${wallet}`, { method: 'DELETE' });
      if (r.status === 401) { setNeedAuth(true); return; }
      const d = await r.json().catch(() => ({}));
      if (d.slots) setSlots(d.slots);
      onSaved();
      onClose();
    } catch (e: any) {
      setErr(e.message || 'Network error.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 backdrop-blur-sm p-4"
      role="dialog" aria-modal="true"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-[460px] max-h-[90vh] overflow-y-auto rounded-card border border-line bg-surface shadow-card">
        {/* Header — name, address, all-time resolved P&L, win rate + sample */}
        <div className="sticky top-0 z-10 px-4 py-3 border-b border-line bg-surface">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-body text-[10px] uppercase tracking-widest text-muted">Copy · paper</div>
              <div className="font-display font-bold text-base text-ink truncate">{name}</div>
              <div className="font-body text-[10px] text-muted tabular-nums mt-0.5">{fmtWallet(wallet)}</div>
            </div>
            <button onClick={onClose} className="shrink-0 p-1 rounded-button text-muted hover:text-ink hover:bg-bg-soft transition-colors" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center gap-4 mt-2">
            <div>
              <div className="font-body text-[9px] uppercase tracking-wide text-muted">Resolved P&amp;L</div>
              <div className={`font-display font-bold text-sm tabular-nums leading-tight ${pnlColor(pnlUsdc)}`}>
                <Redacted value={pnlUsdc}>{v => fmtPnl(v)}</Redacted>
              </div>
            </div>
            <div className="min-w-0">
              <div className="font-body text-[9px] uppercase tracking-wide text-muted">Win rate · sample</div>
              <WinRate winRate={winRate ?? null} wilson={wilsonScore ?? null} resolvedMarkets={resolvedMarkets ?? 0} />
            </div>
          </div>
        </div>

        <div className="px-4 py-4 flex flex-col gap-5">
          {/* Honest banner — past track record is not a guarantee */}
          <div className="rounded-card border border-gold/25 bg-gold-tint/60 px-3 py-2 font-body text-[10px] text-ink-2 leading-relaxed">
            Past track record — not a guarantee of future results.
          </div>

          {/* Slot indicator */}
          <div className="flex items-center justify-between font-body text-[11px]">
            <span className="text-muted">Copy slots</span>
            {slots
              ? <span className="text-ink-2 tabular-nums">{slots.used}/{slots.limit} used{tier === 'pro' ? ' · Pro' : ''}</span>
              : <span className="text-muted">sign in to manage slots</span>}
          </div>

          {/* Category chips — DATA-DERIVED */}
          <div>
            <div className="font-body text-[10px] uppercase tracking-wide text-muted mb-2">
              Categories to copy {selected.size === 0 && <span className="normal-case tracking-normal">· none = all</span>}
            </div>
            {traderCats.length === 0 ? (
              <div className="font-body text-[11px] text-muted">
                {loading ? 'Loading trader’s categories…' : 'No real categories available for this trader.'}
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {traderCats.map(c => {
                  const on = selected.has(c);
                  return (
                    <button key={c} onClick={() => toggleCat(c)}
                      className={[
                        'font-body text-[11px] px-2.5 py-1 rounded-button border transition-colors',
                        on ? 'border-mint-deep/50 bg-mint-tint text-mint-deep font-medium'
                           : `border-line bg-surface hover:border-mint-deep/30 ${catText(c)}`,
                      ].join(' ')}>
                      {on && <Check className="inline w-2.5 h-2.5 mr-1 -mt-0.5" strokeWidth={3} />}{c}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* % per order */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-body text-[10px] uppercase tracking-wide text-muted">% of each of their orders</span>
              <span className="font-display font-bold text-sm text-mint-deep tabular-nums">{pct}%</span>
            </div>
            <input type="range" min={1} max={25} step={1} value={pct}
              onChange={e => setPct(Number(e.target.value))}
              className="w-full accent-[#0c9d6e]" />
            <div className="font-body text-[11px] text-muted mt-1">
              them <span className="text-ink-2 tabular-nums">$1,000</span> → you <span className="text-mint-deep tabular-nums font-medium">${(1000 * pct / 100).toFixed(0)}</span>
            </div>
          </div>

          {/* Max open */}
          <div className="flex items-center justify-between">
            <span className="font-body text-[10px] uppercase tracking-wide text-muted">Max orders open at once</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setMaxOpen(m => Math.max(1, m - 1))}
                className="w-7 h-7 rounded-button border border-line text-ink-2 hover:bg-bg-soft font-body">−</button>
              <span className="font-display font-bold text-sm text-ink tabular-nums w-6 text-center">{maxOpen}</span>
              <button onClick={() => setMaxOpen(m => Math.min(8, m + 1))}
                className="w-7 h-7 rounded-button border border-line text-ink-2 hover:bg-bg-soft font-body">+</button>
            </div>
          </div>

          {/* Exit mode */}
          <div>
            <div className="font-body text-[10px] uppercase tracking-wide text-muted mb-2">Exit</div>
            <div className="flex gap-1.5">
              {([['mirror', 'Exit with them'], ['tpsl', 'My own exit']] as const).map(([m, label]) => (
                <button key={m} onClick={() => setExitMode(m)}
                  className={[
                    'flex-1 font-body text-[11px] px-3 py-2 rounded-button border transition-colors',
                    exitMode === m ? 'border-mint-deep/50 bg-mint-tint text-mint-deep font-medium'
                                   : 'border-line text-muted hover:border-mint-deep/30',
                  ].join(' ')}>
                  {label}
                </button>
              ))}
            </div>
            {exitMode === 'tpsl' && (
              <div className="mt-3 flex flex-col gap-3">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-body text-[10px] uppercase tracking-wide text-muted">Take-profit</span>
                    <span className="font-body text-[11px] text-[#0c9d6e] tabular-nums">+{tp}%</span>
                  </div>
                  <input type="range" min={5} max={200} step={5} value={tp}
                    onChange={e => setTp(Number(e.target.value))} className="w-full accent-[#0c9d6e]" />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-body text-[10px] uppercase tracking-wide text-muted">Stop-loss</span>
                    <span className="font-body text-[11px] text-coral-ink tabular-nums">−{sl}%</span>
                  </div>
                  <input type="range" min={5} max={90} step={5} value={sl}
                    onChange={e => setSl(Number(e.target.value))} className="w-full accent-[#e5484d]" />
                </div>
              </div>
            )}
          </div>

          {/* Live mirror list */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="font-body text-[10px] uppercase tracking-wide text-muted">
                Mirror ({shown.length}{positions.length > shown.length ? ` of ${positions.length}` : ''})
              </span>
              <span className="font-body text-[10px] text-muted">
                capital: them <Redacted value={totalTheir}>{v => `$${v.toFixed(0)}`}</Redacted>
                {' → '}you <Redacted value={totalYours}>{v => <span className="text-mint-deep font-medium">${v.toFixed(0)}</span>}</Redacted>
              </span>
            </div>
            {loading ? (
              <div className="font-body text-[11px] text-muted flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />Loading positions…</div>
            ) : shown.length === 0 ? (
              <div className="font-body text-[11px] text-muted rounded-card border border-line bg-bg-soft/40 p-3">
                No real open positions in these categories. It will copy the next orders they open.
              </div>
            ) : (
              <div className="rounded-card border border-line divide-y divide-line overflow-hidden">
                {shown.map((p, i) => {
                  const yourUsd    = p.currentValue != null ? p.currentValue * pct / 100 : null;
                  const yourShares = p.size != null ? p.size * pct / 100 : null;
                  return (
                    <div key={i} className="flex items-center gap-2 px-2.5 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-body text-[11px] text-ink truncate">{p.marketTitle ?? '—'}</div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {p.category && <span className={`font-body text-[9px] ${catText(p.category)}`}>{p.category}</span>}
                          {p.side && <span className="font-body text-[9px] text-muted">· {p.side}</span>}
                        </div>
                      </div>
                      <div className="text-right shrink-0 font-body text-[10px] tabular-nums">
                        <div className="text-muted">
                          them <Redacted value={p.currentValue}>{v => `$${v.toFixed(0)}`}</Redacted>
                        </div>
                        <div className="text-mint-deep font-medium">
                          you <Redacted value={yourUsd}>{v => `$${v.toFixed(0)}`}</Redacted>
                          <span className="text-muted font-normal"> · {fmtSize(yourShares)}sh</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Protections always on (display only) */}
          <div className="rounded-card border border-line bg-bg-soft/40 p-3">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Shield className="w-3 h-3 text-[#0c9d6e]" strokeWidth={2.5} />
              <span className="font-body text-[10px] uppercase tracking-wide text-ink-2 font-medium">Protections always on</span>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 font-body text-[10px] text-muted">
              <span>✓ pre-flight executable price</span>
              <span>✓ no double entry</span>
              <span>✓ ignore old fills</span>
              <span>✓ liquidity check</span>
            </div>
          </div>

          {/* Mode: paper active / live locked */}
          <div className="flex gap-1.5">
            <div className="flex-1 flex items-center justify-center gap-1.5 font-body text-[11px] px-3 py-2 rounded-button border border-mint-deep/50 bg-mint-tint text-mint-deep font-medium">
              <Check className="w-3 h-3" strokeWidth={3} />📄 Paper · active
            </div>
            <div className="flex-1 flex items-center justify-center gap-1.5 font-body text-[11px] px-3 py-2 rounded-button border border-line text-muted bg-bg-soft cursor-not-allowed"
                 title={AUTO_EXECUTE_ENABLED ? 'Live coming soon' : 'Live execution disabled'}>
              <Lock className="w-3 h-3" />🔒 Live · COMING SOON
            </div>
          </div>

          {/* Errors / auth hint */}
          {needAuth && (
            <div className="rounded-card border border-gold/30 bg-gold-tint px-3 py-2 font-body text-[11px] text-ink-2">
              Sign in to start copying. <Link href="/login" className="text-[#0c9d6e] underline underline-offset-2">Sign in →</Link>
            </div>
          )}
          {err && (
            <div className="rounded-card border border-coral-ink/30 bg-coral-tint px-3 py-2 font-body text-[11px] text-coral-ink">{err}</div>
          )}

          {/* Start */}
          <button onClick={save} disabled={saving || saved}
            className={[
              'w-full flex items-center justify-center gap-1.5 font-body font-medium text-[12px] uppercase tracking-wide px-4 py-2.5 rounded-button transition-colors',
              saved ? 'bg-mint-deep text-white'
                    : 'bg-[#0c9d6e] text-white hover:bg-mint-deep disabled:opacity-60',
            ].join(' ')}>
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {saved
              ? <><Check className="w-3.5 h-3.5" strokeWidth={3} />{hasExisting ? 'Copy updated · paper' : 'Copy started · paper'}</>
              : (hasExisting ? 'Update copy · paper' : 'Start copy · paper')}
          </button>
          {hasExisting && !saved && (
            <button onClick={remove} disabled={saving}
              className="w-full font-body text-[11px] text-coral-ink hover:text-coral-ink/80 disabled:opacity-60 -mt-2">
              Stop copying
            </button>
          )}
          <p className="font-body text-[10px] text-muted text-center leading-relaxed -mt-2">
            Paper simulation with real executable prices. No real order is executed.
          </p>
        </div>
      </div>
    </div>
  );
}
