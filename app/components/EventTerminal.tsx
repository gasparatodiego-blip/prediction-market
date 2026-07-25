'use client';

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// EVENT TERMINAL — the per-market data terminal (/dashboard/liquidity-rewards/[marketId]/event).
//
// WHAT IT IS: a DECLARATION of everything the venue and the chain say about one market. Rules,
// identifiers, dates, the live book, the operator's own on-chain position, and what their configured
// two orders would literally be.
//
// WHAT IT IS NOT: advice. There is no recommended price, no "post here", no suggested size, no score
// telling the operator this market is good. Section H shows what the SAVED size/offset produce — it
// computes the operator's own inputs, it does not propose different ones.
//
// EVERY value is a real read or "—". Nothing is defaulted to zero, inferred from a sibling field, or
// carried over from a stale snapshot without its age. The band is stated as mid ± maxSpread/2 because
// that is the half-width the shared validator (lib/maker/venue-rules) actually enforces.
//
// READ-ONLY: this page loads no credential and can reach no order path.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Redacted } from './ui/Redacted';
import { computePriceRow } from '@/lib/reward-price-row';
import { validateQuotePair } from '@/lib/maker/venue-rules';
import { inBand } from '@/lib/rewards-live-band';

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** The one unknown-value glyph. Used everywhere a read failed or a field was absent. */
const D = <span className="evt-dash">—</span>;

const cents = (p: number, dp = 1) => `${(p * 100).toFixed(dp)}¢`;
const usd = (n: number, dp = 2) => `$${n.toFixed(dp)}`;
const int = (n: number) => Math.round(n).toLocaleString('it-IT');

/** Europe/Rome, always — the operator's clock, stated on screen so it is never ambiguous. */
const ROME = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome', day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
});
function romeTime(isoStr: string | null | undefined): string | null {
  if (!isoStr) return null;
  const t = Date.parse(isoStr);
  return Number.isFinite(t) ? ROME.format(new Date(t)) : null;
}

/** "3g 04h 21m" from real hours-to-resolution. null in ⇒ null out (never "0g 0h 0m"). */
function countdown(hours: number | null | undefined): string | null {
  if (!fin(hours) || hours <= 0) return null;
  const total = Math.floor(hours * 60);
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  return `${d}g ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`;
}

/** Truncated hex/id with copy-to-clipboard. Long values never widen the row on a phone. */
function Mono({ value, chars = 6 }: { value: string | null | undefined; chars?: number }) {
  const [copied, setCopied] = useState(false);
  if (!value) return D;
  const short = value.length > chars * 2 + 3 ? `${value.slice(0, chars)}…${value.slice(-chars)}` : value;
  return (
    <span className="evt-mono">
      <span className="evt-mono-v" title={value}>{short}</span>
      <button
        type="button" className="evt-copy" aria-label="copia"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }).catch(() => { /* clipboard blocked — the full value is in the title attribute */ });
        }}
      >{copied ? '✓' : '⧉'}</button>
    </span>
  );
}

/** One label/value row. `src` names the RAW venue field the value was read from (provenance). */
function KV({ k, src, children }: { k: string; src?: string | null; children: React.ReactNode }) {
  return (
    <div className="evt-kv">
      <span className="evt-k">
        {k}
        {src ? <span className="evt-src" title="campo grezzo da cui è letto">{src}</span> : null}
      </span>
      <span className="evt-v">{children}</span>
    </div>
  );
}

function Section({ id, n, title, sub, children }:
  { id: string; n: string; title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="evt-sec" id={id} data-evt-section={id}>
      <header className="evt-sec-h">
        <span className="evt-sec-n">{n}</span>
        <h2 className="evt-sec-t">{title}</h2>
      </header>
      {sub ? <p className="evt-sec-s">{sub}</p> : null}
      {children}
    </section>
  );
}

