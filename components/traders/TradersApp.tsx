'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Eyebrow        from '@/app/components/ui/Eyebrow';
import SectionHeading from '@/app/components/ui/SectionHeading';
import PlatformLogo   from '@/components/PlatformLogo';
import { Redacted }   from '@/app/components/ui/Redacted';
import { ActorBadge, VerifiedTick, WinRate, ConfidenceBar, CopyButton } from './parts';
import TraderProfileView from './TraderProfile';
import {
  fmtPnl, fmtVol, fmtWallet, fmtUpdated, displayName, pnlColor, isLowSample,
  type LbData, type LbEntry, type TraderProfile,
} from './format';

type Tab = 'leaderboard' | 'bots';
type RankBy = 'profit' | 'volume';

const COPY_STORE = 'edgeradar.traders.copying';
interface CopySlot { wallet: string; name: string; at: number; }

// ── Copy-slot management (persistence + gating ONLY) ──────────────────────────
// This reserves a local signal-follow slot and persists it to localStorage. It
// executes NO trade. Real copy-follow execution (wiring to agent21) is a separate,
// security-hardening-gated commit — see CopyButton in parts.tsx.
function useCopySlots(maxSlots: number) {
  const [slots, setSlots] = useState<CopySlot[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(COPY_STORE);
      if (raw) setSlots(JSON.parse(raw));
    } catch { /* corrupt store → start empty */ }
  }, []);

  const persist = useCallback((next: CopySlot[]) => {
    setSlots(next);
    try { localStorage.setItem(COPY_STORE, JSON.stringify(next)); } catch { /* quota — non-fatal */ }
  }, []);

  const isCopying = useCallback((w: string) => slots.some(s => s.wallet === w), [slots]);

  const toggle = useCallback((wallet: string, name: string) => {
    const has = slots.some(s => s.wallet === wallet);
    if (has) { persist(slots.filter(s => s.wallet !== wallet)); return; }
    if (slots.length >= maxSlots) return;   // guarded by CopyButton's atLimit UI
    persist([...slots, { wallet, name, at: Date.now() }]);
  }, [slots, maxSlots, persist]);

  return { slots, isCopying, toggle, count: slots.length };
}

