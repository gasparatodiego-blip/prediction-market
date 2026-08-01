'use client';

// FillStrategyPanel — "Strategia sul fill": what happens the moment an order fills.
//
// WHERE IT LIVES AND WHY. Inside the Ottimizza tab, under the planner. The position ceiling this strategy
// enforces IS the capital the planner assigned to each market — so the control that spends an allocation
// and the screen that decides the allocation are the same screen. Putting it in Regole would have split
// one decision across two tabs, and Regole is reference material (how the programme pays, what my orders
// are doing) rather than a place with switches.
//
// IT WRITES CONFIGURATION, AND ONLY CONFIGURATION. Every control here POSTs to /api/maker/fill-strategy,
// which flips a switch or stores a number. No order is created, nothing is signed, no key is touched. The
// strategy acts at the next fill, and only when BOTH switches are on.
//
// THE CEILING HAS NO CONTROL, DELIBERATELY. It is rendered as a locked line because it is derived from
// the allocation plan (lib/maker/allocated-capital), and there is no field for it in the POST body, no
// key for it in the config file, and an explicit refusal in the config module for anything that tries.
// An operator raising their own inventory limit from this screen is precisely what deriving it prevents.
//
// OPERATOR-ONLY, SELF-HIDING: /api/maker/* is admin-gated by middleware, so a non-admin gets nothing.

import { useCallback, useEffect, useState } from 'react';

interface MarketRow {
  marketId: string; title: string | null; shortId: string;
  enabled: boolean; effectivelyEnabled: boolean;
  takeProfitCents: number; takeProfitIsDefault: boolean; takeProfitMirrorsEntry: boolean;
  stopLossPct: number; stopLossIsDefault: boolean;
  maxSlippagePct: number; maxSlippageIsDefault: boolean;
  positionCapUsd: number | null; capReadable: boolean; capStale: boolean;
  capAgeSec: number | null; capReason: string;
}
interface State {
  at: string; readable: boolean; error: string | null;
  globalEnabled: boolean;
  markets: MarketRow[];
  allocation: { readable: boolean; updatedAt: number | null; ageSec: number | null; capital: number | null };
  defaults: { takeProfitCents: number; stopLossPct: number; maxSlippagePct: number };
  ranges: { takeProfit: { min: number; max: number }; stopLoss: { min: number; max: number }; slippage: { min: number; max: number } };
  note: string;
}

const money = (v: number | null | undefined): string =>
  (v == null || !Number.isFinite(v) ? 'N/D' : `$${v.toFixed(2)}`);

