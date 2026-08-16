# Edgeradar Design System

> **Phase gate**: read this file before touching any page component.
> "Honest engine" means every number displayed must be net-of-fees, at realistic capacity, with execution risk surfaced — not hidden behind a ceiling APY.

---

## 1. Typography

| Role | CSS var | Tailwind class | Font | Weights |
|---|---|---|---|---|
| Display / hero headings | `--font-display` | `font-display` | Bricolage Grotesque | 400–700 |
| Body / UI copy | `--font-body` | `font-body` | Inter | 400 / 500 / 600 |
| Data / code / numbers | `--font-mono` | `font-mono` | JetBrains Mono | (legacy) |

Base font size: `13px` on body; scale up with `text-sm` (14px), `text-base` (16px), `text-lg` (18px).

---

## 2. Color Tokens

### 2a. Base neutrals (Edgeradar)

| Name | CSS var | Tailwind key | Hex |
|---|---|---|---|
| Page background | `--er-bg` | `bg` | `#F5F8F6` |
| Soft background | `--er-bg-soft` | `bg-soft` | `#EBF1EE` |
| Card surface | `--er-surface` | `surface` | `#FFFFFF` |
| Primary text | `--er-ink` | `ink` | `#0B1A15` |
| Secondary text | `--er-ink-2` | `ink-2` | `#33433D` |
| Muted / placeholder | `--er-muted` | `muted` | `#6C7E78` |
| Border / divider | `--er-line` | `line` | `#E3ECE7` |

### 2b. Signal colors — honest-engine semantic mapping

| Semantic | Foreground | Background tint | CSS vars | Tailwind keys | When to use |
|---|---|---|---|---|---|
| **Cashable** | `#0A9D6B` | `#E2F7EE` | `--er-mint-deep` / `--er-mint-tint` | `mint-deep` / `mint-tint` | Arb confirmed executable: both legs verified, confidence ≥ 85 %, capacity ≥ $50 |
| **Paper** | `#D5552F` | `#FFEAE3` | `--er-coral-ink` / `--er-coral-tint` | `coral-ink` / `coral-tint` | Indicative only — midpoint price, no CLOB, or PredictIt (fee-negative after profit+withdrawal fees) |
| **Signal** | `#5566D6` | `#EEF1FF` | `--er-violet` / `--er-violet-tint` | `violet` / `violet-tint` | Divergence detected but confidence < 85 % or one leg unverified; worth watching, not acting |
| **Speculative** | `#C8821C` | `#FFF3E2` | `--er-gold` / `--er-gold-tint` | `gold` / `gold-tint` | Rate-variable (funding arb at ceiling APY), lockup risk, or weather markets |
| **Trap** | `#E5564E` | `#FDECEA` | `--er-trap` | `trap` | Structural mismatch: stage-elim vs cumulative, play-money platform, capacity < $50 |

Accent mint for live / active UI elements: `--er-mint` (`#0FBE82`), Tailwind key `mint`.

### 2c. Legacy terminal tokens (kept until pages are rebuilt)

| Var | Hex | Note |
|---|---|---|
| `--bg` | `#0A0C10` | Terminal page base |
| `--surface` | `#12151C` | Terminal panel |
| `--elevated` | `#1A1E27` | Terminal elevated |
| `--border` | `#232834` | Terminal divider |
| `--brand` | `#6366F1` | Old accent |
| `--accent` | `#818CF8` | Old accent bright |
| `--profit` | `#22C55E` | Old positive |
| `--loss` | `#EF4444` | Old negative |
| `--warn` | `#F59E0B` | Old warning |

---

## 3. Shape & Shadow

| Token | Value | Tailwind class |
|---|---|---|
| Card radius | `16px` | `rounded-card` |
| Panel radius | `20px` | `rounded-panel` |
| Pill radius | `999px` | `rounded-pill` |
| Button radius | `12px` | `rounded-button` |
| Card shadow | `0 1px 2px rgba(11,26,21,.04), 0 8px 28px rgba(11,26,21,.06)` | `shadow-card` |

---

## 4. Motion

| Animation | Class | Keyframe | Notes |
|---|---|---|---|
| Radar ping | `animate-er-ping` | `er-ping` | `scale(.4, opacity .7) → scale(2.2, opacity 0)` over 1.4 s |
| Spin (loading) | `animate-spin` | Tailwind built-in | 1 s linear |
| Pulse (live dot) | `animate-pulse-slow` | Tailwind `pulse` | 3 s, legacy terminal |

All animations must be wrapped in `@media (prefers-reduced-motion: no-preference)` at usage sites, or suppressed via the global reduced-motion override in `globals.css`.

---

## 5. Component Inventory

These components do not exist yet — they are defined here for Phase 2+ implementation. Read this section before building each one.

