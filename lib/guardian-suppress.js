'use strict';
// lib/guardian-suppress.js — the ONE shared honest-engine SUPPRESSOR (rules A–E).
//
// FOUNDATIONAL PRINCIPLE (absolute): this module may SUPPRESS / HIDE / DOWNGRADE /
// RELABEL / REDACT a suspect number on the DISPLAY layer. It must NEVER rewrite a
// value toward a "corrected" number, and NEVER fabricate one. In doubt: suppress,
// alert, wait for a human fix. Better to show nothing than a wrong number.
//
// The single exception the task sanctions is rule D16 ("correct to the min") — a
// DETERMINISTIC clamp of a whole-trade capacity DOWN to the smaller of the two real
// leg depths already present on the row. That is not inventing a value; it is
// refusing to claim more executable size than the thinner leg actually shows. Every
// other rule only hides/downgrades/relabels/blanks.
//
// Why plain CommonJS (not TS): the serve path (TypeScript API routes) AND the
// background auditor agent26 (plain Node, no ts-node) must run the EXACT same rules
// so what the site suppresses is exactly what the auditor alerts on. Mirrors the
// established lib/contract-liveness.js + .d.ts sidecar pattern.
//
// HOW SUPPRESSION IS APPLIED (display-only, reversible, logged):
//   • The producer's /tmp + data/*.json files are NEVER written — this is read-only
//     on source. Only the in-memory served row copy is touched.
//   • Every field a rule blanks/clamps is first SNAPSHOTTED into row.__guardian.original
//     so the pre-suppression value is always recoverable (the proof source is intact).
//   • Each action is logged "guardian-suppress <section> <rowId> [<rule>]: <reason>"
//     (same shape as filterSane's sanity-reject line) so a human can review what was
//     hidden and why, and the auditor can watch for a spike.
//   • The >30% mass-suppression guardrail refuses to empty a tab: if a single cycle
//     would HIDE more than 30% of a tab's rows it keeps them all and raises a CRITICAL
//     signal instead (a systemic/false-positive smell, not 30% of rows truly broken).

const { APY_CAP } = (() => {
  try { return require('./honest-display'); } catch { return { APY_CAP: 200 }; }
})();

// ── Task-sanctioned thresholds ──────────────────────────────────────────────
const APY_HARD_MAX      = APY_CAP;   // 200 %/yr — over this, suppress the value (rule A1)
const APY_IMPOSSIBLE     = 1000;     // %/yr — over this, hide the row entirely (rule A2)
const CATEGORY_MULT      = 10;       // net > 10× category median ⇒ downgrade (rule A4)
const CASHABLE_SWING     = 0.50;     // cashable value swings > 50% cycle-to-cycle ⇒ suppress (rule A5)
const CROSS_SURFACE_TOL  = 0.05;     // landing vs tab #1 / list vs detail > 5% ⇒ flag/suppress (rules B6/B7)
const VENUE_DIVERGENCE   = 0.02;     // venue price > 2% from cross-venue median ⇒ flag (rule E22)
const MIN_DEPTH_USD      = 100_000;  // depth below this ⇒ speculative, never cashable (rule D19)
const MASS_SUPPRESS_FRAC = 0.30;     // > 30% of a tab hidden in one cycle ⇒ guardrail fires
const MASS_SUPPRESS_MIN  = 4;        // ...but only once a tab has at least this many rows
const STALE_MINUTES_MAX  = 20;       // data older than this ⇒ downgrade + real "stale" badge (rule C12)
const DIRECTIVES_FILE    = '/tmp/guardian-directives.json';
const DIRECTIVES_STALE_MS = 20 * 60_000;

// ── Phase 2 (rules F–K) thresholds — same honest-engine discipline: flag/hide/relabel/
// suppress on the DISPLAY, never rewrite a value toward a "corrected" number. ──────────
const MIN_ROUNDTRIP_FEE_FRAC = 0.0002;    // 0.02% — below this a round-trip taker fee is implausibly low (rule F25b)
const RUN_RATE_APR_MIN       = 50;        // %/yr — annualized above this must carry the run-rate caveat (rule G29)
const IMPOSSIBLE_BREAKEVEN   = 100 * 365; // days — a breakeven beyond ~100y (or negative) is broken math (rule G30)
const REFERENCE_ONLY_VENUES  = ['predictit', 'manifold']; // mid / reference lanes — never cashable (rule K42)
const SPOT_CLOSE_LEG_RE      = /(spot.*clos|clos.*spot|sell.*spot|spot.*sell)/i; // USD-settled carry close leg (F26)
const CAUTION_RE             = /\bCAUTION\b|⚠/i; // red "alarm" chip marker embedded in a verdict string (K41/K43)

// Calm, honest display labels (Italian — matches the existing "in verifica"/"non
// disponibile" UI vocabulary the task references).
const LABELS = {
  IN_VERIFICA:     'in verifica',      // value suppressed pending a human/source check
  NON_DISPONIBILE: 'non disponibile',  // capacity/price genuinely missing, not fabricated
  MONOLEG:         'monoleg',          // only one leg of a two-legged divergence funds
  SPECULATIVE:     'speculative',      // book too thin to call cashable
  STALE:           'stale',            // genuinely old data, demoted
  UNREACHABLE:     'unreachable',      // no verify adapter — honest, not a ✓
  RUN_RATE:        'run-rate, not guaranteed', // annualized shown as a run-rate, not a promise (rules G28/G29)
  SIGNAL_ONLY:     'signal-only',      // reference/mid-price lane — never cashable (rule K42)
  QUARANTINE:      'in quarantena',    // L44/L45 — suspiciously new/spiking, held until it stabilizes
  SUSPECT_UNIT:    'unità in verifica', // L46 — a value whose UNITS look wrong (×100 / %/8h-as-%/yr)
};

// ── Phase 3 (rules L–N) thresholds — spike / system-integrity. Same absolute
// principle: suppress / hold / relabel on the DISPLAY only; NEVER rewrite toward a
// "corrected" number, NEVER fabricate. In doubt → suppress (rule N50). ──────────
const SPIKE_MULT       = 5;   // L44 — a funding rate jumping > 5× its trailing in one cycle ⇒ hold
const UNIT_SUSPECT_LO  = 90;  // L46 — served/recomputed ratio in [90,110] ⇒ a ×100 unit error smell
const UNIT_SUSPECT_HI  = 110;

