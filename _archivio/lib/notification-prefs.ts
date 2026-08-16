// Shared shape for the per-category alert preferences stored on User.alertPrefs.
// Cashable strategies (prediction/funding/carry/liquidity) vs. signal-only
// strategies (traders/sports) get different dot colors in the UI — kept here
// so the API route and the account page agree on categories and defaults.

export const ALERT_CATEGORIES = ['prediction', 'funding', 'carry', 'liquidity', 'traders', 'sports'] as const;
export type AlertCategory = typeof ALERT_CATEGORIES[number];

export const CASHABLE_CATEGORIES: AlertCategory[] = ['prediction', 'funding', 'carry', 'liquidity'];

export type AlertPrefs = Record<AlertCategory, boolean> & { emailDigest: boolean };

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  prediction:  true,
  funding:     true,
  carry:       false,
  liquidity:   false,
  traders:     false,
  sports:      false,
  emailDigest: true,
};

export const CATEGORY_LABELS: Record<AlertCategory, string> = {
  prediction: 'Prediction market arb',
  funding:    'Funding-rate arb',
  carry:      'Cash & carry',
  liquidity:  'Liquidity rewards',
  traders:    'Trader / whale alerts',
  sports:     'Sports arb',
};

/** Merge whatever is in the DB (possibly partial/legacy) with defaults. Never trusts stored shape blindly. */
export function normalizeAlertPrefs(stored: unknown): AlertPrefs {
  const raw = (stored && typeof stored === 'object') ? stored as Record<string, unknown> : {};
  const merged = { ...DEFAULT_ALERT_PREFS };
  for (const cat of ALERT_CATEGORIES) {
    if (typeof raw[cat] === 'boolean') merged[cat] = raw[cat] as boolean;
  }
  if (typeof raw.emailDigest === 'boolean') merged.emailDigest = raw.emailDigest as boolean;
  return merged;
}
