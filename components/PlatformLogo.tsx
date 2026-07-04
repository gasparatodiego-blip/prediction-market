'use client';

import { useState } from 'react';

// Maps raw platform/exchange values (as they appear in agent data, in any
// casing) to the /public/logos/*.svg filename slug. All current entries are
// documented lettermark fallbacks (public/logos/*.svg), not traced brand
// marks — see the SVG comments. Add new platforms here as they show up in
// live rows.
const SLUG_MAP: Record<string, string> = {
  polymarket:        'polymarket',
  kalshi:             'kalshi',
  binance:            'binance',
  'binance usdt-m':   'binance',
  'binance coin-m':   'binance',
  bybit:              'bybit',
  okx:                'okx',
  hyperliquid:        'hyperliquid',
  dydx:               'dydx',
  aster:              'aster',
  paradex:            'paradex',
  edgex:              'edgex',
  grvt:               'grvt',
  lighter:            'lighter',
  extended:           'extended',
  gateio:             'gate-io',
  'gate.io':          'gate-io',
  'gate-io':          'gate-io',
  bitget:             'bitget',
  deribit:            'deribit',
  predictit:          'predictit',
  manifold:           'manifold',
  // Sportsbooks (h2h scanner) — bookmakerId is the canonical key from
  // OddsAPI, bookmaker is the display string; both are passed through here.
  betfair:              'betfair',
  'betfair sportsbook': 'betfair',
  betfair_ex_eu:        'betfair',
  betfair_ex_uk:        'betfair',
  betfair_sb_uk:        'betfair',
  betmgm:               'betmgm',
  betsson:              'betsson',
  betway:               'betway',
  bovada:               'bovada',
  draftkings:           'draftkings',
  everygame:            'everygame',
  fanduel:              'fanduel',
  gtbets:               'gtbets',
  lowvig:               'lowvig',
  'lowvig.ag':          'lowvig',
  matchbook:            'matchbook',
  onexbet:              'onexbet',
  '1xbet':              'onexbet',
  paddypower:           'paddypower',
  'paddy power':        'paddypower',
  pinnacle:             'pinnacle',
  smarkets:             'smarkets',
  sport888:             '888sport',
  '888sport':           '888sport',
  unibet_fr:            'unibet',
  unibet_nl:            'unibet',
  unibet_se:            'unibet',
  unibet_uk:            'unibet',
  'unibet (fr)':        'unibet',
  'unibet (nl)':        'unibet',
  'unibet (se)':        'unibet',
  'unibet (uk)':        'unibet',
  winamax_de:           'winamax',
  'winamax (de)':       'winamax',
};

function toSlug(platform: string): string {
  const key = platform.trim().toLowerCase();
  if (SLUG_MAP[key]) return SLUG_MAP[key];
  return key.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

interface PlatformLogoProps {
  /** Platform/exchange name or slug, any casing — e.g. "Polymarket", "gateio", "Binance USDT-M" */
  platform:   string;
  /** Square size in px. Default 14 matches the sub-label text size on landing rows. */
  size?:      number;
  className?: string;
}

export default function PlatformLogo({ platform, size = 14, className = '' }: PlatformLogoProps) {
  const slug    = toSlug(platform);
  const initial = platform.trim().charAt(0).toUpperCase() || '?';
  const [broken, setBroken] = useState(false);

  if (broken) {
    return (
      <span
        className={`inline-flex items-center justify-center align-middle rounded-[4px] bg-bg-soft text-ink-2 font-body font-semibold flex-shrink-0 ${className}`}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.6), lineHeight: 1 }}
        title={platform}
        aria-hidden
      >
        {initial}
      </span>
    );
  }

  return (
    <img
      src={`/logos/${slug}.svg`}
      alt={platform}
      width={size}
      height={size}
      className={`inline-block align-middle flex-shrink-0 ${className}`}
      onError={() => setBroken(true)}
    />
  );
}