export default function TradersApp() {
  const [tab, setTab]         = useState<Tab>('leaderboard');
  const [cat, setCat]         = useState('All');
  const [rankBy, setRankBy]   = useState<RankBy>('profit');
  const [lbData, setLbData]   = useState<LbData | null>(null);
  const [error, setError]     = useState('');

  const [tier, setTier]       = useState<'free' | 'pro'>('free');
  const maxSlots = tier === 'pro' ? 2 : 1;
  const copy = useCopySlots(maxSlots);

  // Profile routing
  const [selected, setSelected]       = useState<LbEntry | null>(null);
  const [profile, setProfile]         = useState<TraderProfile | null>(null);
  const [profLoading, setProfLoading] = useState(false);
  const [profError, setProfError]     = useState('');

  const loadLb = useCallback(async () => {
    try {
      const r = await fetch('/api/leaderboard');
      setLbData(await r.json());
    } catch (e: any) { setError(e.message || 'Failed to load leaderboard'); }
  }, []);

  useEffect(() => {
    loadLb();
    const t = setInterval(loadLb, 60_000);
    return () => clearInterval(t);
  }, [loadLb]);

  // Tier detection — reuses the server-side plan gate. 401 (unauth) → free.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/subscription');
        if (!r.ok) return;
        const d = await r.json();
        setTier(d.plan === 'pro' || d.plan === 'profit_share' ? 'pro' : 'free');
      } catch { /* stays free */ }
    })();
  }, []);

  async function openProfile(entry: LbEntry) {
    setSelected(entry);
    setProfile(null);
    setProfError('');
    if (entry.hasProfile === false) {
      setProfError('No detailed profile for this wallet yet — check back after the next scan.');
      return;
    }
    setProfLoading(true);
    try {
      const r = await fetch(`/api/leaderboard/profile/${entry.wallet.toLowerCase()}`);
      const d = await r.json();
      if (!r.ok || !d.profile) setProfError(d.error || 'Profile unavailable.');
      else setProfile(d.profile as TraderProfile);
    } catch (e: any) {
      setProfError(e.message || 'Network error');
    } finally {
      setProfLoading(false);
    }
  }

  const categoryKeys = useMemo(() => Object.keys(lbData?.categories ?? {}), [lbData]);

  const rows = useMemo(() => {
    const list = (lbData?.categories?.[cat] ?? []).slice();
    const key = rankBy === 'profit' ? 'pnlUsdc' : 'volumeUsdc';
    const hasValues = list.some(e => e[key] != null);
    // Ranking rules (honest-engine):
    //  1. Thin-sample wallets (resolvedMarkets < 10) are FLOORED below proven
    //     ones — a "100% on 1 trade" wallet can never top a real track record.
    //     resolvedMarkets is a public field, so this holds on the free tier too.
    //  2. Within a sample tier, sort by the chosen metric (pnl / volume) when
    //     present, else keep the API's order (free tier can't sort null values —
    //     never fabricate an order).
    //  3. Tiebreak on wilsonScore DESC — the sample-robust skill metric. Raw
    //     winRate is NEVER a sort key.
    list.sort((a, b) => {
      const aLow = isLowSample(a.resolvedMarkets), bLow = isLowSample(b.resolvedMarkets);
      if (aLow !== bLow) return aLow ? 1 : -1;
      if (hasValues) {
        const d = (b[key] ?? -Infinity) - (a[key] ?? -Infinity);
        if (d !== 0) return d;
      }
      return (b.wilsonScore ?? -Infinity) - (a.wilsonScore ?? -Infinity);
    });
    return list;
  }, [lbData, cat, rankBy]);

  const bots = useMemo(() => {
    const all = lbData?.categories?.['All'] ?? [];
    return all
      .filter(e => e.actorType?.type === 'bot')
      .sort((a, b) => (b.actorType?.confidence ?? 0) - (a.actorType?.confidence ?? 0)
        || (b.pnlUsdc ?? -Infinity) - (a.pnlUsdc ?? -Infinity));
  }, [lbData]);

  const warmingUp = !lbData || (!lbData.ok && !lbData.updatedAt);
  const atLimit   = copy.count >= maxSlots;

  return (
    <div className="max-w-[1100px] mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Eyebrow className="inline-flex items-center gap-1.5">
            <PlatformLogo platform="polymarket" size={12} />Polymarket · Top Traders
          </Eyebrow>
          <SectionHeading as="h1" className="text-3xl mt-1">Top Traders</SectionHeading>
          <p className="font-body text-sm text-muted mt-1.5">
            On-chain resolved P&amp;L · {lbData?.totalWallets ?? 0} wallets ranked · {lbData?.marketsScanned ?? 0} markets scanned
          </p>
        </div>
        <div className="flex flex-col items-end gap-0.5 font-body text-[11px]">
          {lbData?.stale
            ? <span className="text-gold">data {lbData.staleMinutes}m old · refreshing</span>
            : <span className="text-muted">{fmtUpdated(lbData?.updatedAt)}</span>}
          <span className="text-muted">{tier === 'pro' ? 'Pro' : 'Free'} · {copy.count}/{maxSlots} copy slots</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 border-b border-line mb-4">
        {(['leaderboard', 'bots'] as Tab[]).map(t => (
          <button key={t} onClick={() => { setTab(t); setSelected(null); }}
            className={[
              'px-4 py-2 font-body font-medium text-[11px] uppercase tracking-widest transition-colors relative',
              tab === t ? 'text-mint-deep' : 'text-muted hover:text-ink-2',
            ].join(' ')}>
            {t === 'leaderboard' ? 'Leaderboard' : `Bots / HFT (${bots.length})`}
            {tab === t && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-mint-deep rounded-full" />}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 border border-coral-ink/30 bg-coral-tint rounded-card font-body text-[11px] text-coral-ink">{error}</div>
      )}

      {warmingUp && (
        <div className="rounded-card border border-line bg-surface shadow-card p-8 text-center">
          <div className="font-body font-medium text-sm text-ink-2 mb-1">Agent warming up — scanning resolved markets…</div>
          <div className="font-body text-[11px] text-muted">First data in ~2–3 min.</div>
        </div>
      )}

      {/* ── Profile view ─────────────────────────────────────────────────────── */}
      {!warmingUp && selected && (
        <TraderProfileView
          entry={selected}
          profile={profile}
          loading={profLoading}
          error={profError}
          onBack={() => setSelected(null)}
          copying={copy.isCopying(selected.wallet)}
          atLimit={atLimit && !copy.isCopying(selected.wallet)}
          tier={tier}
          maxSlots={maxSlots}
          onToggleCopy={() => copy.toggle(selected.wallet, displayName(selected))}
        />
      )}

      {/* ── Leaderboard tab ──────────────────────────────────────────────────── */}
      {!warmingUp && !selected && tab === 'leaderboard' && (
        <>
          {/* Rank-by + window controls */}
          <div className="flex items-center justify-between gap-4 flex-wrap mb-3">
            <div className="flex items-center gap-4">
              <span className="font-body text-[10px] uppercase tracking-wide text-muted">Rank by</span>
              {(['profit', 'volume'] as RankBy[]).map(r => (
                <button key={r} onClick={() => setRankBy(r)}
                  className={[
                    'font-body text-[11px] uppercase tracking-wide pb-0.5 border-b-2 transition-colors',
                    rankBy === r ? 'text-ink border-[#0c9d6e]' : 'text-muted border-transparent hover:text-ink-2',
                  ].join(' ')}>
                  {r}
                </button>
              ))}
            </div>
            {/* Window: the list carries only the agent's all-time resolved window.
                1D/7D/30D are disabled until per-window data is backfilled — shown,
                never faked (honest-engine). Populates automatically when available. */}
            <div className="flex items-center gap-4">
              <span className="font-body text-[10px] uppercase tracking-wide text-muted">Window</span>
              {(['1d', '7d', '30d', 'all'] as const).map(w => {
                const on = w === 'all';
                return (
                  <button key={w} disabled={!on}
                    title={on ? undefined : 'Per-window ranking backfilling — showing all-time'}
                    className={[
                      'font-body text-[11px] uppercase tracking-wide pb-0.5 border-b-2',
                      on ? 'text-ink border-[#0c9d6e]' : 'text-muted/40 border-transparent cursor-not-allowed',
                    ].join(' ')}>
                    {w}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Category chips — real API keys only */}
          <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1 scrollbar-none">
            {categoryKeys.map(c => {
              const count = lbData?.categories?.[c]?.length ?? 0;
              const active = c === cat;
              return (
                <button key={c} onClick={() => setCat(c)}
                  className={[
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-button border font-body font-medium text-[11px] uppercase tracking-wide whitespace-nowrap transition-colors shrink-0',
                    active ? 'border-mint-deep/40 bg-mint-tint text-mint-deep'
                           : 'border-line text-muted hover:border-mint-deep/30 hover:text-ink-2 bg-surface',
                  ].join(' ')}>
                  {c}
                  {count > 0 && (
                    <span className={`font-body text-[9px] px-1.5 py-0.5 rounded-pill ${active ? 'bg-mint-deep/20 text-mint-deep' : 'bg-line text-muted'}`}>{count}</span>
                  )}
                </button>
              );
            })}
          </div>

          {rows.length === 0 ? (
            <div className="rounded-card border border-line bg-surface shadow-card p-8 text-center font-body text-sm text-muted">
              No traders match these filters.
            </div>
          ) : (
            <div className="rounded-card border border-line bg-surface shadow-card overflow-hidden">
              {rows.map((e, i) => (
                <LeaderRow key={e.wallet} e={e} rank={i + 1}
                  onOpen={() => openProfile(e)}
                  copying={copy.isCopying(e.wallet)}
                  atLimit={atLimit && !copy.isCopying(e.wallet)}
                  tier={tier} maxSlots={maxSlots}
                  onToggleCopy={() => copy.toggle(e.wallet, displayName(e))}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Bots / HFT tab ───────────────────────────────────────────────────── */}
      {!warmingUp && !selected && tab === 'bots' && (
        <>
          <div className="mb-4 flex items-start gap-2 p-3 rounded-card border border-[#2f6fb0]/25 bg-[#2f6fb0]/[0.06]">
            <span className="font-body text-[11px] text-[#2f6fb0] leading-relaxed">
              Flagged by trade frequency, 5m/15m-market share, timing regularity, and 24/7 activity — an inference with confidence, not a Polymarket label.
            </span>
          </div>
          {bots.length === 0 ? (
            <div className="rounded-card border border-line bg-surface shadow-card p-8 text-center font-body text-sm text-muted">
              No wallets flagged as bots in the current dataset.
            </div>
          ) : (
            <div className="rounded-card border border-line bg-surface shadow-card overflow-hidden">
              {bots.map((e, i) => (
                <BotRow key={e.wallet} e={e} rank={i + 1}
                  onOpen={() => openProfile(e)}
                  copying={copy.isCopying(e.wallet)}
                  atLimit={atLimit && !copy.isCopying(e.wallet)}
                  tier={tier} maxSlots={maxSlots}
                  onToggleCopy={() => copy.toggle(e.wallet, displayName(e))}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Footer */}
      {!selected && (
        <p className="mt-6 font-body text-[11px] text-muted border-t border-line pt-4 leading-relaxed">
          Rankings from on-chain resolved Polymarket markets. Gross P&amp;L as Polymarket-reported — not net of gas.
          Actor type (human/bot) is a heuristic inference from observable trade timing, never a platform label.
          Copy slots reserve a signal-follow only — no trade is executed. Past performance ≠ future results. Not financial advice.
        </p>
      )}
    </div>
  );
}

// ── Leaderboard row ────────────────────────────────────────────────────────────

interface RowProps {
  e: LbEntry; rank: number; onOpen: () => void;
  copying: boolean; atLimit: boolean; tier: 'free' | 'pro'; maxSlots: number; onToggleCopy: () => void;
}

function LeaderRow({ e, rank, onOpen, copying, atLimit, tier, maxSlots, onToggleCopy }: RowProps) {
  return (
    <div onClick={onOpen}
      className="flex items-center gap-3 px-4 py-3 border-b border-line last:border-b-0 hover:bg-bg-soft/40 cursor-pointer transition-colors">
      <span className="font-body text-[11px] text-muted tabular-nums w-7 shrink-0 text-center">
        {rank <= 3 ? ['🥇', '🥈', '🥉'][rank - 1] : rank}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-body font-medium text-sm text-ink truncate">{displayName(e)}</span>
          <VerifiedTick show={e.verified} />
          <ActorBadge actor={e.actorType} />
          {e.walletType === 'MM' && (
            <span className="font-body text-[9px] font-medium px-1.5 py-[2px] rounded-md border border-gold/40 text-gold bg-gold-tint uppercase tracking-wide">MM</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 font-body text-[10px] text-muted">
          <span>{fmtWallet(e.wallet)}</span>
          <span>· {e.resolvedMarkets} resolved</span>
          <span className="hidden sm:inline">· vol <Redacted value={e.volumeUsdc}>{v => fmtVol(v)}</Redacted></span>
        </div>
      </div>

      <div className="text-right shrink-0">
        <div className={`font-display font-bold text-base tabular-nums ${pnlColor(e.pnlUsdc)}`}>
          <Redacted value={e.pnlUsdc}>{v => fmtPnl(v)}</Redacted>
        </div>
        <div className="flex justify-end mt-0.5 font-body text-[10px] tabular-nums">
          <WinRate winRate={e.winRate} wilson={e.wilsonScore} resolvedMarkets={e.resolvedMarkets} />
        </div>
      </div>

      <div className="shrink-0" onClick={(ev) => ev.stopPropagation()}>
        <CopyButton copying={copying} atLimit={atLimit} tier={tier} maxSlots={maxSlots} onToggle={onToggleCopy} />
      </div>
    </div>
  );
}

// ── Bot row ────────────────────────────────────────────────────────────────────

function BotRow({ e, rank, onOpen, copying, atLimit, tier, maxSlots, onToggleCopy }: RowProps) {
  const conf = e.actorType?.confidence ?? 0;
  const signals = (e.actorType?.signals ?? []).slice(0, 3);
  return (
    <div onClick={onOpen}
      className="px-4 py-3 border-b border-line last:border-b-0 hover:bg-bg-soft/40 cursor-pointer transition-colors">
      <div className="flex items-center gap-3">
        <span className="font-body text-[11px] text-muted tabular-nums w-7 shrink-0 text-center">{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-body font-medium text-sm text-ink truncate">{displayName(e)}</span>
            <ActorBadge actor={e.actorType} />
          </div>
          <div className="flex items-center gap-2 mt-0.5 font-body text-[10px] text-muted">
            <span>{fmtWallet(e.wallet)} · {e.resolvedMarkets} resolved</span>
            <WinRate winRate={e.winRate} wilson={e.wilsonScore} resolvedMarkets={e.resolvedMarkets} />
          </div>
        </div>
        <div className={`text-right shrink-0 w-20 font-display font-bold text-base tabular-nums ${pnlColor(e.pnlUsdc)}`}>
          <Redacted value={e.pnlUsdc}>{v => fmtPnl(v)}</Redacted>
        </div>
        <div className="shrink-0" onClick={(ev) => ev.stopPropagation()}>
          <CopyButton copying={copying} atLimit={atLimit} tier={tier} maxSlots={maxSlots} onToggle={onToggleCopy} />
        </div>
      </div>
      <div className="mt-2 pl-10 flex flex-col gap-2">
        <div className="max-w-[240px]"><ConfidenceBar pct={conf} /></div>
        {signals.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {signals.map((s, i) => (
              <span key={i} className="font-body text-[9px] text-[#2f6fb0] px-1.5 py-0.5 rounded-md border border-[#2f6fb0]/25 bg-[#2f6fb0]/[0.06]">{s}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
