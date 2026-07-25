// Type declarations for lib/reward-layers.js — see that file for the layering (not queue-position) rationale.

export interface RewardLayer {
  index: number; // 1-based, nearest-mid first
  price: number; // tick-snapped executable price, within the band
}

export interface RewardLayersResult {
  maxUsablePerSide: number;        // floor(band_half_width / tick) — the hard cap at 1-tick spacing
  spacingTicks: number;            // ticks between adjacent layers actually used
  center: number | null;          // grid-snapped band centre (null when inputs unusable)
  bid: RewardLayer[];              // buy-side layers (below centre), nearest-mid first, deduped
  ask: RewardLayer[];              // sell-side layers (above centre), nearest-mid first, deduped
  count: number;                   // layers per side actually fitting at the requested spacing/cap
}

export interface RewardLayersOpts {
  spacingTicks?: number;           // ticks between adjacent layers (default 1)
  maxLayers?: number;              // operator cap on layers per side (default Infinity)
}

export function rewardLayers(
  bandLow: number,
  bandHigh: number,
  tick: number,
  opts?: RewardLayersOpts,
): RewardLayersResult;

export function snapToTick(price: number, tick: number): number;
