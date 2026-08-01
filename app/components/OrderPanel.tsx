'use client';

// OrderPanel — il pannello di piazzamento, aperto SOPRA la lista che lo ha chiamato.
//
// PERCHÉ ESISTE, E PERCHÉ CHIUDE UN BUG DI CLASSE. Prima, per piazzare, si toccava un mercato in una tab
// e si finiva in un'altra con una RICERCA precompilata: l'identità del mercato viaggiava come TESTO, e una
// ricerca testuale restituisce una lista. Il mercato da cui si era partiti non era quasi mai la prima riga
// (i risultati sono ordinati per scadenza più vicina), e chi premeva la prima riga agiva su un mercato che
// non aveva scelto. È successo davvero: alle 18:09:37 del 2026-08-01 è stato abilitato un mercato che
// nessuno voleva.
//
// Qui quel percorso non esiste più. Il pannello riceve l'OGGETTO del mercato toccato e lo tiene: nessuna
// navigazione, nessuna ricerca, nessun testo da risolvere. Il conditionId che finisce nella richiesta è per
// costruzione lo stesso della card toccata — non c'è un passaggio in cui possa diventare un altro.
//
// LA CONFERMA RESTA IN DUE TOCCHI, e non è negoziabile. «Rivedi ordine» costruisce il riepilogo, «Conferma
// e piazza» è l'unico punto che scrive. Sono due tocchi sulla STESSA schermata: nessun ping-pong fra tab,
// ma nemmeno un ordine reale a un tocco solo.
//
// COSA DICE IL PULSANTE FINALE. Lo stato di invio lo decide MANUAL_ORDER_PLACEMENT sul server, che è una
// cosa DIVERSA da MAKER_MODE: il percorso manuale ha il suo interruttore e non legge quello del motore.
// Il pannello legge lo stato reale da /api/maker/manual/config e lo scrive sul pulsante. Non dice mai
// «dry-run» quando il server invierebbe davvero.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** La forma normalizzata che il pannello accetta, da qualunque lista arrivi. */
export interface OrderTarget {
  marketId: string;
  title: string;
  /** Fine del mercato, ISO. null = non leggibile (mai dedotta). */
  endDate: string | null;
  minutesToClose: number | null;
  mid: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spreadCents: number | null;
  tick: number | null;
  minSize: number | null;
  maxSpreadCents: number | null;
  rewardsDailyRate: number | null;
  hasRewards: boolean;
  enabled: boolean;
  /** Size suggerita da un piano di allocazione; assente ⇒ si parte dalla size minima del venue. */
  presetSize?: number | null;
}

