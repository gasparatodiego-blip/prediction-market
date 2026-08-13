'use client';

// PriceLadder — one market's price geometry as a single horizontal bar.
//
// WHAT IT DRAWS, and nothing else:
//   • the REWARD BAND as a shaded region (mid ± maxSpread) — the zone that actually pays
//   • the scoring MID as the centre line
//   • best BID and best ASK as ticks on the track
//   • YOUR resting orders as dots, green when they are earning, red when they are not
//
// EVERY VALUE IS A PROP. This component computes no band, no mid and no verdict: it is handed the
// server's judgement (lib/maker/operator-board, which calls the shared lib/maker/venue-rules guard) and
// positions pixels. It cannot paint an order green that the server judged out of band, because it never
// evaluates the band itself.
//
// NO COLOUR-ONLY MEANING. Every dot carries a glyph (✓ in band / ✗ out / ? unjudged), every region has a
// text label under the track, and the whole geometry is restated in words underneath. A colour-blind
// operator, or one holding a phone in sunlight, gets the same information.
//
// UNKNOWN IS DRAWN AS UNKNOWN. Missing mid or missing band ⇒ no track is faked: the component says which
// piece is unreadable. A ladder with an invented band would be worse than no ladder.

export interface LadderOrder {
  orderId: string | null;
  /** Which book the order rests on. NO orders are mirrored onto the YES axis for drawing (a NO at q IS a
   *  YES at 1−q), and the label keeps saying NO @ q so the operator sees the price they typed. */
  book: 'yes' | 'no' | null;
  price: number | null;
  size: number | null;
  inBand: boolean | null;
  distanceCents: number | null;
  source?: string;
}