interface BookSide { bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }>; bestBid: number | null; bestAsk: number | null }
interface BookPayload {
  feedState: 'live' | 'stale' | 'rest-fallback';
  ageMs: number | null; reason: string; writerUp: boolean; writerAgeMs: number | null;
  yes: BookSide | null; no: BookSide | null;
  bestBid: number | null; bestAsk: number | null;
  scoringMid: number | null; scoringMidSource: string | null; plainMid: number | null;
  maxSpreadCents: number | null; bandRadiusCents: number | null; bandLo: number | null; bandHi: number | null;
  ladderCap: number; at: string; source: string;
}

export default function EventTerminal({ marketId }: { marketId: string }) {
  const [ev, setEv] = useState<any | null>(null);
  const [book, setBook] = useState<BookPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // The STICKY operator controls, shared verbatim with the board (same localStorage keys). The terminal
  // reads them; it never writes them, and it never proposes different ones.
  const [sizeInput, setSizeInput] = useState<string>('');
  const [distInput, setDistInput] = useState<string>('1');
  useEffect(() => {
    try {
      const s = localStorage.getItem('rw_size'); if (s != null) setSizeInput(s);
      const d = localStorage.getItem('rw_dist'); if (d != null) setDistInput(d);
    } catch { /* private mode — the section simply renders "—" */ }
  }, []);
  const totalSizeUsd = useMemo(() => {
    const n = Number(sizeInput);
    return sizeInput.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
  }, [sizeInput]);
  const offsetCents = useMemo(() => {
    const n = Number(distInput);
    return distInput.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
  }, [distInput]);

  const loadEvent = useCallback(async () => {
    try {
      const r = await fetch(`/api/rewards/event?marketId=${encodeURIComponent(marketId)}`, { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) { setErr(j?.error ?? `HTTP ${r.status}`); return; }
      setEv(j); setErr(null);
    } catch (e: any) { setErr(e?.message ?? 'fetch failed'); }
  }, [marketId]);

  useEffect(() => {
    loadEvent();
    const t = setInterval(loadEvent, 60_000);   // rules/dates/chain move slowly
    return () => clearInterval(t);
  }, [loadEvent]);

  // The book polls OUR OWN route, which is fed by agent34's CLOB WebSocket — the venue is not polled.
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch(`/api/rewards/event/book?marketId=${encodeURIComponent(marketId)}`, { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        if (alive) setBook(j);
      } catch { /* keep the previous book; its age label keeps ticking */ }
    }
    load();
    const t = setInterval(load, 2_000);
    return () => { alive = false; clearInterval(t); };
  }, [marketId]);

  const isPaid: boolean = ev?.isPaid ?? false;
  const feed = ev?.feed ?? null;
  const rules = ev?.rules ?? null;
  const dates = ev?.dates ?? null;
  const ids = ev?.identifiers ?? null;
  const raw = ev?.raw ?? null;
  const chain = ev?.chain ?? null;

  // ── Section H · the operator's two orders, from the SHARED price-row math (no second path) ──
  const pr = useMemo(() => computePriceRow({
    rewardScore: feed?.rewardScore ?? null,
    tick: fin(feed?.tickSize) ? feed.tickSize : null,
    totalSizeUsd, offsetCents, market: feed ?? undefined,
  }), [feed, totalSizeUsd, offsetCents]);

  const verdict = useMemo(() => {
    if (!fin(pr.buyYes) || !fin(pr.sellYes)) return null;
    const bidShares = pr.perSideUsd != null && pr.buyYes > 0 ? pr.perSideUsd / pr.buyYes : null;
    const askShares = pr.perSideUsd != null && pr.sellYes > 0 ? pr.perSideUsd / pr.sellYes : null;
    return validateQuotePair(
      { tick: pr.tick, scoringMid: pr.scoringMid, maxSpreadCents: pr.maxSpreadCents, minSize: pr.minSize },
      { side: 'BUY', price: pr.buyYes, size: bidShares as number },
      { side: 'SELL', price: pr.sellYes, size: askShares as number },
    );
  }, [pr]);

  // Would either leg cross the live book and execute as a TAKER? A maker bid at or above the best ask
  // lifts it; a maker ask at or below the best bid hits it. Unknown touch ⇒ unknown, never "no".
  const crossing = useMemo(() => {
    const bb = book?.bestBid ?? null, ba = book?.bestAsk ?? null;
    return {
      bid: fin(pr.buyYes) && fin(ba) ? pr.buyYes >= ba : null,
      ask: fin(pr.sellYes) && fin(bb) ? pr.sellYes <= bb : null,
    };
  }, [pr, book]);

  const title: string | null = ev ? (ev.groupItemTitle || ev.title || null) : null;
  const cd = countdown(ev?.hoursToResolution);

  if (err) {
    return (
      <div className="evt">
        <div className="evt-shell">
          <Link href="/dashboard/liquidity-rewards" className="evt-back">← elenco premi</Link>
          <p className="evt-err">Scheda non disponibile: {err}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="evt">
      <div className="evt-shell">
        <Link href="/dashboard/liquidity-rewards" className="evt-back">← elenco premi</Link>

        {/* ══ A · HEADER ═════════════════════════════════════════════════════════════════════ */}
        <header className="evt-head" data-evt-section="header">
          <div className="evt-head-tags">
            <span className="evt-tag">{ev?.venue ?? '—'}</span>
            <span className="evt-tag">{ev?.category ?? '—'}</span>
            <span className="evt-tag">
              neg-risk {rules?.negRisk === true ? 'sì' : rules?.negRisk === false ? 'no' : '—'}
            </span>
            {rules?.acceptingOrders === false && <span className="evt-tag is-warn">ordini non accettati</span>}
          </div>
          <h1 className="evt-title">{title ?? '—'}</h1>
          <div className="evt-head-cd">
            <span className="evt-k">alla chiusura</span>
            <span className="evt-cd">{cd ?? D}</span>
            <span className="evt-head-note">
              da hoursToResolution del feed · aggiornato con la scheda, non un cronometro
            </span>
          </div>
        </header>

        {/* ══ B · IDENTIFIERS ════════════════════════════════════════════════════════════════ */}
        <Section id="identifiers" n="B" title="Identificativi"
          sub="Le chiavi con cui questo mercato esiste sul venue e sulla catena. Tocca ⧉ per copiare il valore intero.">
          <div className="evt-rows">
            <KV k="slug mercato">{ids?.slug ? <span className="evt-wrap">{ids.slug}</span> : D}</KV>
            <KV k="slug evento">{ids?.eventSlug ? <span className="evt-wrap">{ids.eventSlug}</span> : D}</KV>
            <KV k="condition id"><Mono value={ids?.conditionId} /></KV>
            <KV k="question id"><Mono value={ids?.questionId} /></KV>
            <KV k="token YES"><Mono value={ids?.tokenIdYes} /></KV>
            <KV k="token NO"><Mono value={ids?.tokenIdNo} /></KV>
            {(ids?.contracts?.exchanges ?? []).map((x: any) => (
              <KV key={x.key} k={x.name}><Mono value={x.addr} /></KV>
            ))}
            <KV k="conditional tokens (ERC-1155)"><Mono value={ids?.contracts?.conditionalTokens} /></KV>
            <KV k={`collaterale · ${ids?.contracts?.collateral?.symbol ?? '—'}`}>
              <Mono value={ids?.contracts?.collateral?.addr} />
            </KV>
            <KV k="oracolo (resolvedBy)">
              {ids?.oracle?.addr
                ? <span className="evt-inline"><Mono value={ids.oracle.addr} />{ids.oracle.name ? <span className="evt-note-i">{ids.oracle.name}</span> : null}</span>
                : D}
            </KV>
            <KV k="fonte di risoluzione">{ids?.resolutionSource ? <span className="evt-wrap">{ids.resolutionSource}</span> : D}</KV>
          </div>
        </Section>

        {/* ══ C · DATES ══════════════════════════════════════════════════════════════════════ */}
        <Section id="dates" n="C" title="Date e orari" sub="Fuso Europe/Rome. Una data che il venue non pubblica resta «—»: non viene dedotta da un'altra.">
          <div className="evt-rows">
            <KV k="creato" src="gamma.createdAt">{romeTime(dates?.created) ?? D}</KV>
            <KV k="mercato aperto" src="gamma.startDate">{romeTime(dates?.opened) ?? D}</KV>
            <KV k="inizio premi" src="gamma.clobRewards[0].startDate">{romeTime(dates?.rewardStart) ?? D}</KV>
            <KV k="fine premi" src="gamma.clobRewards[0].endDate">{romeTime(dates?.rewardEnd) ?? D}</KV>
            <KV k="chiusura mercato" src="clob.end_date_iso">{romeTime(dates?.close) ?? D}</KV>
            <KV k="risoluzione attesa" src="gamma.umaEndDate">{romeTime(dates?.expectedResolution) ?? D}</KV>
            {dates?.gameStart && <KV k="inizio evento" src="clob.game_start_time">{romeTime(dates.gameStart)}</KV>}
          </div>
          <p className="evt-foot">
            Polymarket non pubblica un istante di «risoluzione attesa» distinto dalla chiusura: quando il
            campo manca resta «—», mai riempito con la data di chiusura.
          </p>
        </Section>

        {/* ══ D · VENUE RULES ════════════════════════════════════════════════════════════════ */}
        <Section id="rules" n="D" title="Regole del venue"
          sub="Lette dal mercato, non da una configurazione locale. Accanto a ogni valore c'è il campo grezzo da cui viene.">
          <div className="evt-rows">
            <KV k="tick" src="clob.minimum_tick_size">
              {fin(rules?.tickSize) ? <>{cents(rules.tickSize, 2)} <span className="evt-note-i">({rules.tickSize})</span></> : D}
            </KV>
            <KV k="prezzo minimo" src="= tick">{fin(rules?.priceMin) ? cents(rules.priceMin, 2) : D}</KV>
            <KV k="prezzo massimo" src="= 1 − tick">{fin(rules?.priceMax) ? cents(rules.priceMax, 2) : D}</KV>
            <KV k="ordine minimo" src="clob.minimum_order_size">
              {fin(rules?.minOrderSize) ? `${rules.minOrderSize} quote` : D}
            </KV>
            <KV k="size minima per il premio" src="clob.rewards.min_size">
              <Redacted value={fin(rules?.minIncentiveSize) ? rules.minIncentiveSize : null} isPaid={isPaid}>
                {(v) => <>{Number(v)} quote</>}
              </Redacted>
            </KV>
            <KV k="max_spread (banda intera)" src="clob.rewards.max_spread">
              <Redacted value={fin(rules?.maxSpreadCents) ? rules.maxSpreadCents : null} isPaid={isPaid}>
                {(v) => <>{Number(v)}¢</>}
              </Redacted>
            </KV>
            <KV k="montepremi" src="clob.rewards.rates[0].rewards_daily_rate">
              {fin(rules?.dailyPotUsd) ? `${usd(rules.dailyPotUsd, 0)}/giorno` : D}
            </KV>
            <KV k="fee maker / taker" src="clob.maker_base_fee / taker_base_fee">
              {fin(rules?.makerBaseFeeBps) && fin(rules?.takerBaseFeeBps)
                ? `${rules.makerBaseFeeBps} / ${rules.takerBaseFeeBps} bps` : D}
            </KV>
            <KV k="accetta ordini" src="clob.accepting_orders">
              {rules?.acceptingOrders === true ? 'sì' : rules?.acceptingOrders === false ? 'no' : D}
            </KV>
          </div>

          {/* The band — stated with its /2, because that /2 is what the validator enforces. */}
          <div className="evt-band">
            <span className="evt-band-t">Banda premiante effettiva</span>
            <span className="evt-band-f">
              punto medio di scoring <strong>±&nbsp;max_spread / 2</strong>
            </span>
            <span className="evt-band-v">
              <Redacted value={fin(rules?.bandRadiusCents) ? rules.bandRadiusCents : null} isPaid={isPaid}>
                {(v) => <>±{Number(v)}¢</>}
              </Redacted>
              {fin(book?.bandLo) && fin(book?.bandHi) ? (
                <span className="evt-band-range">{cents(book!.bandLo!)} … {cents(book!.bandHi!)}</span>
              ) : null}
            </span>
            <p className="evt-foot">
              Il <strong>/2</strong> non è una convenzione di questa pagina: il punteggio pubblicato usa
              v = max_spread/2 come semi-banda, ed è lo stesso raggio che il validatore condiviso applica.
              Un ordine esattamente sul bordo vale 0.
            </p>
            <p className="evt-foot">
              <strong>Distanza minima dal mid:</strong> nessuna regola ne impone una. Il limite è di
              mercato, non di regolamento: oltre il miglior prezzo opposto l&rsquo;ordine non riposa,
              viene eseguito subito e diventi <strong>taker</strong>.
            </p>
            <p className="evt-foot">
              <strong>Formula:</strong> quota quadratica S(v,s) = ((v−s)/v)², applicata ai due lati e presa
              al <strong>minimo</strong> (Q_min): la quotazione a due lati vale quanto il lato più debole.
            </p>
          </div>
        </Section>

        {/* ══ E · LIVE BOOK ══════════════════════════════════════════════════════════════════ */}
        <Section id="book" n="E" title="Book in tempo reale"
          sub="Lato YES. Il lato NO è il complemento: prezzo NO = 1 − prezzo YES.">
          <FeedBadge book={book} />
          <Ladder book={book} isPaid={isPaid} />
        </Section>

        {/* ══ F · REFERENCE PRICES ═══════════════════════════════════════════════════════════ */}
        <Section id="prices" n="F" title="Prezzi di riferimento"
          sub="Due punti medi diversi, e solo uno conta per i premi.">
          <div className="evt-rows">
            <KV k="miglior domanda (bid)">
              <Redacted value={book?.bestBid ?? null} isPaid={isPaid}>{(v) => <>{cents(Number(v))}</>}</Redacted>
            </KV>
            <KV k="miglior offerta (ask)">
              <Redacted value={book?.bestAsk ?? null} isPaid={isPaid}>{(v) => <>{cents(Number(v))}</>}</Redacted>
            </KV>
            <KV k="spread di mercato">
              <Redacted
                value={fin(book?.bestBid) && fin(book?.bestAsk) ? book!.bestAsk! - book!.bestBid! : null}
                isPaid={isPaid}
              >{(v) => <>{(Number(v) * 100).toFixed(2)}¢</>}</Redacted>
            </KV>
            <KV k="punto medio semplice (bid+ask)/2">
              <Redacted value={book?.plainMid ?? null} isPaid={isPaid}>
                {(v) => <span className="evt-ref">{cents(Number(v))} <span className="evt-note-i">solo riferimento</span></span>}
              </Redacted>
            </KV>
            <KV k="punto medio di scoring">
              <Redacted value={book?.scoringMid ?? null} isPaid={isPaid}>
                {(v) => (
                  <span className="evt-primary">
                    {cents(Number(v))}
                    <span className="evt-note-i">
                      {book?.scoringMidSource === 'ws-live' ? 'dal book live, taglio a size minima'
                        : book?.scoringMidSource === 'feed-snapshot' ? 'dallo snapshot del feed'
                        : ''}
                    </span>
                  </span>
                )}
              </Redacted>
            </KV>
            <KV k="intervallo della banda">
              {fin(book?.bandLo) && fin(book?.bandHi)
                ? <>{cents(book!.bandLo!)} … {cents(book!.bandHi!)}</>
                : <Redacted value={null} isPaid={isPaid}>{() => <>—</>}</Redacted>}
            </KV>
          </div>
          <p className="evt-foot">
            Il punto medio semplice è mostrato perché è quello che si legge sul venue, ma i premi non lo
            usano: il punteggio è centrato sul <strong>punto medio di scoring</strong>, che ignora gli
            ordini sotto la size minima. Quando i due divergono, è il secondo a contare.
          </p>
        </Section>

        {/* ══ G · pUSD ═══════════════════════════════════════════════════════════════════════ */}
        <Section id="pusd" n="G" title="pUSD — cosa è possibile"
          sub="Letture on-chain in sola lettura (eth_call). Nessuna chiave viene caricata da questa pagina.">
          {!chain ? (
            <p className="evt-foot">{ev?.chainWithheld ?? '—'}</p>
          ) : (
            <>
              <div className="evt-rows">
                <KV k="portafoglio">
                  {chain.wallet
                    ? <span className="evt-inline"><Mono value={chain.wallet} /><span className="evt-note-i">{chain.walletSource === 'env' ? 'da variabile d’ambiente' : 'da custodia'}</span></span>
                    : <span className="evt-inline">{D}<span className="evt-note-i">nessun portafoglio configurato</span></span>}
                </KV>
                <KV k="saldo pUSD">{fin(chain.pusdBalance) ? usd(chain.pusdBalance) : D}</KV>
                <KV k="bloccato da ordini aperti">
                  <span className="evt-inline">{D}<span className="evt-note-i">{chain.reservedReason}</span></span>
                </KV>
                <KV k="disponibile">
                  <span className="evt-inline">{D}<span className="evt-note-i">= saldo − bloccato: senza il bloccato non è calcolabile</span></span>
                </KV>
                <KV k="MATIC (gas per le approvazioni)">{fin(chain.maticBalance) ? chain.maticBalance.toFixed(4) : D}</KV>
                {(chain.approvals ?? []).map((a: any) => (
                  <KV key={a.key} k={`approvazione · ${a.name}`}>
                    <span className="evt-appr">
                      <span className={`evt-pill ${a.collateralAllowance == null ? '' : a.collateralAllowance > 0 ? 'is-ok' : 'is-no'}`}>
                        pUSD {a.collateralAllowance == null ? '—' : a.collateralAllowance > 0 ? 'approvato' : 'non approvato'}
                      </span>
                      <span className={`evt-pill ${a.outcomeApproved == null ? '' : a.outcomeApproved ? 'is-ok' : 'is-no'}`}>
                        token {a.outcomeApproved == null ? '—' : a.outcomeApproved ? 'approvato' : 'non approvato'}
                      </span>
                    </span>
                  </KV>
                ))}
                <KV k="token YES posseduti">{fin(chain.yesTokenBalance) ? int(chain.yesTokenBalance) : D}</KV>
                <KV k="token NO posseduti">{fin(chain.noTokenBalance) ? int(chain.noTokenBalance) : D}</KV>
              </div>
              <p className="evt-foot">
                Con i soli pUSD puoi immettere <strong>compra YES</strong> e <strong>compra NO</strong>.
                Non puoi immettere una <strong>vendita</strong> di un token che non possiedi: la vendita
                consegna il token, quindi richiede di averlo in saldo. Il collaterale viene
                <strong> riservato per ordine</strong>: la somma degli ordini aperti su questo mercato non
                può superare il disponibile.
              </p>
              <p className="evt-foot">
                Prima del finanziamento questi valori sono legittimamente $0,00 o «—». Un «—» significa
                «non letto», non «zero»: sono fatti diversi e questa pagina non li confonde.
              </p>
            </>
          )}
        </Section>

        {/* ══ H · YOUR TWO ORDERS ════════════════════════════════════════════════════════════ */}
        <Section id="orders" n="H" title="I tuoi due ordini"
          sub="Calcolati dalla size e dalla distanza salvate nell'elenco. Sono i tuoi parametri, non una proposta.">
          <div className="evt-rows">
            <KV k="size totale (dall'elenco)">{totalSizeUsd != null ? usd(totalSizeUsd, 0) : D}</KV>
            <KV k="distanza dal punto medio">{offsetCents != null ? `${offsetCents}¢` : D}</KV>
            <KV k="compra YES a">
              <Redacted value={fin(pr.buyYes) ? pr.buyYes : null} isPaid={isPaid}>{(v) => <>{cents(Number(v))}</>}</Redacted>
            </KV>
            <KV k="compra NO a">
              <Redacted value={fin(pr.buyNo) ? pr.buyNo : null} isPaid={isPaid}>
                {(v) => (
                  <span className="evt-inline">{cents(Number(v))}
                    <span className="evt-note-i">
                      ≡ vendi YES a {fin(pr.sellYes) ? cents(pr.sellYes) : '—'} — stesso ordine
                    </span>
                  </span>
                )}
              </Redacted>
            </KV>
            <KV k="entrambi dentro la banda">
              {verdict == null ? D
                : verdict.both ? <span className="evt-yes">sì</span>
                : <span className="evt-no">no — {verdict.note}</span>}
            </KV>
            <KV k="attraversa il book (taker)">
              {crossing.bid == null && crossing.ask == null ? D : (
                <span className="evt-inline">
                  <span className={crossing.bid ? 'evt-no' : 'evt-yes'}>
                    bid {crossing.bid == null ? '—' : crossing.bid ? 'sì' : 'no'}
                  </span>
                  <span className={crossing.ask ? 'evt-no' : 'evt-yes'}>
                    ask {crossing.ask == null ? '—' : crossing.ask ? 'sì' : 'no'}
                  </span>
                </span>
              )}
            </KV>
            <KV k="lordo atteso alla tua size">
              <Redacted value={fin(pr.grossPerDay) ? pr.grossPerDay : null} isPaid={isPaid}>
                {(v) => <span className="evt-primary">{usd(Number(v))}/giorno</span>}
              </Redacted>
            </KV>
            <KV k="tuo peso sulla profondità">
              {pr.ownImpactPct == null ? D
                : <span className={`evt-impact is-${pr.ownImpactBand}`}>
                    {pr.ownImpactPct < 100 ? pr.ownImpactPct.toFixed(1) : Math.round(pr.ownImpactPct)}%
                  </span>}
            </KV>
            <KV k="netto">
              <span className="evt-inline">{D}<span className="evt-note-i">adverse selection non modellata — il netto resta sconosciuto</span></span>
            </KV>
          </div>
          {verdict && verdict.reasons.length > 0 && (
            <ul className="evt-reasons">
              {verdict.reasons.map((r: any, i: number) => (
                <li key={i}><span className="evt-code">{r.code}</span> {r.detail}</li>
              ))}
            </ul>
          )}
        </Section>

        {/* Provenance — what each section was read from, so nothing on this page is unattributed. */}
        <footer className="evt-prov">
          <span className="evt-k">fonti</span>
          <span>feed: {ev?.sources?.feed ?? '—'}</span>
          <span>regole: {ev?.sources?.clob ?? '—'}</span>
          <span>date: {ev?.sources?.gamma ?? '—'}</span>
          <span>catena: {ev?.sources?.chain ?? '—'}</span>
          <span>book: {book?.source ?? '—'}</span>
          {raw ? <span className="evt-note-i">i valori mostrati riportano il campo grezzo di origine</span> : null}
        </footer>
      </div>
    </div>
  );
}

