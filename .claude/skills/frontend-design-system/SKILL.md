---
name: frontend-design-system
description: Apply whenever building or reshaping dashboard UI in Edgeradar — adding a badge/tag, a stat tile, a gated value, a platform logo, or any number rendered to the user. Encodes the real design tokens, the canonical reusable components and their variants, the null-safety formatter, and the "never build a parallel component" rule so the UI stays one system and never renders "NaN"/"null".
---

# Frontend Design System

Ground every UI choice against the real tokens and components below — never invent a color, radius, or a new component for a job an existing one already does. Cite the source when in doubt; two token systems coexist (a legacy "terminal" palette and the current **Edgeradar** palette) and mixing them wrong is the most common drift.

## Design tokens (real values)
Sources: `tailwind.config.ts`, `app/globals.css`.
- **Fonts** (`tailwind.config.ts:87-94`): `sans`→Inter (`--font-sans`), `mono`→JetBrains Mono, `display`→Bricolage Grotesque, `body`→Inter (`--font-body` = `--font-sans`, `globals.css:49`). Body base is `13px` (`globals.css:118`). Big display values use `font-display font-bold`.
- **Accent** — Edgeradar primary is **mint green** `#0FBE82` (`mint`), with `mint-deep #0A9D6B`, `mint-tint #E2F7EE` (`tailwind.config.ts:50-51`). Signal palette: `coral #FF7A59` (paper), `violet #5566D6` (divergence), `gold #C8821C` (speculative), `trap #E5564E` (`:40-64`). The `accent #6366F1` indigo is **legacy** — prefer mint for new Edgeradar surfaces.
- **Radius** (`tailwind.config.ts:67-81`) — Edgeradar scale: `card 16px`, `panel 20px`, `button 12px`, `pill 999px`. (Legacy `DEFAULT 3px`/`sm/md/lg/xl` are the terminal scale.)
- **Shadow** — one card shadow (`tailwind.config.ts:83-85`): `card: "0 1px 2px rgba(11,26,21,.04), 0 8px 28px rgba(11,26,21,.06)"`.
- **Theme** — day/night flips one `data-theme` attribute on `<html>`, swapping the `--ds-*` token set (day `globals.css:65-84`, night `:85-103`; default→day via `:root:not([data-theme])`, `:66`). Scoped wrappers `--sa-*`/`--cc-*`/`--cd-*` and the `.dsskin` night remap all consume `--ds-*`. Don't hardcode a hex where a `--ds-*` var exists — see the [[project-theme-toggle]] memory for the full mechanism.

## Canonical components — one per job, never a parallel copy
**Before creating any component, check this map. Never build a second component for a job listed here.**

| Job | Canonical component | Source |
|---|---|---|
| Badge / edge-signal tag | **`EdgeChip`** | `app/components/ui/EdgeChip.tsx` |
| Stat display (label + big value) | **`StatCard`** | `app/components/ui/StatCard.tsx` |
| Gated single value | **`Redacted`** | `app/components/ui/Redacted.tsx` |
| Gated whole feed | **`RedactedPanel`** | `app/components/ui/Redacted.tsx` |
| Plain-string numeric fallback | **`fmt-safe`** helpers | `lib/fmt-safe.ts` |
| Platform logo | **`PlatformLogo`** | `components/PlatformLogo.tsx` |

- **`EdgeChip`** (`EdgeChip.tsx:40-43`): required prop `variant`, optional `className`. Six variants (`:3-9`): `'cashable' | 'paper' | 'signal' | 'copy_trader' | 'speculative' | 'trap'`, with fixed labels (`:11-18`) and tint/text class pairs (`:22-29`, e.g. `cashable: 'bg-mint-tint text-mint-deep'`, `signal: 'bg-violet-tint text-violet'`, `trap: 'text-[#E5564E]'` on inline `#FDECEA`). `cashable` renders an animated `<RadarMark>`; others a static dot (`:62-68`). Text is `font-body font-semibold text-[9.5px] tracking-wide uppercase rounded-md` (`:55`). (A lower-level `app/components/ds/Chip.tsx` exists but is not the edge badge.)
- **`StatCard`** (`StatCard.tsx:3-11`): props `label`, `value: ReactNode` (may hold a `<Redacted>` node), optional `note`, `demoted`, `className`. No variants. `rounded-card shadow-card bg-surface`, value `font-display font-bold` at `fontSize:33`.
- **`Redacted`** (`Redacted.tsx:10-26`): render-prop `Redacted<T>` — props `value`, `children:(v)=>node` (called only when non-null, `:16`), `isPaid` (default false), `nullDisplay` (default `'—'`). Present value → renders children; `isPaid` + null → honest `'—'` (not a paywall); free + null → blurred dots + Lock + upgrade `Link`. `RedactedPanel` (`:59-65`) is the whole-feed placeholder. This is the render side of [[freemium-gating]] — the server already sent `null`; the component decides paywall vs honest "—".
- **`PlatformLogo`** (`PlatformLogo.tsx:82-90`): props `platform` (any casing), `size` (default 14), `className`. Slug-maps to `/logos/{slug}.svg` via `SLUG_MAP` (`:10-74`); on load error falls back to an initial lettermark (`:95-106`).

## Responsive rules actually enforced
- **`clamp()` for fluid type/spacing**: `app/landing-skin.module.css:164` `clamp(42px, 8.2vw, 78px)`; `app/LandingClient.tsx:271` `padding: 0 clamp(16px, 4.5vw, 32px)`.
- **`min-w-0` flex-overflow guard** on card heads/legs/rows: `app/dashboard/page.tsx:253` (`flex-1 min-w-0`), mirrored in CSS `min-width:0` (`globals.css:356`, `:507`). Add `min-w-0` to any flex child holding truncatable text.
- **44px touch targets**: `globals.css:585` (`.cc-sortbtn` `min-width:44px; min-height:44px`), `:729` (`.cc-row min-height:44px`), `app/dashboard/liquidity-rewards/[marketId]/page.tsx:1107` (`min-h-[44px]`). Interactive controls meet 44px.
- **Breakpoint prefixes** in real use: `sm:`/`md:`/`lg:` (`app/admin/page.tsx:88,99`); mobile-cards / desktop-table swap via `md:hidden` + `hidden md:block` (`admin/page.tsx:186,215`). Raw media query for CTA text swap at `LandingClient.tsx:316` (`@media (min-width:440px)`).

## Null-safety formatter — never render "NaN"/"null"/bare "—"
Central utility: **`lib/fmt-safe.ts`**. Every formatter is guarded by `isNum()` (`typeof === 'number' && Number.isFinite`, `:13-15`) and returns `REDACTED_PLACEHOLDER = '•••'` (`:11`) instead of `NaN`/`$NaN` on null/undefined:
- `safeFixed(n, dec=1)` (`:17-19`), `safePct(n, dec=1)` (`:21-23`), `safeUsd(n, dec=2)` (`:25-29`), `safeNum(n, dec=0)` (`:31-35`), and `safeChartNum(n)` (`:39-41`, passes `null` through so a chart draws a hole, never a fabricated zero).

**Division of labor** (file header `:1-9`): use `fmt-safe` in **plain-string contexts** (e.g. `StatCard`'s `value` when it's a string); use **`<Redacted>` in JSX** when the null should show the paywall/CTA or an honest "—". Never `String(x)` or `x.toFixed()` a possibly-null number directly into the DOM.

## Honesty
A displayed number is a claim — see [[honest-engine]]. A missing value renders as `'•••'` (free-gated), `'—'` (honestly unmeasured), or a chart hole — never a zero, a guess, or `NaN`.
