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

// Calm, honest display labels (Italian — matches the existing "in verifica"/"non
// disponibile" UI vocabulary the task references).
const LABELS = {
  IN_VERIFICA:     'in verifica',      // value suppressed pending a human/source check
  NON_DISPONIBILE: 'non disponibile',  // capacity/price genuinely missing, not fabricated
  MONOLEG:         'monoleg',          // only one leg of a two-legged divergence funds
  SPECULATIVE:     'speculative',      // book too thin to call cashable
  STALE:           'stale',            // genuinely old data, demoted
  UNREACHABLE:     'unreachable',      // no verify adapter — honest, not a ✓
};

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
  },
  basis: {
    aprField: 'netAnnualizedExecutable', aprKind: 'fraction', fallbackAprField: 'netAnnualized',
    suppressFields: ['netAnnualized', 'netAnnualizedExecutable', 'indicativeBasisPct',
                     'executableBasisPct', 'grossAnnualized', 'grossAnnualizedExec', 'basis'],
    depthField: 'capacityUsd',
    capacitySourceField: 'capacitySource',               // 'book' = real walk; else proxy/OI
    verifyDepthConfirmed: (r) => r.capacitySource === 'book' && r.capacityUsd > 0,
    hasVerify: true,
  },
  rewards: {
    aprField: 'dayYieldPct', aprKind: 'dailyPctToAnnual', // *365
    suppressFields: ['dayYieldPct', 'estNetPerDay', 'grossRewardDay'],
    depthField: 'bookDepthAtBand',
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
  const id = rowId(section, row);
  const directive = ctx.directiveFor && ctx.directiveFor[`${section}:${id}`];
  if (directive) {
    out.push({
      rule: directive.rule || 'directive',
      action: directive.action || 'suppress-value',
      reason: directive.reason || 'guardian directive',
      fields: directive.action === 'suppress-value' ? cfg.suppressFields : undefined,
      label: directive.action === 'suppress-value' ? LABELS.IN_VERIFICA : directive.label,
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

  const rowCtx = { now, directiveFor, categoryMedian, deadSet: ctx.deadSet, priceMedian: ctx.priceMedian };

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

  return { rows: kept.concat(demoted), suppressions, critical };
}

module.exports = {
  applyGuardian, inspectRow, applyDecision, rowId, impliedApr, median,
  readDirectives, getPath, setPath,
  SECTION_CFG, LABELS,
  APY_HARD_MAX, APY_IMPOSSIBLE, CATEGORY_MULT, MIN_DEPTH_USD,
  MASS_SUPPRESS_FRAC, MASS_SUPPRESS_MIN, STALE_MINUTES_MAX, CASHABLE_SWING, CROSS_SURFACE_TOL,
  DIRECTIVES_FILE,
};