/** The liveness label. Never says "live" unless the socket actually drove this book. */
function FeedBadge({ book }: { book: BookPayload | null }) {
  if (!book) return <div className="evt-feed"><span className="evt-pill">—</span><span className="evt-note-i">book non ancora caricato</span></div>;
  const age = book.ageMs;
  const ageTxt = age == null ? '—' : age < 1000 ? `${age} ms` : `${(age / 1000).toFixed(1)} s`;
  const cls = book.feedState === 'live' ? 'is-live' : book.feedState === 'rest-fallback' ? 'is-rest' : 'is-stale';
  const label = book.feedState === 'live' ? 'LIVE · websocket'
    : book.feedState === 'rest-fallback' ? 'ISTANTANEA REST' : 'FERMO';
  return (
    <div className="evt-feed" data-feed-state={book.feedState}>
      <span className={`evt-pill ${cls}`}>{label}</span>
      <span className="evt-feed-age">età dato {ageTxt}</span>
      <span className="evt-note-i">{book.reason}</span>
    </div>
  );
}

/** Bid/ask ladders with depth bars; levels inside the reward band are marked. */
function Ladder({ book, isPaid }: { book: BookPayload | null; isPaid: boolean }) {
  const yes = book?.yes ?? null;
  if (!yes || (!yes.bids.length && !yes.asks.length)) {
    return (
      <div className="evt-ladder-empty">
        <Redacted value={null} isPaid={isPaid}>{() => <>—</>}</Redacted>
        <span className="evt-note-i">
          {isPaid ? 'nessun livello leggibile per questo mercato in questo momento' : 'book riservato'}
        </span>
      </div>
    );
  }
  const maxSize = Math.max(
    ...yes.bids.map((l) => l.size), ...yes.asks.map((l) => l.size), 1,
  );
  const mid = book?.scoringMid ?? null;
  const msc = book?.maxSpreadCents ?? null;
  // In-band test via the SSOT (lib/rewards-live-band.inBand) — never re-derived here.
  const marks = (p: number) => (mid != null && msc != null ? inBand(p, mid, msc) : null);

  const row = (l: { price: number; size: number }, side: 'bid' | 'ask') => {
    const ib = marks(l.price);
    return (
      <div key={`${side}-${l.price}`} className={`evt-lv is-${side} ${ib ? 'in-band' : ''}`}>
        <span className="evt-lv-bar" style={{ ['--w' as any]: `${(l.size / maxSize) * 100}%` }} />
        <span className="evt-lv-p">{cents(l.price)}</span>
        <span className="evt-lv-s">{int(l.size)}</span>
        <span className="evt-lv-b">{ib == null ? '' : ib ? 'in banda' : ''}</span>
      </div>
    );
  };

  return (
    <div className="evt-ladder">
      <div className="evt-lad-col">
        <div className="evt-lad-h"><span>domanda · YES</span><span>quote</span></div>
        {yes.bids.map((l) => row(l, 'bid'))}
        {!yes.bids.length && <div className="evt-lv is-empty">— nessuna domanda</div>}
      </div>
      <div className="evt-lad-mid">
        <span className="evt-k">punto medio di scoring</span>
        <span className="evt-lad-midv">
          <Redacted value={mid} isPaid={isPaid}>{(v) => <>{cents(Number(v))}</>}</Redacted>
        </span>
        {fin(book?.bandLo) && fin(book?.bandHi) && (
          <span className="evt-note-i">banda {cents(book!.bandLo!)} … {cents(book!.bandHi!)}</span>
        )}
      </div>
      <div className="evt-lad-col">
        <div className="evt-lad-h"><span>offerta · YES</span><span>quote</span></div>
        {yes.asks.map((l) => row(l, 'ask'))}
        {!yes.asks.length && <div className="evt-lv is-empty">— nessuna offerta</div>}
      </div>
      <p className="evt-foot evt-lad-foot">
        Mostrati i primi {book?.ladderCap ?? '—'} livelli per lato: il book può essere più profondo di
        così. Il lato NO non è un secondo grafico — il prezzo NO è 1 − prezzo YES sullo stesso livello.
      </p>
    </div>
  );
}