### Button

Three variants, all `rounded-button` (12 px), `font-body`, `font-medium`:

| Variant | Background | Text | Border | Hover |
|---|---|---|---|---|
| Primary | `mint-deep` | white | none | `mint` |
| Secondary | transparent | `ink-2` | `line` | `bg-soft` bg |
| Ghost | transparent | `muted` | none | `ink-2` text |

### Pill

Inline status badge. Small (10 px text), `rounded-pill`, `font-body font-medium`.
Color set driven by EdgeChip semantic (see below). Never use raw hex — always use the signal color pairs.

### Eyebrow

Uppercase label above a section heading. `font-body font-medium text-[11px] tracking-[0.12em] uppercase text-muted`.

### SectionHeading

Primary section heading. `font-display font-semibold text-2xl text-ink`.

### EdgeChip

The primary signal badge. Props: `type: 'cashable' | 'paper' | 'signal' | 'speculative' | 'trap'`.
Renders a `<Pill>` with the corresponding foreground+tint from §2b.
Also renders a `<RadarMark>` (live pulse dot) only when `type === 'cashable'`.

### RadarMark

A live-data indicator. A small circle (`w-2 h-2 rounded-full`) with `animate-er-ping` on a concentric ring, color `mint`.
Suppressed entirely under `prefers-reduced-motion`.

### RadarScope

Decorative animated radar element for hero/marketing sections. Three concentric rings (`ring-1`/`ring-2`/`ring-3`) at 40 / 80 / 120 px with opacity stepping down. Central `mint` dot. Reduced-motion: replace with static concentric circles only.

### BlipRow

A table row representing one opportunity. Key display rules:
- First column: `EdgeChip` with the correct semantic type.
- Primary metric: `$/day` (net, at green capacity). Large, `font-display font-semibold`.
- Secondary metric: `%/yr` demoted below in `text-muted text-xs`, labeled `"est. %/yr — rate variable"`.
- Thin-depth warning: amber inline note when `thinFlag` or `depthThin`.
- Unconfirmed leg: renders as `Signal` type, never `Cashable`.

### StatCard

Metric display card. `rounded-card`, `shadow-card`, `bg-surface`. Props: `value`, `label`, `trend?: number`, `unit?`, `note?`.
Trend: `text-mint-deep` for positive, `text-coral-ink` for negative.

---

## 6. Honest-Engine Display Rules

These rules are non-negotiable across all strategy sections.

### $/day is the primary metric

Display `netDayUsd` (net of fees, at green/honest capacity) as the hero number on every opportunity card and row.
Never lead with APY or annualized % when a $/day figure is available.

### Annualized % is always demoted and labeled

When annualized % must appear (Cash & Carry locked basis, Liquidity Rewards estimate), show it:
- In smaller type (`text-xs`) below the $/day number.
- With an explicit label: `"est. %/yr"` for rate-variable, `"%/yr locked"` for basis trades.
- Never in a primary position, never without the label.

### Executable ≤ indicative

A cashable green badge may only appear when ALL of:
- Both legs have verified URLs (`urlVerified: true`).
- AI matcher confidence ≥ 85 % (`confidence >= 0.85`).
- Executable capacity ≥ $50 (`capacityUsd >= 50`).
- Neither platform is signal-only (Manifold = play money; PredictIt = fee-negative after all costs; Futuur = midpoint only).
- No semantic mismatch flagged (`nonCashableReason === null`).

If any condition fails, render as `Signal` (violet) or `Paper` (coral) with an honest reason note.

### Zero-cashable state shown calmly

When no cashable arb exists, show: `"No confirmed arb right now — checking again in Xm"`.
Do not hide the section, do not show a loading spinner indefinitely, do not imply data is broken.

### Unconfirmed legs → Signal or Paper

`oneLegUnverified: true` means the spread uses a predicted funding rate, not a settled one.
Always render these as `Signal`, never `Cashable`. Show note: `"1 leg predicted — rate unconfirmed"`.

### Capacity = green capacity, not theoretical ceiling

Capacity displayed to the user must be `greenCapacityUsd` (the size where slippage ≤ 30 % of gross yield).
Never display OI-based tier labels alone as a capacity figure.
`$0 green cap` should show a calm note: `"Thin book — all sizes above slippage threshold"`.

### Snapshot vs live

Data that is not a live feed (sports arb snapshot, cron-based carry scan) must display a `SNAPSHOT` badge and the age in hours.
Never present snapshot data without the age label.

---

## 7. Body Glow

The app base background includes a subtle radial glow:

```css
background:
  radial-gradient(circle at 50% -10%, rgba(15,190,130,.05), transparent 60%),
  #F5F8F6;
```

This gives the page a soft mint warmth at the top without interfering with card surfaces (which are `#FFFFFF`).