export default function FillStrategyPanel() {
  const [operator, setOperator] = useState<boolean | null>(null);
  const [st, setSt] = useState<State | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Slider values while dragging. The write happens on release (onPointerUp/onKeyUp), not on every pixel:
  // one durable write plus one audit line per pixel of travel would be noise, not a record.
  const [draft, setDraft] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/maker/fill-strategy', { cache: 'no-store' });
      if (r.status === 401 || r.status === 404) { setOperator(false); return; }
      setOperator(true);
      const b = (await r.json()) as State;
      setSt(b); setErr(null);
    } catch (e) { setErr((e as Error).message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const write = useCallback(async (payload: Record<string, unknown>, key: string) => {
    setBusy(key); setMsg(null);
    try {
      const r = await fetch('/api/maker/fill-strategy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const b = await r.json();
      setMsg({ ok: b.ok === true, text: b.ok ? String(b.note ?? 'scritto') : `rifiutato: ${b.error ?? 'errore'}` });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally { setBusy(null); }
  }, [load]);

  if (operator !== true) return null;

  const dkey = (id: string, f: string) => `${id}:${f}`;
  const val = (m: MarketRow, f: 'tp' | 'sl') => {
    const k = dkey(m.marketId, f);
    if (draft[k] !== undefined) return draft[k];
    return f === 'tp' ? m.takeProfitCents : m.stopLossPct;
  };

  return (
    <div className="fst-root exch" data-fill-strategy>
      <style>{CSS}</style>

      <div className="ex-sech">
        <span className="ex-sech-t">Strategia sul fill</span>
        <span className={`ex-badge ${st?.globalEnabled ? 'is-ok' : ''}`} data-fst-global-state>
          {st?.globalEnabled ? 'ATTIVA' : 'SPENTA'}
        </span>
      </div>

      {err && <div className="ex-banner is-bad">⚠ Stato non leggibile: {err}</div>}
      {st && st.readable === false && (
        <div className="ex-banner is-bad">⚠ Configurazione non leggibile ({st.error}) — trattata come SPENTA.</div>
      )}

      {/* ── 1 · L'INTERRUTTORE GLOBALE ─────────────────────────────────────────────────────────────── */}
      <div className="ex-panel fst-globalrow" data-fst-global>
        <div className="fst-gtxt">
          <div className="fst-gtitle">Attiva globalmente</div>
          <div className="fst-gsub">Spento di default su tutti i mercati</div>
        </div>
        <button
          role="switch"
          aria-checked={st?.globalEnabled === true}
          aria-label="Attiva globalmente la strategia sul fill"
          className={`fst-switch ${st?.globalEnabled ? 'is-on' : ''}`}
          disabled={busy != null}
          data-fst-global-toggle
          onClick={() => write({ scope: 'global', enabled: !(st?.globalEnabled === true) }, 'global')}
        >
          <span className="fst-knob" />
        </button>
      </div>

      {/* Il tetto viene dal piano: se il piano manca, va detto qui e non scoperto al primo fill. */}
      {st && st.allocation.updatedAt == null && (
        <p className="ex-flag is-bad" data-fst-noplan>
          <span className="ex-flag-i" aria-hidden="true">⚠</span>
          <span>Nessun piano di allocazione registrato: senza tetto la strategia non ripiazza nulla. Calcola un piano qui sopra.</span>
        </p>
      )}

      {st && st.markets.length === 0 && (
        <div className="ex-banner">Nessun mercato abilitato. La strategia si configura per mercato.</div>
      )}

      {/* ── 2 · UNA SCHEDA PER MERCATO ─────────────────────────────────────────────────────────────── */}
      {(st?.markets ?? []).map((m) => {
        const off = !m.enabled;
        return (
          <div key={m.marketId} className="ex-panel fst-card" data-fst-market={m.marketId}>
            <div className="fst-head">
              <div className="fst-htxt">
                <div className="fst-name">{m.title ?? m.shortId}</div>
                <div className="fst-cap">
                  capitale allocato <span className="ex-n">{money(m.positionCapUsd)}</span>
                </div>
              </div>
              <button
                role="switch"
                aria-checked={m.enabled}
                aria-label={`Attiva la strategia su ${m.title ?? m.shortId}`}
                className={`fst-switch ${m.enabled ? 'is-on' : ''}`}
                disabled={busy != null}
                data-fst-market-toggle
                onClick={() => write({ scope: 'market', marketId: m.marketId, enabled: !m.enabled }, m.marketId)}
              >
                <span className="fst-knob" />
              </button>
            </div>

            {/* Gli slider si spengono VISIVAMENTE quando il mercato è OFF: stessa classe, stesso
                booleano del toggle, piu' disabled — cosi' non possono mai dire una cosa diversa da lui. */}
            <div className={`fst-ctl ${off ? 'is-off' : ''}`} data-fst-controls={off ? 'off' : 'on'}>
              <div className="fst-slider">
                <div className="fst-srow">
                  <span className="fst-slabel">Take-profit</span>
                  <span className="fst-sval ex-n" data-fst-tp-value>
                    {m.takeProfitMirrorsEntry && val(m, 'tp') === 0 ? 'specchiato' : `+${val(m, 'tp').toFixed(1)}¢`}
                  </span>
                </div>
                <input
                  type="range" className="fst-range" data-fst-tp
                  min={st!.ranges.takeProfit.min} max={st!.ranges.takeProfit.max} step={0.1}
                  value={val(m, 'tp')} disabled={off || busy != null}
                  aria-label="Take-profit in centesimi"
                  onChange={(e) => setDraft((d) => ({ ...d, [dkey(m.marketId, 'tp')]: Number(e.target.value) }))}
                  onPointerUp={() => write({ scope: 'market', marketId: m.marketId, patch: { takeProfitCents: val(m, 'tp') } }, m.marketId)}
                  onKeyUp={() => write({ scope: 'market', marketId: m.marketId, patch: { takeProfitCents: val(m, 'tp') } }, m.marketId)}
                />
                <div className="fst-shint">
                  {val(m, 'tp') === 0
                    ? 'a 0 l’uscita specchia la distanza dal mid dell’ordine che ha riempito'
                    : `uscita a carico +${val(m, 'tp').toFixed(1)}¢, arrotondata in su al tick`}
                </div>
              </div>

              <div className="fst-slider">
                <div className="fst-srow">
                  <span className="fst-slabel">Stop-loss</span>
                  <span className="fst-sval ex-n" data-fst-sl-value>{val(m, 'sl').toFixed(1)}%</span>
                </div>
                <input
                  type="range" className="fst-range" data-fst-sl
                  min={st!.ranges.stopLoss.min} max={20} step={0.5}
                  value={val(m, 'sl')} disabled={off || busy != null}
                  aria-label="Stop-loss in percentuale"
                  onChange={(e) => setDraft((d) => ({ ...d, [dkey(m.marketId, 'sl')]: Number(e.target.value) }))}
                  onPointerUp={() => write({ scope: 'market', marketId: m.marketId, patch: { stopLossPct: val(m, 'sl') } }, m.marketId)}
                  onKeyUp={() => write({ scope: 'market', marketId: m.marketId, patch: { stopLossPct: val(m, 'sl') } }, m.marketId)}
                />
                <div className="fst-shint">drawdown sul carico medio ponderato di tutti i fill su questo lato</div>
              </div>
            </div>

            {/* ── IL TETTO: una riga con il lucchetto, e nessun controllo. ── */}
            <p className="fst-lock" data-fst-cap>
              🔒 Tetto posizione: <span className="ex-n">{money(m.positionCapUsd)}</span>{' '}
              (= capitale allocato, non modificabile qui)
            </p>
            {m.positionCapUsd == null && (
              <p className="ex-why" data-fst-cap-why>{m.capReason} — senza tetto il ripiazzamento resta fermo</p>
            )}
            {m.capStale && <p className="ex-why ex-why-warn">piano di allocazione non aggiornato</p>}
            {m.enabled && st?.globalEnabled !== true && (
              <p className="ex-why ex-why-warn" data-fst-master-off>
                acceso su questo mercato, ma l’interruttore generale è spento e ha la precedenza
              </p>
            )}
          </div>
        );
      })}

      {msg && <div className={`ex-banner ${msg.ok ? 'is-ok' : 'is-bad'} fst-msg`} data-fst-msg>{msg.text}</div>}

      <p className="fst-note">
        Questi controlli scrivono <b>solo configurazione</b>: nessun ordine viene creato qui. La strategia
        agisce al prossimo fill, e solo con entrambi gli interruttori accesi. Ogni ordine che proporrà passa
        dagli stessi gate di un ordine a mano — kill-switch, cap, venue-rules, validateOrder.
      </p>
    </div>
  );
}

// NOTE: keep this stylesheet free of the characters React escapes in text nodes — quotes, angle
// brackets, ampersands.
const CSS = `
.fst-root { margin-top: 18px; }
.fst-globalrow { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 14px; }
.fst-gtxt { min-width: 0; }
.fst-gtitle { font-size: 14px; font-weight: 700; color: var(--ex-txt); }
.fst-gsub { font-size: 11px; color: var(--ex-txt-3); margin-top: 2px; }

/* L interruttore: oro quando acceso, come ogni altro stato attivo di questa dashboard. */
.fst-switch { flex: 0 0 auto; width: 46px; height: 26px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--ex-line); background: var(--ex-panel-2); position: relative;
  padding: 0; touch-action: manipulation; }
.fst-switch:disabled { opacity: .5; cursor: wait; }
.fst-knob { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%;
  background: var(--ex-txt-3); transition: left .12s ease, background .12s ease; }
.fst-switch.is-on { background: var(--ex-gold-bg); border-color: var(--ex-gold); }
.fst-switch.is-on .fst-knob { left: 22px; background: var(--ex-gold); }
.fst-switch:focus-visible { outline: 2px solid var(--ex-gold); outline-offset: 2px; }

.fst-card { padding: 12px 14px; margin-top: 8px; }
.fst-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.fst-htxt { min-width: 0; }
.fst-name { font-size: 13px; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
.fst-cap { font-size: 11px; color: var(--ex-txt-3); margin-top: 3px; }

.fst-ctl { margin-top: 12px; display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 14px; }
/* SPENTO VISIVAMENTE quando il mercato e OFF. Stessa condizione del toggle, piu il disabled sugli
   input: il colore non e mai l unico canale, ma qui rinforza quello che l attributo gia dice. */
.fst-ctl.is-off { opacity: .45; }
.fst-slider { min-width: 0; }
.fst-srow { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.fst-slabel { font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--ex-txt-3); }
.fst-sval { font-size: 15px; font-weight: 700; color: var(--ex-gold); }
.fst-range { width: 100%; margin: 6px 0 0; accent-color: var(--ex-gold); height: 22px; }
.fst-range:disabled { cursor: not-allowed; }
.fst-shint { font-size: 10px; color: var(--ex-txt-3); line-height: 1.45; margin-top: 3px; }

.fst-lock { font-size: 11px; color: var(--ex-txt-2); margin: 11px 0 0; line-height: 1.5;
  border-top: 1px solid var(--ex-line-soft); padding-top: 9px; overflow-wrap: anywhere; }
.fst-msg { margin-top: 10px; }
.fst-note { font-size: 11px; color: var(--ex-txt-3); line-height: 1.55; margin: 12px 0 0; }
`;
