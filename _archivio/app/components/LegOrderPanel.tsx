// Execution-order DRY-RUN panel — shared by the funding tab and the cash-and-carry tab.
//
// Extracted verbatim from app/dashboard/funding-arb/page.tsx so both surfaces render a
// dry-run identically: same wording, same evidence columns, same calm refusal. A slippage
// figure means nothing without its size, so the size is always rendered beside it.
//
// Typed structurally (not on either producer's interface) because lib/funding-leg-order
// and lib/basis-leg-order are separate modules with the same wire shape. Anything matching
// this shape renders; nothing here knows which lane it came from.
//
// PRESENTATION ONLY. It places nothing, computes nothing, and derives no number — every
// value shown is passed in already measured by the server-side dry-run.

export interface LegEvidenceView {
  id: string;
  side: 'buy' | 'sell';
  outcome: 'ranked' | 'impossible' | 'unknown';
  filledQty: number | null;
  topPrice: number | null;
  avgPrice: number | null;
  slippageBps: number | null;
  levelsWalked: number | null;
}

export interface LegOrderDryRunView {
  notionalUsd: number;
  qty: number | null;
  usable: boolean;
  executableAtSize: boolean;
  reason: string;
  firstLegId: string | null;
  ties: string[][];
  legs: LegEvidenceView[];
  ladderAgeMs: number | null;
}

const dash = (v: number | null | undefined, fmt: (n: number) => string) =>
  v == null || !Number.isFinite(v) ? '—' : fmt(v);

/** `unit` is the base unit the qty is denominated in — the coin for both lanes. */
export default function LegOrderPanel({ d, unit }: { d?: LegOrderDryRunView | null; unit: string }) {
  if (!d) return null;

  const sizeLabel = d.qty != null
    ? `$${d.notionalUsd.toLocaleString('en-US')} · ${d.qty.toFixed(4)} ${unit}`
    : `$${d.notionalUsd.toLocaleString('en-US')}`;

  return (
    <div data-legorder={d.usable ? 'ranked' : 'unusable'}
         className="rounded-card" style={{ border: '1px solid #eef1f5', background: '#fbfcfd', padding: 10 }}>
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <span className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: '0.12em', color: '#9aa5b3' }}>
          execution order · dry-run
        </span>
        {/* The size is load-bearing: a slippage number without its size is meaningless. */}
        <span className="font-mono tabular-nums" style={{ fontSize: 9.5, color: '#6b7787', whiteSpace: 'nowrap' }}>
          at {sizeLabel}
        </span>
      </div>

      {d.usable ? (
        <div className="font-body mt-1.5" style={{ fontSize: 11, color: '#334155' }}>
          would place <span className="font-mono font-semibold" style={{ color: '#0e1626' }}>{d.firstLegId}</span> first
          {!d.executableAtSize && <span style={{ color: '#9aa5b3' }}> · not fillable at this size</span>}
        </div>
      ) : (
        // Calm, not an error: we simply could not measure it.
        <div className="font-body mt-1.5" style={{ fontSize: 11, color: '#6b7787' }}>
          ordering unusable — {d.reason}
        </div>
      )}

      {/* Per-leg evidence. Always shown, even when the ordering is unusable, so the
          refusal is auditable. Stacks vertically → cannot overflow horizontally. */}
      <div className="flex flex-col gap-1 mt-2">
        {d.legs.map(l => (
          <div key={l.id} className="flex items-baseline justify-between gap-2 flex-wrap"
               style={{ fontSize: 10, minHeight: 22 }}>
            <span className="font-mono truncate" style={{ color: '#475569', minWidth: 0 }}>
              {l.id}
              {l.outcome === 'impossible' && <span style={{ color: '#9aa5b3' }}> · impossible at size</span>}
              {l.outcome === 'unknown'    && <span style={{ color: '#9aa5b3' }}> · not measurable</span>}
            </span>
            <span className="font-mono tabular-nums" style={{ color: '#6b7787', whiteSpace: 'nowrap' }}>
              top {dash(l.topPrice, v => String(v))} · avg {dash(l.avgPrice, v => v.toFixed(4))} ·{' '}
              {dash(l.slippageBps, v => v.toFixed(1))} bps · {dash(l.levelsWalked, v => String(v))} lvl
            </span>
          </div>
        ))}
      </div>

      {d.ties.length > 0 && (
        <div className="font-body mt-1" style={{ fontSize: 9.5, color: '#9aa5b3' }}>
          tie: {d.ties.map(t => t.join(' = ')).join(' · ')}
        </div>
      )}

      <div className="font-body mt-2" style={{ fontSize: 9, color: '#9aa5b3', lineHeight: 1.45 }}>
        {d.ladderAgeMs != null
          ? `The order we would place, computed from the book as it was ${Math.round(d.ladderAgeMs / 1000)}s ago.`
          : 'The order we would place, computed from the persisted order book.'}{' '}
        Nothing is submitted and no order is placed — the book moves, so this changes.
      </div>
    </div>
  );
}