interface ManualCfg {
  kill: { readable: boolean; killed: boolean; reason: string | null };
  placement: { mode: string; sends: boolean; note: string };
  caps: { readable: boolean; effectiveOrderCapUsd: number | null; maxOrderNotionalUsd: number | null; liveMinCapUsd: number | null };
  autoReprice: { expiry: { orderType: string; ttlSeconds: number; refreshMarginSeconds: number | null } | null; globalEnabled: boolean; optedInMarketIds: string[] } | null;
}
interface PlaceResult {
  ok: boolean; sent: boolean; dryRun?: boolean; placement?: string;
  gate: string | null; reason: string | null; orderId?: string | null; notionalUsd?: number | null;
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const money = (v: number | null | undefined, nd = 2): string => (fin(v) ? `$${v.toFixed(nd)}` : 'N/D');
const cents = (p: number | null | undefined): string => (fin(p) ? `${(p * 100).toFixed(1)}¢` : 'N/D');

/** Countdown leggibile. Mai «0m»: sotto il minuto lo dice, sotto i dieci tiene il decimo. */
function closeTxt(min: number | null): string {
  if (!fin(min)) return 'scadenza ignota';
  if (min <= 0) return 'scaduto';
  if (min < 1) return 'meno di 1 min';
  if (min < 10) return `${min.toFixed(1)} min`;
  if (min < 90) return `${Math.round(min)} min`;
  if (min < 2880) return `${(min / 60).toFixed(1)} h`;
  return `${(min / 1440).toFixed(1)} g`;
}
/** Il prezzo agganciato alla griglia del tick. Arrotonda al più vicino: qui non c'è un lato da favorire. */
function snapToTick(price: number, tick: number): number {
  return +(Math.round(price / tick) * tick).toFixed(10);
}
function onTick(price: number, tick: number): boolean {
  if (!fin(price) || !fin(tick) || tick <= 0) return false;
  return Math.abs(price - snapToTick(price, tick)) < tick / 1000;
}

export default function OrderPanel({ target, balanceUsd, onClose, onEnabled }: {
  target: OrderTarget;
  balanceUsd: number | null;
  onClose: () => void;
  onEnabled?: (marketId: string) => void;
}) {
  const [cfg, setCfg] = useState<ManualCfg | null>(null);
  const [book, setBook] = useState<'yes' | 'no'>('yes');
  const [sizeStr, setSizeStr] = useState('');
  const [priceStr, setPriceStr] = useState('');
  const [autoRenew, setAutoRenew] = useState(true);
  const [step, setStep] = useState<'form' | 'review'>('form');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PlaceResult | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [enableMsg, setEnableMsg] = useState<string | null>(null);
  const [isEnabled, setIsEnabled] = useState(target.enabled);
  // Orologio a 1s: il countdown sotto i 5 minuti deve muoversi, non sembrare fermo.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const firstFocus = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // PRECOMPILAZIONE. Size = quella del piano se c'è, altrimenti la minima del venue. Prezzo = il mid
  // agganciato al tick. Entrambi editabili; entrambi validati contro le regole del venue, non contro
  // una copia locale di quelle regole.
  useEffect(() => {
    const s = fin(target.presetSize) && (target.presetSize as number) > 0 ? (target.presetSize as number) : target.minSize;
    setSizeStr(fin(s) ? String(+(s as number).toFixed(4)) : '');
    const p = fin(target.mid) && fin(target.tick) && (target.tick as number) > 0
      ? snapToTick(target.mid as number, target.tick as number) : target.mid;
    setPriceStr(fin(p) ? String(p) : '');
    setStep('form'); setResult(null); setEnableMsg(null);
    setIsEnabled(target.enabled);
  }, [target]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/maker/manual/config', { cache: 'no-store' });
        if (!r.ok) return;
        const b = (await r.json()) as ManualCfg;
        if (alive) setCfg(b);
      } catch { /* i gate restano ignoti: il pannello lo dice invece di supporli aperti */ }
    })();
    return () => { alive = false; };
  }, []);

  // Chiusura con Escape, oltre alla X — il pannello è modale e deve avere una via d'uscita da tastiera.
  // LO SFONDO NON SI MUOVE. Il pannello si apre SOPRA la lista, e alla chiusura la lista deve essere
  // dov era: stessa riga sotto il dito, stesso scorrimento. Bloccare il body non basta da solo, perche
  // `position: fixed` sul body riporta la pagina in cima — quindi lo scorrimento si registra, si
  // congela, e si rimette esattamente com era.
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    const y = window.scrollY;
    const b = document.body.style;
    const prev = { position: b.position, top: b.top, width: b.width, overflow: b.overflow };
    b.position = 'fixed'; b.top = `-${y}px`; b.width = '100%'; b.overflow = 'hidden';
    // `preventScroll` perche dare il fuoco a un elemento dentro un contenitore fisso puo comunque
    // trascinare gli antenati: il fuoco serve per la tastiera, non per spostare la pagina.
    firstFocus.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', h);
      b.position = prev.position; b.top = prev.top; b.width = prev.width; b.overflow = prev.overflow;
      window.scrollTo(0, y);
    };
  }, [onClose]);

  const size = Number(sizeStr);
  const price = Number(priceStr);
  const notional = fin(size) && fin(price) && size > 0 && price > 0 ? size * price : null;

  // Minuti alla chiusura, ricalcolati sull'orologio locale: il valore arrivato con la card invecchia
  // mentre il pannello resta aperto, e un countdown fermo su un mercato da 5 minuti è peggio di nessun
  // countdown. Con l'orario di chiusura si conta da quello; senza, si conta dal minuto letto
  // all'apertura — stessa lettura, invecchiata onestamente, non una precisione inventata.
  const openedAt = useRef<number>(Date.now());
  useEffect(() => { openedAt.current = Date.now(); }, [target]);
  const minsLeft = useMemo(() => {
    if (target.endDate) {
      const t = Date.parse(target.endDate);
      if (Number.isFinite(t)) return (t - nowMs) / 60_000;
    }
    if (fin(target.minutesToClose)) return (target.minutesToClose as number) - (nowMs - openedAt.current) / 60_000;
    return null;
  }, [target.endDate, target.minutesToClose, nowMs]);

  const ttlSeconds = cfg?.autoReprice?.expiry?.ttlSeconds ?? 1380;
  const refreshMargin = cfg?.autoReprice?.expiry?.refreshMarginSeconds ?? 180;
  const repriceOn = !!(cfg?.autoReprice?.globalEnabled
    && (cfg?.autoReprice?.optedInMarketIds ?? []).map((x) => x.toLowerCase()).includes(target.marketId.toLowerCase()));

  // ── LE VALIDAZIONI, contro le regole del venue di QUESTO mercato ────────────────────────────────
  const problems = useMemo(() => {
    const out: Array<{ key: string; text: string; blocking: boolean }> = [];
    if (!fin(size) || size <= 0) out.push({ key: 'size', text: 'Inserisci una size.', blocking: true });
    else if (fin(target.minSize) && size < (target.minSize as number)) {
      // PRECISIONE SUL PERCHÉ. Questa soglia è min_incentive_size, non un minimo d'ordine: un ordine più
      // piccolo il CLOB lo accetta eccome. Semplicemente il programma premi non lo vede, quindi matura
      // zero. Dirlo come «viene rifiutato» sarebbe falso, e la conseguenza vera è peggiore: un ordine
      // che resta lì a occupare capitale senza produrre nulla.
      out.push({ key: 'minsize', text: `Sotto min_incentive_size (${target.minSize} share): il CLOB lo accetta, ma il programma premi non lo vede e matura ZERO.`, blocking: true });
    }
    if (!fin(price) || price <= 0 || price >= 1) out.push({ key: 'price', text: 'Il prezzo deve stare fra 0 e 1.', blocking: true });
    else if (fin(target.tick) && (target.tick as number) > 0 && !onTick(price, target.tick as number)) {
      out.push({ key: 'tick', text: `Fuori griglia: il tick è ${target.tick}. Il prezzo valido più vicino è ${snapToTick(price, target.tick as number)}.`, blocking: true });
    }
    const cap = cfg?.caps?.effectiveOrderCapUsd ?? null;
    if (fin(notional) && fin(cap) && (notional as number) > (cap as number) + 1e-9) {
      out.push({ key: 'cap', text: `Controvalore ${money(notional)} oltre il tetto per ordine ${money(cap)}.`, blocking: true });
    }
    if (fin(notional) && fin(balanceUsd) && (notional as number) > (balanceUsd as number) + 1e-9) {
      out.push({ key: 'balance', text: `Saldo insufficiente: servono ${money(notional)}, disponibili ${money(balanceUsd)}.`, blocking: true });
    }
    if (cfg && (cfg.kill.killed || cfg.kill.readable === false)) {
      out.push({ key: 'kill', text: cfg.kill.readable === false ? 'Kill-switch non leggibile — trattato come attivo.' : 'Kill-switch ATTIVO: nessun ordine può essere piazzato.', blocking: true });
    }
    if (!isEnabled) out.push({ key: 'enable', text: 'Mercato non abilitato: il gate live-min rifiuterebbe. Abilitalo qui sopra.', blocking: true });
    if (fin(minsLeft) && (minsLeft as number) < 3) {
      out.push({ key: 'expiry', text: `Scade fra ${closeTxt(minsLeft)}: sotto i 3 minuti il venue non riesce a esprimere la durata di un ordine — potrebbe non arrivare a tempo.`, blocking: false });
    }
    return out;
  }, [size, price, notional, target, cfg, balanceUsd, isEnabled, minsLeft]);

  const blocking = problems.filter((p) => p.blocking);
  const canReview = blocking.length === 0;

  const enableNow = useCallback(async () => {
    setEnabling(true); setEnableMsg(null);
    try {
      const r = await fetch('/api/maker/markets/enable', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketId: target.marketId, preview: false, enabled: true, takeManual: true, reason: 'abilitato dal pannello ordine' }),
      });
      const b = await r.json();
      if (b.ok) { setIsEnabled(true); setEnableMsg('Abilitato e preso in gestione manuale.'); onEnabled?.(target.marketId); }
      else setEnableMsg(`Rifiutato: ${b.error ?? b.gate ?? 'errore'}`);
    } catch (e) { setEnableMsg((e as Error).message); }
    finally { setEnabling(false); }
  }, [target.marketId, onEnabled]);

  // ── L'UNICO PUNTO CHE SCRIVE ───────────────────────────────────────────────────────────────────
  const place = useCallback(async () => {
    setBusy(true); setResult(null);
    try {
      const r = await fetch('/api/maker/manual/order', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketId: target.marketId, book, price, size,
          // 0 ⇒ GTC. Con il rinnovo disattivato si chiede la finestra fissa; altrimenti si lascia
          // decidere al server dallo switch per-mercato, che è la fonte di verità.
          ...(autoRenew ? {} : { ttlSeconds }),
          note: 'pannello ordine',
        }),
      });
      setResult((await r.json()) as PlaceResult);
    } catch (e) {
      setResult({ ok: false, sent: false, gate: 'request-failed', reason: (e as Error).message });
    } finally { setBusy(false); }
  }, [target.marketId, book, price, size, autoRenew, ttlSeconds]);

  const sends = cfg?.placement?.sends === true;

  return (
    <div className="op-scrim exch" data-order-panel={target.marketId} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <style>{CSS}</style>
      <div className="op-sheet" role="dialog" aria-modal="true" aria-label={`Piazza ordine su ${target.title}`}>

        {/* ── 1 · INTESTAZIONE ─────────────────────────────────────────────────────────────────── */}
        <div className="op-head">
          <div className="op-head-txt">
            <div className="op-title" data-op-title>{target.title}</div>
            <div className="op-sub">
              <span className="ex-n" data-op-close-at>
                {target.endDate ? new Date(target.endDate).toLocaleTimeString() : 'orario ignoto'}
              </span>
              {' · '}
              <span className={`ex-badge ${fin(minsLeft) && (minsLeft as number) < 3 ? 'is-bad' : fin(minsLeft) && (minsLeft as number) < 60 ? 'is-warn' : ''}`} data-op-countdown>
                {closeTxt(minsLeft)}
              </span>
              {' '}
              <span className={`ex-badge ${isEnabled ? 'is-gold' : ''}`} data-op-enabled={isEnabled ? '1' : '0'}>
                {isEnabled ? 'abilitato' : 'non abilitato'}
              </span>
              {!target.hasRewards && <span className="ex-badge is-warn op-bdg">NESSUN REWARD — solo trading direzionale</span>}
            </div>
            <div className="op-id ex-n">{target.marketId}</div>
          </div>
          <button ref={firstFocus} className="op-x" onClick={onClose} aria-label="Chiudi" data-op-close>✕</button>
        </div>

        <div className="op-body">
          {/* abilitazione al volo, senza uscire dal pannello */}
          {!isEnabled && (
            <div className="ex-banner is-warn op-mb">
              Questo mercato non è nel catalogo abilitato: il gate live-min rifiuterebbe l&apos;ordine.
              <button className="ex-btn is-sm op-inline" onClick={enableNow} disabled={enabling} data-op-enable>
                {enabling ? 'Abilito…' : 'Abilita ora'}
              </button>
            </div>
          )}
          {enableMsg && <div className="ex-banner op-mb" data-op-enable-msg>{enableMsg}</div>}

          {/* ── 2 · DATI DI MERCATO LIVE ──────────────────────────────────────────────────────── */}
          <div className="ex-stats op-mb" data-op-market-data>
            <div className="ex-stat"><span className="ex-stat-k">mid</span><span className="ex-stat-v">{cents(target.mid)}</span></div>
            <div className="ex-stat"><span className="ex-stat-k">bid</span><span className="ex-stat-v ex-up">{cents(target.bestBid)}</span></div>
            <div className="ex-stat"><span className="ex-stat-k">ask</span><span className="ex-stat-v ex-dn">{cents(target.bestAsk)}</span></div>
            <div className="ex-stat"><span className="ex-stat-k">spread</span><span className="ex-stat-v">{fin(target.spreadCents) ? `${target.spreadCents!.toFixed(1)}¢` : 'N/D'}</span></div>
            <div className="ex-stat"><span className="ex-stat-k">tick</span><span className="ex-stat-v">{target.tick ?? 'N/D'}</span></div>
            <div className="ex-stat"><span className="ex-stat-k">size min</span><span className="ex-stat-v">{target.minSize ?? 'N/D'}</span></div>
            {fin(target.maxSpreadCents) && (
              <div className="ex-stat"><span className="ex-stat-k">banda</span><span className="ex-stat-v">{target.maxSpreadCents!.toFixed(2)}¢</span></div>
            )}
            {fin(target.rewardsDailyRate) && (
              <div className="ex-stat"><span className="ex-stat-k">reward/g</span><span className="ex-stat-v ex-up">{money(target.rewardsDailyRate, 0)}</span></div>
            )}
          </div>

          {/* ── 3 · LATO ──────────────────────────────────────────────────────────────────────── */}
          <div className="op-field">
            <div className="op-label">Lato</div>
            <div className="op-seg" role="group" aria-label="Book">
              <button className={`op-segb ${book === 'yes' ? 'is-yes' : ''}`} onClick={() => setBook('yes')} data-op-book="yes">BUY YES</button>
              <button className={`op-segb ${book === 'no' ? 'is-no' : ''}`} onClick={() => setBook('no')} data-op-book="no">BUY NO</button>
            </div>
            {/* Onestà su cosa questo percorso può fare: una VENDITA consegna il token, quindi richiede di
                possederlo, e l'endpoint manuale non accetta il lato SELL. Comprare NO è il modo con cui
                un maker a collaterale offre l'altro lato. */}
            <div className="op-hint">
              Solo acquisti: una vendita consegna il token e richiede di possederlo. «BUY NO a q» è
              l&apos;equivalente di «vendi YES a 1−q».
            </div>
          </div>

          {/* ── 4 · SIZE ──────────────────────────────────────────────────────────────────────── */}
          <div className="op-field">
            <div className="op-label">
              Size (share)
              <span className="op-labelhint">
                min. premiante {target.minSize ?? 'N/D'}
                {fin(target.presetSize) ? ` · precompilata dal piano` : ''}
              </span>
            </div>
            <input className={`ex-input op-input ${problems.some((p) => p.key === 'minsize' || p.key === 'size') ? 'is-bad' : ''}`}
              type="number" inputMode="decimal" value={sizeStr} data-op-size
              onChange={(e) => { setSizeStr(e.target.value); setStep('form'); }} />
            {fin(target.minSize) && (
              <button className="ex-link op-fix" onClick={() => setSizeStr(String(target.minSize))} data-op-use-min>usa il minimo</button>
            )}
          </div>

          {/* ── 5 · PREZZO ────────────────────────────────────────────────────────────────────── */}
          <div className="op-field">
            <div className="op-label">
              Prezzo
              <span className="op-labelhint">tick {target.tick ?? 'N/D'} · mid {cents(target.mid)}</span>
            </div>
            <input className={`ex-input op-input ${problems.some((p) => p.key === 'tick' || p.key === 'price') ? 'is-bad' : ''}`}
              type="number" inputMode="decimal" step={target.tick ?? 0.01} value={priceStr} data-op-price
              onChange={(e) => { setPriceStr(e.target.value); setStep('form'); }} />
            {fin(target.tick) && fin(price) && !onTick(price, target.tick as number) && (
              <button className="ex-link op-fix" onClick={() => setPriceStr(String(snapToTick(price, target.tick as number)))} data-op-use-tick>
                usa {snapToTick(price, target.tick as number)}
              </button>
            )}
          </div>

          {/* ── 6 · DURATA ────────────────────────────────────────────────────────────────────── */}
          <div className="op-field">
            <div className="op-label">Durata</div>
            <div className="op-hint" data-op-ttl>
              GTD <b className="ex-n">{Math.round(ttlSeconds / 60)} min</b>
              {repriceOn && autoRenew ? (
                <> · <b>rinnovo automatico attivo</b>: si rinnova {Math.round((refreshMargin ?? 180) / 60)} minuti prima della scadenza</>
              ) : (
                <> · one-shot: nessun rinnovo, l&apos;ordine scade e basta</>
              )}
            </div>
            {repriceOn && (
              <label className="op-check">
                <input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} data-op-autorenew />
                <span>lascia il rinnovo automatico su questo ordine</span>
              </label>
            )}
          </div>

          {/* ── 7 · CONTROVALORE ──────────────────────────────────────────────────────────────── */}
          <div className="op-notional" data-op-notional>
            <span className="op-label">Controvalore</span>
            <span className="op-notional-v ex-n">{money(notional)}</span>
            {fin(cfg?.caps?.effectiveOrderCapUsd) && <span className="op-hint">tetto per ordine {money(cfg!.caps.effectiveOrderCapUsd)}</span>}
          </div>

          {/* ── 8 · AVVISI ────────────────────────────────────────────────────────────────────── */}
          {problems.length > 0 && (
            <div className="op-probs" data-op-problems>
              {problems.map((p) => (
                <p key={p.key} className={`ex-flag ${p.blocking ? 'is-bad' : ''}`} data-op-problem={p.key}>
                  <span className="ex-flag-i" aria-hidden="true">{p.blocking ? '⛔' : '⚠'}</span>
                  <span>{p.text}</span>
                </p>
              ))}
            </div>
          )}

          {/* ── 9 · RIEPILOGO ─────────────────────────────────────────────────────────────────── */}
          {step === 'review' && (
            <div className="op-review" data-op-review>
              <div className="op-review-h">Rivedi prima di confermare</div>
              <div className="ex-kvs">
                <div className="ex-kv"><span className="ex-kv-k">mercato</span><span className="ex-kv-v op-wrap">{target.title}</span></div>
                <div className="ex-kv"><span className="ex-kv-k">lato</span><span className="ex-kv-v">BUY {book.toUpperCase()}</span></div>
                <div className="ex-kv"><span className="ex-kv-k">size</span><span className="ex-kv-v">{size}</span></div>
                <div className="ex-kv"><span className="ex-kv-k">prezzo</span><span className="ex-kv-v">{price}</span></div>
                <div className="ex-kv"><span className="ex-kv-k">controvalore</span><span className="ex-kv-v">{money(notional)}</span></div>
                <div className="ex-kv"><span className="ex-kv-k">durata</span><span className="ex-kv-v">GTD {Math.round(ttlSeconds / 60)}m</span></div>
              </div>
            </div>
          )}

          {/* ── ESITO ─────────────────────────────────────────────────────────────────────────── */}
          {result && (
            <div className={`ex-banner ${result.ok ? (result.sent ? 'is-ok' : 'is-warn') : 'is-bad'} op-mb`} data-op-result>
              {result.ok ? (
                result.sent
                  ? <><b>ORDINE INVIATO AL VENUE.</b>{result.orderId ? <> orderId <span className="ex-n">{result.orderId}</span></> : null}</>
                  : <><b data-op-dryrun>DRY-RUN — nessun ordine reale piazzato.</b> L&apos;ordine è stato costruito, firmato e validato dal venue, poi scartato (placement={result.placement ?? 'dry-run'}).</>
              ) : (
                <><b>Rifiutato al gate {result.gate ?? '—'}</b>: {result.reason ?? '—'}</>
              )}
            </div>
          )}
        </div>

        {/* ── 10 · LE DUE AZIONI, in fondo e sempre visibili ───────────────────────────────────── */}
        <div className="op-actions">
          {step === 'form' ? (
            <button className="ex-btn is-gold op-primary" disabled={!canReview} onClick={() => setStep('review')} data-op-review-btn>
              Rivedi ordine
            </button>
          ) : (
            <>
              <button className="ex-btn op-back" onClick={() => setStep('form')} data-op-back>Modifica</button>
              <button
                className={`ex-btn op-primary ${sends ? 'is-danger' : 'is-gold'}`}
                disabled={busy || !canReview}
                onClick={place}
                data-op-confirm
                data-op-sends={sends ? '1' : '0'}
              >
                {busy ? 'Invio…' : sends ? 'Conferma e piazza — INVIA DAVVERO' : 'Conferma e piazza (dry-run)'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// NOTE: niente virgolette, angolari o e-commerciali in questo foglio — React li serializza diversi fra
// server e client dentro un tag style, e la differenza costa l idratazione dell intera pagina.
const CSS = `
.op-scrim { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.6);
  display: flex; align-items: flex-end; justify-content: center; backdrop-filter: blur(2px); }
.op-sheet { width: 100%; max-width: 560px; max-height: 92vh; display: flex; flex-direction: column;
  background: var(--ex-bg); border: 1px solid var(--ex-line); border-radius: 12px 12px 0 0;
  box-shadow: 0 -8px 40px rgba(0,0,0,.6); }
.op-head { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px;
  border-bottom: 1px solid var(--ex-line); }
.op-head-txt { min-width: 0; flex: 1 1 auto; }
.op-title { font-size: 14px; font-weight: 700; line-height: 1.3; overflow-wrap: anywhere; }
.op-sub { margin-top: 5px; font-size: 11px; color: var(--ex-txt-3); line-height: 1.9; overflow-wrap: anywhere; }
.op-id { margin-top: 4px; font-size: 9.5px; color: var(--ex-txt-3); word-break: break-all; }
.op-bdg { margin-left: 4px; }
.op-x { flex: 0 0 auto; width: 34px; height: 34px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--ex-line); background: var(--ex-panel-2); color: var(--ex-txt); font-size: 14px; }
.op-x:hover { border-color: var(--ex-gold); color: var(--ex-gold); }

.op-body { overflow-y: auto; padding: 12px 14px; flex: 1 1 auto; }
.op-mb { margin-bottom: 10px; }
.op-inline { margin-left: 8px; vertical-align: middle; }

.op-field { margin-bottom: 12px; }
.op-label { font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--ex-txt-3);
  display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.op-labelhint { text-transform: none; letter-spacing: 0; font-family: var(--ex-mono); }
.op-input { width: 100%; margin-top: 5px; }
.op-input.is-bad { border-color: var(--ex-red); background: rgba(246,70,93,.08); }
.op-fix { margin-top: 4px; font-size: 11px; }
.op-hint { font-size: 10.5px; color: var(--ex-txt-3); line-height: 1.5; margin-top: 5px; }
.op-check { display: flex; gap: 7px; align-items: center; margin-top: 7px; font-size: 11.5px; color: var(--ex-txt-2); }

.op-seg { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 6px; }
.op-segb { min-height: 46px; border-radius: 6px; cursor: pointer; font-family: var(--ex-mono);
  font-size: 13px; font-weight: 700; letter-spacing: .04em;
  border: 1px solid var(--ex-line); background: var(--ex-panel-2); color: var(--ex-txt-2); }
.op-segb.is-yes { background: var(--ex-green); border-color: var(--ex-green); color: #06251A; }
.op-segb.is-no { background: var(--ex-red); border-color: var(--ex-red); color: #fff; }

.op-notional { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  padding: 10px 12px; border: 1px solid var(--ex-line); border-radius: 8px;
  background: var(--ex-panel); margin: 12px 0; }
.op-notional-v { font-size: 20px; font-weight: 700; color: var(--ex-gold); }

.op-probs { margin: 10px 0; }
.op-review { border: 1px solid var(--ex-gold-bd); background: var(--ex-gold-bg);
  border-radius: 8px; padding: 11px 12px; margin: 10px 0; }
.op-review-h { font-size: 12px; font-weight: 700; color: var(--ex-gold); margin-bottom: 8px; }
.op-wrap { overflow-wrap: anywhere; }

.op-actions { display: flex; gap: 8px; padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--ex-line); background: var(--ex-panel); }
.op-actions .ex-btn { min-height: 48px; font-size: 14px; }
.op-primary { flex: 1 1 auto; }
.op-back { flex: 0 0 auto; }

@media (min-width: 620px) {
  .op-scrim { align-items: center; }
  .op-sheet { border-radius: 12px; }
}
`;
