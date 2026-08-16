// Tier → colour map for the landing "live field" re-skin. Plain module (no
// 'use client') so both the server page (CardFace) and the client field can
// import it. These ARE the existing tier colours — the graphic is information.
export const TIER_COLOR: Record<string, string> = {
  cashable:    '#2DD4A0',
  signal:      '#8B93F8',
  copy_trader: '#8B93F8',
  speculative: '#F0A93B',
  paper:       '#F0A93B',
  trap:        '#F0A93B',
};

export function tierColor(chip: string): string {
  return TIER_COLOR[chip] ?? '#2DD4A0';
}