export interface PriceLadderProps {
  mid: number | null;
  bandLo: number | null;
  bandHi: number | null;
  bandRadiusCents: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  orders?: LadderOrder[];
  /** Compact drops the written restatement under the track (used inside dense list rows). */
  compact?: boolean;
  /** Optional label shown above the track. */
  caption?: string;
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const c = (p: number): string => `${(p * 100).toFixed(1)}¢`;

export default function PriceLadder({
  mid, bandLo, bandHi, bandRadiusCents, bestBid, bestAsk, orders = [], compact = false, caption,
}: PriceLadderProps) {
  if (!fin(mid) || !fin(bandLo) || !fin(bandHi)) {
    return (
      <div className="pl-root pl-unreadable" data-price-ladder="unreadable">
        <style>{LADDER_CSS}</style>
        <span className="pl-unreadable-t">
          Scala prezzi non disegnabile: {!fin(mid) ? 'mid di scoring' : 'banda premio'} non leggibile dal
          feed. Nessuna banda viene inventata.
        </span>
      </div>
    );
  }

  // Orders are drawn on the YES axis. A NO order at q is the same resting order as a YES at 1−q (see
  // lib/maker/canonical-position) — so it is mirrored to be positioned, and labelled with what was typed.
  const drawn = orders
    .filter((o) => fin(o.price))
    .map((o) => ({
      ...o,
      axisPrice: o.book === 'no' ? 1 - (o.price as number) : (o.price as number),
    }));

  // The visible window: always the whole band plus the touch, widened to include every order so an
  // out-of-band order is never clipped off the end of the track (the one case it most needs to be seen).
  const pts = [bandLo, bandHi, mid, ...(fin(bestBid) ? [bestBid] : []), ...(fin(bestAsk) ? [bestAsk] : []),
    ...drawn.map((o) => o.axisPrice)];
  const rawLo = Math.min(...pts);
  const rawHi = Math.max(...pts);
  const pad = Math.max((rawHi - rawLo) * 0.18, (bandHi - bandLo) * 0.4, 0.004);
  const lo = Math.max(0, rawLo - pad);
  const hi = Math.min(1, rawHi + pad);
  const span = hi - lo;
  const pct = (p: number): number => (span <= 0 ? 50 : Math.max(0, Math.min(100, ((p - lo) / span) * 100)));

  const bandLeft = pct(bandLo);
  const bandWidth = Math.max(pct(bandHi) - bandLeft, 0.6);

  return (
    <div className="pl-root" data-price-ladder="1">
      <style>{LADDER_CSS}</style>
      {caption && <div className="pl-cap">{caption}</div>}

      <div className="pl-track" role="img" aria-label={
        `Banda premio da ${c(bandLo)} a ${c(bandHi)}, mid ${c(mid)}. ` +
        (drawn.length ? `${drawn.length} tuoi ordini: ${drawn.filter((o) => o.inBand === true).length} in banda, ${drawn.filter((o) => o.inBand === false).length} fuori banda.` : 'nessun tuo ordine su questo mercato.')
      }>
        {/* the paying zone */}
        <div className="pl-band" style={{ left: `${bandLeft}%`, width: `${bandWidth}%` }} />
        {/* the touch */}
        {fin(bestBid) && <div className="pl-touch pl-bid" style={{ left: `${pct(bestBid)}%` }} />}
        {fin(bestAsk) && <div className="pl-touch pl-ask" style={{ left: `${pct(bestAsk)}%` }} />}
        {/* the scoring mid */}
        <div className="pl-mid" style={{ left: `${pct(mid)}%` }} />
        {/* your orders */}
        {drawn.map((o, i) => (
          <span
            key={o.orderId ?? `o${i}`}
            className={`pl-dot ${o.inBand === true ? 'pl-dot-in' : o.inBand === false ? 'pl-dot-out' : 'pl-dot-unk'}`}
            style={{ left: `${pct(o.axisPrice)}%` }}
            title={
              `${(o.book ?? '?').toUpperCase()} @ ${fin(o.price) ? c(o.price) : '—'}` +
              (fin(o.size) ? ` · ${o.size} share` : '') +
              (fin(o.distanceCents) ? ` · ${o.distanceCents.toFixed(2)}¢ dal mid` : '') +
              ` · ${o.inBand === true ? 'in banda (sta maturando)' : o.inBand === false ? 'FUORI banda (non matura nulla)' : 'banda non giudicabile'}`
            }
          >
            {o.inBand === true ? '✓' : o.inBand === false ? '✗' : '?'}
          </span>
        ))}
      </div>

      <div className="pl-scale">
        <span className="pl-num">{c(lo)}</span>
        <span className="pl-legend">
          <span className="pl-lg"><i className="pl-sw pl-sw-band" /> banda ±{fin(bandRadiusCents) ? bandRadiusCents.toFixed(2) : '—'}¢</span>
          <span className="pl-lg"><i className="pl-sw pl-sw-mid" /> mid {c(mid)}</span>
          {(fin(bestBid) || fin(bestAsk)) && (
            <span className="pl-lg"><i className="pl-sw pl-sw-touch" /> bid {fin(bestBid) ? c(bestBid) : '—'} / ask {fin(bestAsk) ? c(bestAsk) : '—'}</span>
          )}
        </span>
        <span className="pl-num">{c(hi)}</span>
      </div>

      {!compact && (
        <p className="pl-say">
          Paga solo dentro <b>{c(bandLo)} – {c(bandHi)}</b> (mid {c(mid)} ± {fin(bandRadiusCents) ? bandRadiusCents.toFixed(2) : '—'}¢).
          {drawn.length === 0
            ? ' Nessun tuo ordine a riposo su questo mercato.'
            : ` I tuoi ordini: ${drawn.filter((o) => o.inBand === true).length} in banda ✓, ${drawn.filter((o) => o.inBand === false).length} fuori banda ✗${drawn.some((o) => o.inBand === null) ? `, ${drawn.filter((o) => o.inBand === null).length} non giudicabili ?` : ''}.`}
        </p>
      )}
    </div>
  );
}

const LADDER_CSS = `
.pl-root { margin: 8px 0 4px; }
.pl-cap { font-size: 11px; color: #8B95A5; text-transform: uppercase; letter-spacing: .4px; margin-bottom: 6px; }
.pl-track { position: relative; height: 26px; border-radius: 6px; background: #0d1119;
  border: 1px solid #232937; overflow: visible; }
.pl-band { position: absolute; top: 0; bottom: 0; background: rgba(87,201,138,.17);
  border-left: 1px solid rgba(87,201,138,.55); border-right: 1px solid rgba(87,201,138,.55); }
.pl-mid { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: #DCE6FF; }
.pl-touch { position: absolute; top: 4px; bottom: 4px; width: 1px; background: #6E7889; }
.pl-bid { box-shadow: -2px 0 0 rgba(110,120,137,.35); }
.pl-ask { box-shadow: 2px 0 0 rgba(110,120,137,.35); }
.pl-dot { position: absolute; top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%;
  font-size: 10px; font-weight: 800; line-height: 16px; text-align: center; cursor: default; }
.pl-dot-in { color: #06210f; background: #57C98A; border: 1px solid #2f7d53; }
.pl-dot-out { color: #2a0b08; background: #E5574E; border: 1px solid #8d2a24; }
.pl-dot-unk { color: #1a1608; background: #E8B23A; border: 1px solid #7a5c15; }
.pl-scale { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 5px;
  font-size: 11px; color: #8B95A5; font-variant-numeric: tabular-nums; flex-wrap: wrap; }
.pl-legend { display: flex; gap: 4px 12px; flex-wrap: wrap; }
.pl-lg { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.pl-sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
.pl-sw-band { background: rgba(87,201,138,.35); border: 1px solid rgba(87,201,138,.7); }
.pl-sw-mid { width: 2px; height: 12px; border-radius: 0; background: #DCE6FF; }
.pl-sw-touch { width: 2px; height: 12px; border-radius: 0; background: #6E7889; }
.pl-num { white-space: nowrap; }
.pl-say { margin: 6px 0 0; font-size: 12px; color: #8B95A5; line-height: 1.5; }
.pl-unreadable { font-size: 12px; color: #E8B23A; line-height: 1.5; }
@media (max-width: 460px) {
  .pl-scale { font-size: 10px; }
  .pl-legend { order: 3; width: 100%; }
}
`;
