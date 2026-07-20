// Design-system tokens for the dark card surfaces (Sport Arb, Cash & Carry).
//
// These values are the SINGLE SOURCE OF TRUTH for the palette. They were verified
// byte-identical across .sportarb / .cashcarry / .carrydetail in app/globals.css before
// extraction — the three wrappers used different variable NAMES (--sa-* / --cc-* / --cd-*)
// for literally the same hex values.
//
// The CSS custom properties themselves still live in globals.css under each wrapper. That
// is deliberate: unifying the CSS would change pixels (see PREFIX_NOTE below), and this
// extraction is a behaviour-preserving refactor. Use these constants wherever a colour is
// needed in TS/JS (inline styles, canvas, chart series) so a future CSS unification has
// one place to read from.

export const COLORS = {
  bg:      '#0A0D10',
  panel:   '#171D24',
  border:  '#232B34',
  text:    '#E8ECF1',
  muted:   '#69737E',
  green:   '#2FE29A',   // --sa-live / --cc-green / --cd-green
  amber:   '#F2B02E',
  spot:    '#5B9DFF',   // --sa-exch / --cc-spot  — exchange & spot leg
  future:  '#4FD1C5',   // --cc-future / --cd-future — dated-future leg
  pred:    '#A78BFA',   // --sa-pred — prediction-market leg (sport only)
  danger:  '#FF5A5F',   // --cd-danger — fee rows (carry detail only)
} as const;

export const FONTS = {
  display: "var(--font-display), 'Bricolage Grotesque', system-ui, sans-serif",
  body:    'var(--font-body), Inter, system-ui, sans-serif',
} as const;

/** Wrapper class → CSS class prefix. Every ds component takes one of these. */
export type SurfacePrefix = 'sa' | 'cc' | 'cd';

/**
 * WHY THE COMPONENTS TAKE A PREFIX INSTEAD OF EMITTING ONE SHARED CLASS
 * ---------------------------------------------------------------------
 * The three surfaces LOOK the same but are not pixel-identical. Measured deltas at the
 * time of extraction (globals.css, per-selector diff):
 *
 *   .cd-card      border-radius 11px / padding 12px      vs .cc-card 12px / 13px 13px 11px
 *   .cd-leg       background panel, radius 9px, pad 9/10 vs .cc-leg rgba(.02), 8px, 8/9
 *   .cd-empty     border-radius 11px                     vs .cc-empty 12px
 *   .sa-card-head align-items center                     vs .cc-card-head baseline
 *   .sa-chip      letter-spacing .05em                   vs .cc-chip .04em
 *   .sa-bar       margin 11px 0 9px                      vs .cc-bar 11px 0 5px
 *   .sa-bar-fill  live + 1s linear                       vs .cc-bar-fill spot + .6s ease
 *   .sa-net-val   live, 21px                             vs .cc-net-val green, 20px
 *   .sa-net-cap   8.5px/.05em/mt2                        vs .cc-net-cap 8px/.04em/mt3/right
 *   .sa-figs      11px, gap 10px                         vs .cc-figs 10.5px, gap 8px, wrap
 *   .sa-arm       9.5px/600/.06em/pad 5-9/r6             vs .cd-arm 10px/700/.07em/pad 9/r8/full-width
 *
 * Collapsing those into one class set would move pixels on both tabs. So the components
 * unify STRUCTURE and the props API now, and emit each surface's existing class names —
 * which makes this refactor provably zero-pixel. Reconciling the eleven deltas above is a
 * deliberate VISUAL change and belongs in its own commit, not smuggled into a refactor.
 */
export const PREFIX_NOTE = 'ds components emit per-surface class names; see tokens.ts for why' as const;