// ── Per-section config: names the fields each generic rule reads. Adding a tab is a
// config entry, not a new code path — this is what keeps it ONE shared suppressor.
const SECTION_CFG = {
  funding: {
    aprField: 'netApy30d', aprKind: 'annualPct',          // already %/yr
    grossField: 'grossApy',
    suppressFields: ['grossApy', 'netApy30d', 'totalFeesPct', 'breakevenDays'],
    depthField: 'capacityUsd',
    bookDepthField: 'greenCapacityUsd',                   // real slip-walked depth
    fundingLegs: ['frShort', 'frLong'],
    twoSidedNetFields: ['netApy30d', 'grossApy'],
    verifyDepthConfirmed: (r) => r.oneLegUnverified === false && r.greenCapacityUsd != null,
    hasVerify: true,
    // F–K descriptors (Phase 2):
    feeField: 'totalFeesPct', feeKind: 'pct',            // F25 — round-trip fee as %
    grossAprField: 'grossApy', netAprFields: ['netApy30d'], // F27 — net must be < gross once fees subtracted
    breakevenField: 'breakevenDays',                     // G30 — negative/impossible payback ⇒ hide
    verdictField: 'verdict',                             // K41/K43 — bare/contradictory CAUTION chip
  },
  'perp-spot': {
    aprField: 'edge.annualizedRunRatePct', aprKind: 'annualPct', aprCappedFlag: 'edge.annualizedCapped',
    netUsdField: 'edge.netPerDay1k',                      // $/day per $1k — the A3 "net"
    suppressFields: ['edge.grossPerDay1k', 'edge.netPerDay1k', 'edge.annualizedRunRatePct',
                     'edge.netAnnualizedOnCapitalPct', 'edge.breakevenDays'],
    depthField: 'wholeTradeCapacityUsd',
    legDepthFields: ['spotCapacityUsd', 'perpShortDepthUsd'],
    walkedFlag: 'perpDepthWalked',
    executableFlag: 'spotExecutable',
    bidField: 'spotBid', askField: 'spotAsk', midField: 'markPrice',
    fundingField: 'fundingPct8h',
    twoSidedNetFields: ['edge.netPerDay1k', 'edge.grossPerDay1k', 'edge.annualizedRunRatePct'],
    verifyDepthConfirmed: (r) => r.perpDepthWalked === true && r.wholeTradeCapacityUsd > 0,
    hasVerify: true,
    // F–K descriptors (Phase 2):
    feeParts: ['perpFeePct', 'spotFeePct'], feeKind: 'pct', // F25 — two per-leg taker fees summed
    breakevenField: 'edge.breakevenDays',                   // G30
  },
  basis: {
    aprField: 'netAnnualizedExecutable', aprKind: 'fraction', fallbackAprField: 'netAnnualized',
    suppressFields: ['netAnnualized', 'netAnnualizedExecutable', 'indicativeBasisPct',
                     'executableBasisPct', 'grossAnnualized', 'grossAnnualizedExec', 'basis'],
    depthField: 'capacityUsd',
    capacitySourceField: 'capacitySource',               // 'book' = real walk; else proxy/OI
    verifyDepthConfirmed: (r) => r.capacitySource === 'book' && r.capacityUsd > 0,
    hasVerify: true,
    // F–K descriptors (Phase 2):
    feeField: 'fee', feeKind: 'fraction', feeLegsField: 'feeLegs', // F25a/F25b understated fee
    coinMarginedField: 'coinMargined',                   // F26 (USD-settled = false) + K40 (coin-margined ⇒ not cashable)
    grossAprField: 'grossAnnualized', netAprFields: ['netAnnualized', 'netAnnualizedExecutable'], // F27
    verdictField: 'verdict',                             // K41/K43
  },
  rewards: {
    aprField: 'dayYieldPct', aprKind: 'dailyPctToAnnual', // *365
    suppressFields: ['dayYieldPct', 'estNetPerDay', 'grossRewardDay'],
    depthField: 'bookDepthAtBand',
    // A Polymarket rewards row's pool is an independently re-readable source field
    // (Gamma clobRewards.rewardsDailyRate) and its book depth is a REAL price×size
    // measurement — so a stray "verifying" on such a row is a false badge. enforceVerified
    // already resolves the common no-entry path; this is the defense-in-depth (C10 clears
    // it to 'confirmed' — no claim) so no rewards row can slip through on a permanent
    // "verifying…". Kalshi rows (derived pool, no adapter) never match and stay honest.
    verifyDepthConfirmed: (r) => r.venue === 'polymarket' && r.dailyPool != null && r.bookDepthAtBand != null,
    hasVerify: true,
  },
  sports: {
    netField: 'netMargin', aprField: null,               // one-time margin, not a rate
    suppressFields: ['netMargin', 'grossMargin'],
    staleFlag: 'isStale',
    hasVerify: false,
  },
  prediction: {
    aprField: 'roi', aprKind: 'oneTimePct',              // roi is a one-time %; A2/A4 only
    netField: 'roi',
    suppressFields: ['roi'],
    hasVerify: false,
    // F–K descriptors (Phase 2):
    linkLegs: ['lowMarket', 'highMarket'],               // I34/I35/I36 — each leg carries { url, urlVerified, platform }
    referenceVenues: REFERENCE_ONLY_VENUES,              // K42 — PredictIt/Manifold reference lanes
    cashableTypeField: 'type',                           // 'cashable' | 'signal' (K40/K42)
  },
};

// A row's PRIMARY value field(s): the headline number that makes the row useful.
// Blanking one of these (or hiding the row) REMOVES the opportunity — that counts
// toward the >30% mass-suppression guardrail. Blanking a SECONDARY field (e.g.
// capacity via D15/D17/D18) leaves the headline intact — the row is still useful,
// so it is a 'soft' action that never trips the guardrail (and never spams alerts).
const PRIMARY_FIELDS = {
  funding:    ['netApy30d', 'grossApy'],
  'perp-spot':['edge.netPerDay1k', 'edge.grossPerDay1k', 'edge.annualizedRunRatePct'],
  basis:      ['netAnnualized', 'netAnnualizedExecutable'],
  rewards:    ['dayYieldPct', 'estNetPerDay', 'grossRewardDay'],
  sports:     ['netMargin', 'grossMargin'],
  prediction: ['roi'],
};
// Classify one decision's impact: 'hide' (row removed), 'value' (headline number
// blanked), or 'soft' (relabel/downgrade/correct-min/flag or secondary-field blank).
function severityOf(section, d) {
  if (d.action === 'hide') return 'hide';
  if (d.action === 'suppress-value') {
    const primary = PRIMARY_FIELDS[section] || [];
    if ((d.fields || []).some((f) => primary.includes(f))) return 'value';
    return 'soft';
  }
  return 'soft';
}

// ── path helpers (support dotted 'edge.netPerDay1k') ────────────────────────
function getPath(obj, p) {
  if (!p) return undefined;
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, p, val) {
  const parts = p.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') return false;
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = val;
  return true;
}
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function median(nums) {
  const xs = (nums || []).filter(isNum).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

// rowId — MUST mirror lib/display-sanity.ts rowId()/verifyKey shapes so directives
// and cross-surface references line up across the suppressor and the auditor.
function rowId(section, row) {
  const r = row || {};
  switch (section) {
    case 'funding':    return `funding-${r.coin}-${r.shortExchange}-${r.longExchange}`;
    case 'perp-spot':  return `perp-spot-${r.coin}-${r.shortVenue}`;
    case 'usdc':       return `usdc-${r.coin}-${r.shortVenue}-${r.longVenue}`;
    case 'basis':      return `basis-${r.asset}-${r.exchange}-${r.contract}`;
    case 'rewards':    return `rewards-${r.marketId ?? r.market ?? r.id ?? '?'}`;
    case 'sports':     return `sports-${r.eventId ?? r.id ?? '?'}`;
    case 'prediction': return `prediction-${r.platform ?? '?'}-${r.id ?? r.marketId ?? '?'}`;
    default:           return String(r.id ?? '?');
  }
}

// impliedApr — normalize each section's rate field to a %/yr for A1/A2/A4.
function impliedApr(section, row) {
  const cfg = SECTION_CFG[section];
  if (!cfg || !cfg.aprField) return null;
  let v = getPath(row, cfg.aprField);
  if (!isNum(v) && cfg.fallbackAprField) v = getPath(row, cfg.fallbackAprField);
  if (!isNum(v)) return null;
  switch (cfg.aprKind) {
    case 'annualPct':        return v;
    case 'fraction':         return v * 100;
    case 'dailyPctToAnnual': return v * 365;
    case 'oneTimePct':       return v;          // treated as a magnitude for A2/A4, not annualized
    case 'per1kDaily':       return v / 1000 * 365 * 100;
    default:                 return v;
  }
}

// ── inspectRow: PURE. Returns an array of display-only decisions. No I/O, no mutation.
// decision = { rule, action, reason, fields?, label?, verifyStatus?, value?, path? }
// action ∈ 'hide' | 'downgrade' | 'suppress-value' | 'relabel' | 'correct-min' | 'flag'
function inspectRow(section, row, ctx = {}) {
  const cfg = SECTION_CFG[section];
  const out = [];
  if (!cfg || !row || typeof row !== 'object') return out;
  const now = ctx.now || 0;

  // ── Cross-cycle / cross-surface DIRECTIVES (rules A5, B6, B7, B8, B9, E23) ──
  // These need state the serve request doesn't have; agent26 detects them and writes
  // reversible directives keyed by rowId. Applying them here keeps ONE suppressor.
  // Directives now also carry the Phase-3 cross-cycle rules L44 (funding spike),
  // L45 (excluded→top quarantine) and L46 (suspect units) — each needs state the
  // serve request lacks (a trailing rate, last cycle's exclusion set, an independent
  // recompute), so agent26 computes them and writes a reversible, TTL-bounded
  // directive that this ONE shared suppressor applies. A directive may name its own
  // display label (e.g. LABELS.QUARANTINE / LABELS.SUSPECT_UNIT); default IN_VERIFICA.
  const id = rowId(section, row);
  const directive = ctx.directiveFor && ctx.directiveFor[`${section}:${id}`];
  if (directive) {
    const action = directive.action || 'suppress-value';
    out.push({
      rule: directive.rule || 'directive',
      action,
      reason: directive.reason || 'guardian directive',
      fields: action === 'suppress-value' ? (directive.fields || cfg.suppressFields) : undefined,
      label: directive.label || (action === 'suppress-value' ? LABELS.IN_VERIFICA : undefined),
    });
  }

  // ── E23: dead / dust contract (contract-liveness failed) → hide (phantom edgeX class)
  if (ctx.deadSet && (row.coin != null)) {
    const venue = row.shortVenue || row.shortExchange || row.exchange;
    if (venue && ctx.deadSet.has(`${venue}:${row.coin}`)) {
      out.push({ rule: 'E23', action: 'hide', reason: `dead/dust contract ${venue}:${row.coin} (contract-liveness failed)` });
    }
  }

  // ── A. Too-high / too-good ────────────────────────────────────────────────
  const apr = impliedApr(section, row);
  const cappedHonestly = cfg.aprCappedFlag && getPath(row, cfg.aprCappedFlag) === true;
  if (apr != null && cfg.aprKind !== 'oneTimePct') {
    // A2: implies an impossible APR (>1000%/yr) → hide the row.
    if (apr > APY_IMPOSSIBLE) {
      out.push({ rule: 'A2', action: 'hide', reason: `implies ${apr.toFixed(0)}%/yr (> ${APY_IMPOSSIBLE}% impossible)` });
    } else if (apr > APY_HARD_MAX && !cappedHonestly) {
      // A1: APR/annualized > 200% and NOT carrying the honest run-rate cap flag →
      // suppress the value, show "in verifica".
      out.push({ rule: 'A1', action: 'suppress-value', fields: cfg.suppressFields, label: LABELS.IN_VERIFICA,
        reason: `annualized ${apr.toFixed(0)}%/yr exceeds ${APY_HARD_MAX}% cap without run-rate label` });
    }
  } else if (apr != null && cfg.aprKind === 'oneTimePct' && apr > APY_IMPOSSIBLE) {
    // prediction/sports one-time margin that is itself absurd (> 1000%).
    out.push({ rule: 'A2', action: 'hide', reason: `one-time ${apr.toFixed(0)}% is impossible (> ${APY_IMPOSSIBLE}%)` });
  }

  // A3: a net $/day figure exceeding the row's own real book depth (the $1479-on-$42
  // case). Only where both a $ net and a $ depth live on the row (perp-spot, basis).
  if (cfg.netUsdField && cfg.depthField) {
    const net   = getPath(row, cfg.netUsdField);
    const depth = getPath(row, cfg.depthField);
    if (isNum(net) && net > 0 && isNum(depth) && depth > 0 && net > depth) {
      out.push({ rule: 'A3', action: 'suppress-value', fields: cfg.suppressFields, label: LABELS.IN_VERIFICA,
        reason: `net $${net.toFixed(2)}/day exceeds real book depth $${Math.round(depth)}` });
    }
  }

  // A4: net > 10× the median net of its category → downgrade + flag (ctx.categoryMedian).
  const netForMedian = cfg.netUsdField ? getPath(row, cfg.netUsdField)
                     : cfg.netField ? getPath(row, cfg.netField)
                     : apr;
  if (isNum(netForMedian) && isNum(ctx.categoryMedian) && ctx.categoryMedian > 0
      && netForMedian > CATEGORY_MULT * ctx.categoryMedian) {
    out.push({ rule: 'A4', action: 'downgrade', reason:
      `net ${netForMedian.toFixed(2)} is > ${CATEGORY_MULT}× the category median (${ctx.categoryMedian.toFixed(2)}) — outlier` });
  }

  // ── C. Verify / staleness ─────────────────────────────────────────────────
  const vs = row.__verify;
  if (cfg.hasVerify) {
    // C10/C11: stuck "verifying" while data is fresh AND backed by a real book →
    // clear the false verifying badge (relabel to 'confirmed', make no claim).
    if (vs && vs.status === 'verifying' && typeof cfg.verifyDepthConfirmed === 'function'
        && cfg.verifyDepthConfirmed(row)) {
      out.push({ rule: 'C10', action: 'relabel', verifyStatus: 'confirmed',
        reason: 'stuck "verifying" but real slip-walked book depth + legs confirmed — clearing false badge' });
    }
    // C12: genuinely old data → downgrade + real "stale" badge.
    const ageMs = isNum(vs && vs.ageMs) ? vs.ageMs
                : (isNum(row.updatedAt) ? now - row.updatedAt : null);
    if (isNum(ageMs) && ageMs > STALE_MINUTES_MAX * 60_000) {
      out.push({ rule: 'C12', action: 'downgrade', verifyStatus: 'stale', label: LABELS.STALE,
        reason: `data ${Math.round(ageMs / 60_000)} min old (> ${STALE_MINUTES_MAX} min) — demoted + stale badge` });
    }
    // C14: a source re-fetch that did NOT match the served value → suppress (backstop;
    // enforceVerified usually DROPS mismatches upstream, so this is defense-in-depth).
    if (vs && vs.status === 'mismatch') {
      out.push({ rule: 'C14', action: 'suppress-value', fields: cfg.suppressFields, label: LABELS.IN_VERIFICA,
        reason: 'source re-fetch does not match served value (mismatch) — suppressing pending human review' });
    }
  } else {
    // C13: a section with no verify adapter → honest "unreachable" badge, NOT "verified".
    // Non-destructive: the number stays, it simply carries no ✓.
    if (!vs) {
      out.push({ rule: 'C13', action: 'relabel', verifyStatus: 'unreachable', label: LABELS.UNREACHABLE,
        reason: 'no source-verify adapter for this section — honest "unreachable", not verified' });
    }
  }

  // ── D. Capacity / depth ───────────────────────────────────────────────────
  if (cfg.depthField) {
    const depth = getPath(row, cfg.depthField);

    // D16: whole-trade capacity > min(leg depths) → CORRECT to the min (deterministic,
    // safe clamp DOWN to a real depth — the one sanctioned correction). Do this before
    // the D17/D18/D19 reads so they see the clamped value.
    if (cfg.legDepthFields && cfg.legDepthFields.length) {
      const legs = cfg.legDepthFields.map((f) => getPath(row, f)).filter(isNum);
      if (isNum(depth) && legs.length === cfg.legDepthFields.length) {
        const minLeg = Math.min(...legs);
        if (depth > minLeg) {
          out.push({ rule: 'D16', action: 'correct-min', path: cfg.depthField, value: minLeg,
            reason: `whole-trade capacity $${Math.round(depth)} > min(leg depth) $${Math.round(minLeg)} — clamped down to the thinner leg` });
        }
      }
      // D18: a leg's book was unfetchable (null) → capacity must be null honest, never
      // carried from the other leg.
      const anyLegNull = cfg.legDepthFields.some((f) => getPath(row, f) == null);
      if (anyLegNull && depth != null) {
        out.push({ rule: 'D18', action: 'suppress-value', fields: [cfg.depthField], label: LABELS.NON_DISPONIBILE,
          reason: 'a leg order book was unfetchable — capacity cannot be claimed, showing non disponibile' });
      }
    }

    // D15: capacity sourced from OI / proxy instead of a real book-walk → suppress.
    const walkedFalse = cfg.walkedFlag && getPath(row, cfg.walkedFlag) === false && depth != null;
    const proxySource = cfg.capacitySourceField && depth != null
                        && getPath(row, cfg.capacitySourceField) != null
                        && getPath(row, cfg.capacitySourceField) !== 'book';
    if (walkedFalse || proxySource) {
      out.push({ rule: 'D15', action: 'suppress-value', fields: [cfg.depthField], label: LABELS.NON_DISPONIBILE,
        reason: 'capacity is OI/proxy-derived, not a real book-walk — showing non disponibile' });
    }

    // D17: capacity == $0 shown as "walked" → treat as missing book, non disponibile.
    if (isNum(depth) && depth === 0 && cfg.walkedFlag && getPath(row, cfg.walkedFlag) === true) {
      out.push({ rule: 'D17', action: 'suppress-value', fields: [cfg.depthField], label: LABELS.NON_DISPONIBILE,
        reason: 'capacity $0 marked "walked" — really a missing book, showing non disponibile' });
    }

    // D19: depth below the $100k minimum → verdict "speculative", never "cashable".
    if (isNum(depth) && depth > 0 && depth < MIN_DEPTH_USD) {
      out.push({ rule: 'D19', action: 'relabel', label: LABELS.SPECULATIVE, downgradeCashable: true,
        reason: `book depth $${Math.round(depth)} < $${MIN_DEPTH_USD} minimum — speculative, not cashable` });
    }
  }

  // ── E. Price / mid ────────────────────────────────────────────────────────
  if (cfg.executableFlag) {
    const executable = getPath(row, cfg.executableFlag) === true;
    const bid = cfg.bidField ? getPath(row, cfg.bidField) : null;
    const ask = cfg.askField ? getPath(row, cfg.askField) : null;
    // E21: marked "executable" but bid/ask is null → downgrade to non-executable.
    if (executable && (bid == null || ask == null)) {
      out.push({ rule: 'E21', action: 'relabel', set: { [cfg.executableFlag]: false },
        reason: 'marked executable but bid/ask is null — downgraded to non-executable' });
    }
    // E20: the only price left to display would be the mid (bid/ask absent, mid present)
    // → suppress the edge, mid is never cashable.
    if (executable && bid == null && ask == null && cfg.midField && getPath(row, cfg.midField) != null) {
      out.push({ rule: 'E20', action: 'suppress-value', fields: cfg.suppressFields, label: LABELS.IN_VERIFICA,
        reason: 'executable price would fall back to mid (no bid/ask) — mid is never cashable, suppressing' });
    }
  }

  // E22: a venue price diverging > 2% from the cross-venue median → flag (dirty data).
  // ctx.priceMedian is the median mark for THIS row's coin across venues (agent26 supplies
  // it; within a single served tab there is usually one row per coin so it is opt-in).
  if (cfg.midField && isNum(ctx.priceMedian) && ctx.priceMedian > 0) {
    const px = getPath(row, cfg.midField);
    if (isNum(px) && Math.abs(px - ctx.priceMedian) / ctx.priceMedian > VENUE_DIVERGENCE) {
      out.push({ rule: 'E22', action: 'flag',
        reason: `price ${px} diverges > ${(VENUE_DIVERGENCE * 100).toFixed(0)}% from cross-venue median ${ctx.priceMedian} — possible dirty data` });
    }
  }

  // E24: funding == 0 on one leg of a two-legged divergence → "monoleg", no two-sided net.
  if (cfg.fundingLegs && cfg.fundingLegs.length === 2) {
    const a = getPath(row, cfg.fundingLegs[0]);
    const b = getPath(row, cfg.fundingLegs[1]);
    if ((a === 0 || b === 0) && !(a === 0 && b === 0)) {
      out.push({ rule: 'E24', action: 'suppress-value', fields: cfg.twoSidedNetFields || cfg.suppressFields,
        label: LABELS.MONOLEG,
        reason: 'one funding leg is 0 — a two-sided net cannot be claimed, labelling monoleg' });
    }
  } else if (cfg.fundingField != null && !cfg.fundingLegs) {
    const f = getPath(row, cfg.fundingField);
    if (f === 0) {
      out.push({ rule: 'E24', action: 'suppress-value', fields: cfg.suppressFields, label: LABELS.MONOLEG,
        reason: 'the single funding leg is 0 — no carry to claim, labelling monoleg' });
    }
  }

  // ═══════════════════ PHASE 2 — RULES F–K (display-only) ═══════════════════════
  // Same absolute principle: flag / relabel / hide / suppress the DISPLAY only; never
  // rewrite a value toward a "corrected" number, never fabricate one.

  // ── F. Fees (flag / suppress, never rewrite) ──────────────────────────────
  // Normalize the row's round-trip fee to a fraction (0.001 = 0.1%) from whichever
  // shape the section carries (a single field or two per-leg parts).
  let feeFrac = null;
  if (cfg.feeField != null) {
    const raw = getPath(row, cfg.feeField);
    if (isNum(raw)) feeFrac = cfg.feeKind === 'pct' ? raw / 100 : raw;
  } else if (Array.isArray(cfg.feeParts)) {
    const parts = cfg.feeParts.map((f) => getPath(row, f)).filter(isNum);
    if (parts.length === cfg.feeParts.length) {
      const sum = parts.reduce((a, b) => a + b, 0);
      feeFrac = cfg.feeKind === 'pct' ? sum / 100 : sum;
    }
  }
  // F25a: the headline fee is LESS than the sum of the row's own disclosed legs → understated.
  if (cfg.feeLegsField && isNum(feeFrac)) {
    const legs = getPath(row, cfg.feeLegsField);
    if (Array.isArray(legs) && legs.length) {
      const legSum = legs.reduce((a, l) => a + (l && isNum(l.pct) ? l.pct : 0), 0);
      if (legSum > 0 && feeFrac < legSum * 0.999) {
        out.push({ rule: 'F25', action: 'flag',
          reason: `headline fee ${(feeFrac * 100).toFixed(3)}% is below the sum of its own disclosed legs ${(legSum * 100).toFixed(3)}% — understated fee inflates net` });
      }
    }
  }
  // F25b: a round-trip fee below the plausibility floor → flag (no real venue is ~0).
  if (isNum(feeFrac) && feeFrac > 0 && feeFrac < MIN_ROUNDTRIP_FEE_FRAC) {
    out.push({ rule: 'F25', action: 'flag',
      reason: `round-trip fee ${(feeFrac * 100).toFixed(4)}% is below the ${(MIN_ROUNDTRIP_FEE_FRAC * 100).toFixed(2)}% plausible venue minimum — understated fee` });
  }
  // F26: a USD-settled (coin-margined === false) cash&carry whose fee legs omit the
  // spot-close leg → incomplete round-trip cost.
  if (cfg.feeLegsField && cfg.coinMarginedField && getPath(row, cfg.coinMarginedField) === false) {
    const legs = getPath(row, cfg.feeLegsField);
    if (Array.isArray(legs) && legs.length
        && !legs.some((l) => l && typeof l.label === 'string' && SPOT_CLOSE_LEG_RE.test(l.label))) {
      out.push({ rule: 'F26', action: 'flag',
        reason: 'USD-settled carry fee legs do not include a spot-close leg — round-trip cost understated (incomplete)' });
    }
  }
  // F27: a net shown that is NOT below gross despite a real fee → fees were not subtracted;
  // suppress the net (the headline number) and alert.
  if (cfg.grossAprField && Array.isArray(cfg.netAprFields) && isNum(feeFrac) && feeFrac > 0) {
    const gross = getPath(row, cfg.grossAprField);
    const netPrimary = getPath(row, cfg.netAprFields[0]);
    if (isNum(gross) && isNum(netPrimary) && netPrimary >= gross - 1e-12) {
      const fields = cfg.netAprFields.filter((f) => getPath(row, f) != null);
      if (fields.length) {
        out.push({ rule: 'F27', action: 'suppress-value', fields, label: LABELS.IN_VERIFICA,
          reason: `net (${netPrimary}) is not below gross (${gross}) despite a ${(feeFrac * 100).toFixed(3)}% fee — fees not subtracted, suppressing net` });
      }
    }
  }

  // ── G. Annualized vs period (label / suppress) ────────────────────────────
  // G28/G29: an annualized figure that would read as a guaranteed return → attach the
  // honest "run-rate, not guaranteed" caveat (non-destructive; the number stays).
  if (apr != null && cfg.aprKind !== 'oneTimePct' && apr > RUN_RATE_APR_MIN && !cappedHonestly) {
    out.push({ rule: 'G29', action: 'relabel', runRate: true,
      reason: `annualized ${apr.toFixed(0)}%/yr shown without the real period return beside it — adding "run-rate, not guaranteed"` });
  }
  // G30: a payback/breakeven that is negative or impossible → suppress (hide) the row.
  if (cfg.breakevenField) {
    const be = getPath(row, cfg.breakevenField);
    if (isNum(be) && (be < 0 || be > IMPOSSIBLE_BREAKEVEN)) {
      out.push({ rule: 'G30', action: 'hide',
        reason: `breakeven ${be} days is ${be < 0 ? 'negative' : 'impossibly far'} — broken payback math, hiding row` });
    }
  }

  // ── I. Links / routing (hide the arrow, never fabricate) ──────────────────
  if (Array.isArray(cfg.linkLegs)) {
    for (const legKey of cfg.linkLegs) {
      const leg = row[legKey];
      if (!leg || typeof leg !== 'object' || leg.url == null) continue; // no link = already honest
      const urlPath = `${legKey}.url`;
      const url = leg.url;
      // I34: url present but unverified / not a real https link → hide the arrow.
      if (leg.urlVerified === false || !(typeof url === 'string' && /^https:\/\//i.test(url))) {
        out.push({ rule: 'I34', action: 'suppress-value', fields: [urlPath],
          reason: `deep-link for ${legKey} (${leg.platform ?? '?'}) is unverified/guessed — hiding the arrow` });
        continue;
      }
      // I35: a link the auditor probed to 404/403 (leg.urlHttpStatus set by agent26) → hide arrow.
      if (leg.urlHttpStatus === 403 || leg.urlHttpStatus === 404) {
        out.push({ rule: 'I35', action: 'suppress-value', fields: [urlPath],
          reason: `deep-link for ${legKey} returned ${leg.urlHttpStatus} — hiding the arrow` });
        continue;
      }
      // I36: leg routed to the wrong venue (platform token absent from the URL host) → suppress + flag.
      if (typeof leg.platform === 'string') {
        const host  = String(url).replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
        const token = leg.platform.toLowerCase().replace(/[^a-z]/g, '').slice(0, 6);
        if (token && host && !host.includes(token)) {
          out.push({ rule: 'I36', action: 'suppress-value', fields: [urlPath],
            reason: `${legKey} platform "${leg.platform}" routed to host "${host}" — wrong-venue link, suppressing` });
          out.push({ rule: 'I36', action: 'flag', reason: `${legKey} routed to the wrong venue (${leg.platform} → ${host})` });
        }
      }
    }
  }

  // ── K. Label / verdict consistency (fix the label, not the number) ────────
  // K40: a row explicitly MARKED cashable that is thin or coin-margined → speculative.
  {
    const markedCashable = (cfg.cashableTypeField && getPath(row, cfg.cashableTypeField) === 'cashable')
                        || getPath(row, 'cashable') === true;
    const coinM  = cfg.coinMarginedField && getPath(row, cfg.coinMarginedField) === true;
    const depthK = cfg.depthField ? getPath(row, cfg.depthField) : null;
    const thinK  = isNum(depthK) && depthK > 0 && depthK < MIN_DEPTH_USD;
    if (markedCashable && (coinM || thinK)) {
      out.push({ rule: 'K40', action: 'relabel', label: LABELS.SPECULATIVE, downgradeCashable: true,
        reason: `row marked cashable but ${coinM ? 'coin-margined' : `book too thin ($${Math.round(depthK)})`} — downgrading label to speculative` });
    }
  }
  // K42: a reference-only / mid-price lane (PredictIt, Manifold) marked cashable → signal-only.
  if (Array.isArray(cfg.referenceVenues) && cfg.cashableTypeField
      && getPath(row, cfg.cashableTypeField) === 'cashable' && Array.isArray(cfg.linkLegs)) {
    const refHit = cfg.linkLegs
      .map((k) => (row[k] && row[k].platform ? String(row[k].platform).toLowerCase() : null))
      .find((p) => p && cfg.referenceVenues.includes(p));
    if (refHit) {
      out.push({ rule: 'K42', action: 'relabel', label: LABELS.SIGNAL_ONLY, downgradeCashable: true, signalOnly: true,
        reason: `${refHit} is a reference/mid-price lane (no executable book) — forcing signal-only, not cashable` });
    }
  }
  // K41/K43: a red CAUTION chip embedded in the verdict that either states no reason (K41)
  // or sits on a row with no real risk (K43) → remove the contradictory chip (display-only).
  if (cfg.verdictField) {
    const verdict = getPath(row, cfg.verdictField);
    if (typeof verdict === 'string' && CAUTION_RE.test(verdict)) {
      const bareCaution = /^[\s⚠️]*CAUTION[\s.!:—-]*$/i.test(verdict.trim());
      const depthV = cfg.depthField ? getPath(row, cfg.depthField) : null;
      const vs2 = row.__verify;
      const noRealRisk = (!isNum(depthV) || depthV >= MIN_DEPTH_USD)
        && !(vs2 && (vs2.status === 'stale' || vs2.status === 'mismatch' || vs2.status === 'verifying'))
        && row.oneLegUnverified !== true && row.thinFlag !== true;
      if (bareCaution) {
        out.push({ rule: 'K41', action: 'relabel', removeCautionChip: true,
          reason: 'verdict shows a bare CAUTION chip with no stated reason — removing the contradictory chip' });
      } else if (noRealRisk) {
        out.push({ rule: 'K43', action: 'relabel', removeCautionChip: true,
          reason: 'CAUTION chip on a row with no thin-book / stale / unverified risk — downgrading to neutral' });
      }
    }
  }

  // ── N. Meta ───────────────────────────────────────────────────────────────
  // N50 — IN DOUBT, SUPPRESS. This is the DEFAULT fallthrough for any invariant
  // violation the specific rules above could not classify into a concrete action:
  // agent26 (which can see cross-cycle / cross-surface state) marks such a row in
  // ctx.unclassified (a Set of `${section}:${id}`), and here we SUPPRESS its headline
  // value rather than invent a "presumed correct" number. Never fabricate; better to
  // show nothing than a value we cannot vouch for.
  if (ctx.unclassified && ctx.unclassified.has(`${section}:${id}`)
      && !out.some((d) => d.action === 'hide' || d.action === 'suppress-value')) {
    out.push({ rule: 'N50', action: 'suppress-value', fields: cfg.suppressFields, label: LABELS.IN_VERIFICA,
      reason: 'unclassified honest-engine violation flagged by the auditor — suppressing (in doubt, suppress; never invent a value)' });
  }

  // Tag each decision's severity so the guardrail counts only info-removing actions
  // (hide / primary-value blank) and never trips on soft relabels or secondary-field
  // suppressions (e.g. capacity), which keep the row's headline number usable.
  for (const d of out) d.severity = severityOf(section, d);
  return out;
}

// ── Apply one decision to the DISPLAY of a row (mutates the in-memory copy only). ──
// Every changed field is snapshotted into row.__guardian.original first, so the
// pre-suppression value is always recoverable — proof that source is untouched.
function ensureGuardian(row) {
  if (!row.__guardian) row.__guardian = { actions: [], original: {}, suppressedFields: [] };
  return row.__guardian;
}
function snapshot(row, path) {
  const g = ensureGuardian(row);
  if (!(path in g.original)) g.original[path] = getPath(row, path);
}
function applyDecision(row, d) {
  const g = ensureGuardian(row);
  g.actions.push({ rule: d.rule, action: d.action, reason: d.reason });
  switch (d.action) {
    case 'suppress-value':
      for (const f of d.fields || []) {
        if (getPath(row, f) == null) continue;   // nothing to suppress
        snapshot(row, f);
        setPath(row, f, null);
        if (!g.suppressedFields.includes(f)) g.suppressedFields.push(f);
      }
      if (d.label) g.label = d.label;
      break;
    case 'correct-min':
      snapshot(row, d.path);
      setPath(row, d.path, d.value);
      g.corrected = true;
      break;
    case 'relabel':
      if (d.label) g.label = d.label;
      if (d.set) for (const [k, v] of Object.entries(d.set)) { snapshot(row, k); setPath(row, k, v); }
      if (d.downgradeCashable) g.downgradeCashable = true;
      if (d.runRate) g.runRate = true;                 // G28/G29 — annualized carries the run-rate caveat
      if (d.signalOnly) g.signalOnly = true;           // K42 — reference lane, never cashable
      if (d.removeCautionChip) g.removeCautionChip = true; // K41/K43 — drop the contradictory alarm chip
      if (d.verifyStatus) {
        if (!row.__verify) row.__verify = {};
        else snapshot(row, '__verify.status');
        row.__verify.status = d.verifyStatus;
      }
      break;
    case 'downgrade':
      g.downgraded = true;
      if (d.label) g.label = d.label;
      if (d.verifyStatus) {
        if (!row.__verify) row.__verify = {};
        row.__verify.status = d.verifyStatus;
      }
      break;
    case 'flag':
      g.flag = true;
      if (!g.flags) g.flags = [];
      g.flags.push(d.reason);
      break;
    // 'hide' is handled by applyGuardian (row removal); nothing to mutate.
  }
}

// ── readDirectives: agent26 → serve-path channel for cross-cycle/cross-surface rules.
// Reversible (delete the file to clear), stale-guarded (calm), never fabricated.
function readDirectives(now, file = DIRECTIVES_FILE) {
  let parsed = null;
  try { parsed = JSON.parse(require('fs').readFileSync(file, 'utf8')); } catch { return {}; }
  if (!parsed || !Array.isArray(parsed.directives)) return {};
  if (!isNum(parsed.updatedAt) || now - parsed.updatedAt > DIRECTIVES_STALE_MS) return {};
  const map = {};
  for (const d of parsed.directives) {
    if (!d || !d.section || !d.rowId) continue;
    if (isNum(d.expiresAt) && d.expiresAt < now) continue;
    map[`${d.section}:${d.rowId}`] = d;
  }
  return map;
}

// ── applyGuardian: the shared entry point every tab route calls after enforceVerified.
// Returns { rows, suppressions, critical } — display-only, logged, guardrailed.
function applyGuardian(section, rows, ctx = {}) {
  if (!Array.isArray(rows) || !rows.length) return { rows: Array.isArray(rows) ? rows : [], suppressions: [], critical: null };
  const cfg = SECTION_CFG[section] || {};
  const now = ctx.now || (typeof ctx.nowFn === 'function' ? ctx.nowFn() : 0);
  const log = ctx.log || ((m) => console.log(m));

  // Cross-cycle/cross-surface directives (opt-in; empty on the serve path if no file).
  const directiveFor = ctx.directiveFor || (ctx.noDirectives ? {} : readDirectives(now));

  // Category median for A4 (over the field the section ranks by).
  const medField = cfg.netUsdField || cfg.netField || cfg.aprField;
  const categoryMedian = medField
    ? median(rows.map((r) => (cfg.aprField && medField === cfg.aprField ? impliedApr(section, r) : getPath(r, medField))))
    : null;

  const rowCtx = { now, directiveFor, categoryMedian, deadSet: ctx.deadSet, priceMedian: ctx.priceMedian,
    unclassified: ctx.unclassified };

  const suppressions = [];
  const perRow = [];          // {row, id, decisions, removesInfo}
  let removesInfoCount = 0;   // rows whose HEADLINE would be removed (hide or primary-value)

  for (const row of rows) {
    const id = rowId(section, row);
    const decisions = inspectRow(section, row, rowCtx);
    // "Removes info" = the row would be HIDDEN or its PRIMARY value blanked. Soft
    // relabels / downgrades / secondary-field (capacity) blanks keep the headline and
    // never count toward the guardrail (else a normal 70%-proxy-capacity basis board,
    // or a no-verify-adapter sports board, would falsely read as mass-suppressed).
    const removesInfo = decisions.some((d) => d.severity === 'hide' || d.severity === 'value');
    if (removesInfo) removesInfoCount++;
    perRow.push({ row, id, decisions, removesInfo });
  }

  // ── >30% mass-suppression guardrail: refuse to gut a tab. ──────────────────
  const total = rows.length;
  const massSuppress = total >= MASS_SUPPRESS_MIN && (removesInfoCount / total) > MASS_SUPPRESS_FRAC;
  let critical = null;
  if (massSuppress) {
    critical = { type: 'mass-suppress', section, wouldHide: removesInfoCount, total,
      reason: `guardian would remove the value from ${removesInfoCount}/${total} rows (> ${(MASS_SUPPRESS_FRAC * 100)}%) — likely a systemic/false-positive issue, NOT ${Math.round(MASS_SUPPRESS_FRAC * 100)}% of rows genuinely broken. Keeping all values; raising CRITICAL instead of mass-suppressing.` };
    log(`guardian-CRITICAL ${section}: ${critical.reason}`);
  }

  const kept = [];
  const demoted = [];
  const ruleCounts = {};
  let acted = 0;
  for (const { row, id, decisions } of perRow) {
    // A HIDE dominates: the row is removed as-is, so no other display mutation is
    // applied to it (keeps the invariant crisp — a dropped row is left untouched).
    const hideDecision = decisions.find((d) => d.action === 'hide');
    if (hideDecision && !massSuppress) {
      suppressions.push({ section, rowId: id, rule: hideDecision.rule, action: 'hide', severity: 'hide', reason: hideDecision.reason, timestamp: now });
      ruleCounts[hideDecision.rule] = (ruleCounts[hideDecision.rule] || 0) + 1;
      acted++;
      // Log each info-removing action individually so a human can review WHAT was
      // hidden and WHY (these are rare under normal operation).
      log(`guardian-suppress ${section} ${id} [${hideDecision.rule}]: ${hideDecision.reason}`);
      continue;                                // removed
    }
    // Under the guardrail, keep the PRIMARY value visible: skip the info-removing
    // decisions (hide + primary-value), still apply soft relabels/downgrades. Calm
    // degrade beats a gutted board.
    let effective = decisions.filter((d) => d.action !== 'hide');
    if (massSuppress) effective = effective.filter((d) => d.severity === 'soft');

    if (effective.length) { acted++; }
    for (const d of effective) {
      applyDecision(row, d);
      suppressions.push({ section, rowId: id, rule: d.rule, action: d.action, severity: d.severity, reason: d.reason, timestamp: now });
      ruleCounts[d.rule] = (ruleCounts[d.rule] || 0) + 1;
      // Info-removing actions (primary-value blanks) are logged per-row for review;
      // soft actions are only summarized (below) to avoid per-request log spam.
      if (d.severity === 'value') log(`guardian-suppress ${section} ${id} [${d.rule}]: ${d.reason}`);
    }
    if (row.__guardian && row.__guardian.downgraded) demoted.push(row);
    else kept.push(row);
  }

  // One compact summary line per call (reviewable, low-volume — does NOT grow the
  // per-action log with routine soft relabels). agent26 alerts on guardian-CRITICAL
  // only; this line is for humans scanning the log.
  if (acted > 0) log(`guardian ${section}: acted ${acted}/${total} rows ${JSON.stringify(ruleCounts)}`);

  const finalRows = kept.concat(demoted);

  // ── J. Zero / empty state (calm, honest) ──────────────────────────────────
  // J37/J38: expose WHY a tab is empty so the UI renders a calm zero-state (never a
  // teaser). 'redacted' (values gated, rows existed) vs 'no-data' (genuinely nothing) is
  // the route's to decide — it knows isPaid; it passes ctx.emptyReason. Default honest 'no-data'.
  const zeroState = finalRows.length === 0
    ? { empty: true, reason: ctx.emptyReason === 'redacted' ? 'redacted' : 'no-data' }
    : null;

  // J39: a claimed headline cashable count that disagrees with the rows actually cashable
  // after suppression → align the label (raise CRITICAL, do NOT silently mismatch).
  const criticals = [];
  if (isNum(ctx.claimedCashable)) {
    const actualCashable = finalRows.filter((r) =>
      !(r.__guardian && r.__guardian.downgradeCashable)
      && (cfg.cashableTypeField ? getPath(r, cfg.cashableTypeField) === 'cashable' : true)).length;
    if (actualCashable !== ctx.claimedCashable) {
      const c = { type: 'count-mismatch', section, wouldHide: 0, total: finalRows.length,
        reason: `header claims ${ctx.claimedCashable} cashable but ${actualCashable} rows are cashable after suppression — align the count` };
      criticals.push(c);
      log(`guardian-CRITICAL ${section}: ${c.reason}`);
    }
  }

  return { rows: finalRows, suppressions, critical, zeroState, criticals };
}

// ── H (rules 31–33): paid-gating leak backstop — the one section-agnostic guardian pass.
// Given an ALREADY-redacted free-tier payload and the route's sensitive-field paths (the
// SAME paid-gating grammar as lib/paid-gating REDACTION_MAP: dot segments, `[]` iterates an
// array, `{}` iterates object values), it NULLS any sensitive field that survived redaction
// (a paid value leaking to the free tier — rules 31/32/33) and raises a CRITICAL. It only
// ever sets a leaked field to null — never fabricates, never rewrites. No-op for paid users.
function parseRedactSeg(raw) {
  const m = String(raw).match(/^([a-zA-Z0-9_]+)((?:\[\]|\{\})*)$/);
  if (!m) return null;
  return { key: m[1], wildcards: (m[2].match(/\[\]|\{\}/g) || []) };
}
function walkRedact(node, segs, onLeak) {
  if (node == null || typeof node !== 'object') return;
  const seg = segs[0];
  if (!seg) return;
  const rest = segs.slice(1);
  const descend = (child, wc) => {
    if (wc.length) {
      const [w, ...restW] = wc;
      if (w === '[]' && Array.isArray(child)) for (const it of child) descend(it, restW);
      else if (w === '{}' && child && typeof child === 'object') for (const v of Object.values(child)) descend(v, restW);
      return;
    }
    if (rest.length) { walkRedact(child, rest, onLeak); return; }
    // leaf reached — if it survived redaction non-null on the free tier, it leaked.
    // (child is the container here; we handle the leaf on the parent below)
  };
  if (!(seg.key in node)) return;
  if (seg.wildcards.length === 0 && rest.length === 0) {
    if (node[seg.key] != null) { node[seg.key] = null; onLeak(seg.key); } // leaf null-out
    return;
  }
  descend(node[seg.key], seg.wildcards);
}
function assertRedacted(payload, sensitivePaths, opts = {}) {
  const log = opts.log || ((m) => console.log(m));
  const leaks = [];
  if (payload && typeof payload === 'object' && Array.isArray(sensitivePaths)) {
    for (const p of sensitivePaths) {
      const segs = String(p).split('.').map(parseRedactSeg);
      if (segs.some((s) => s == null)) continue;      // unparseable path — skip, never throw on serve
      walkRedact(payload, segs, () => leaks.push(p));
    }
  }
  let critical = null;
  if (leaks.length) {
    const uniq = Array.from(new Set(leaks));
    critical = { type: 'paid-leak', section: 'paid-gating', wouldHide: uniq.length, total: uniq.length,
      reason: `${uniq.length} derived-edge field(s) survived redaction and leaked to the free tier — suppressed to null` };
    // guardian-CRITICAL line so agent26's auditGuardianLog() surfaces it as a Telegram alert.
    log(`guardian-CRITICAL paid-gating: ${critical.reason} [${uniq.slice(0, 8).join(', ')}]`);
  }
  return { leaks, critical };
}

module.exports = {
  applyGuardian, inspectRow, applyDecision, rowId, impliedApr, median,
  readDirectives, getPath, setPath, assertRedacted,
  SECTION_CFG, LABELS,
  APY_HARD_MAX, APY_IMPOSSIBLE, CATEGORY_MULT, MIN_DEPTH_USD,
  MASS_SUPPRESS_FRAC, MASS_SUPPRESS_MIN, STALE_MINUTES_MAX, CASHABLE_SWING, CROSS_SURFACE_TOL,
  MIN_ROUNDTRIP_FEE_FRAC, RUN_RATE_APR_MIN, IMPOSSIBLE_BREAKEVEN, REFERENCE_ONLY_VENUES,
  SPIKE_MULT, UNIT_SUSPECT_LO, UNIT_SUSPECT_HI,
  DIRECTIVES_FILE,
};
