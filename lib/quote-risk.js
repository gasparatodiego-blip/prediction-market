/**
 * Quote-asset risk classification for carry routes.
 *
 * A carry's spot leg is bought against some quote asset, and they are not
 * interchangeable. A fiat-backed stablecoin holding cash and T-bills in reserve is a
 * materially different instrument from a synthetic dollar that holds a delta-neutral
 * derivatives position, even when both print "$1". A route quoting in one is not the
 * same trade as a route quoting in the other.
 *
 * Honest-engine stance: show every route, label the risk, let the user decide. Nothing
 * is dropped or down-ranked for its quote asset — routes rank on real depth and real
 * fees exactly as before. This module only makes the risk explicit and machine-readable
 * so the UI can badge it.
 *
 * ── CLASSIFICATION IS ALLOWLIST-BASED, AND FAILS TOWARD FLAGGING ────────────
 * `fiat_backed` requires the asset to be on FIAT_BACKED — an affirmative decision, never
 * a default. Assets we can positively identify as synthetic/crypto-collateralized get
 * `synthetic` with a specific reason. Everything else gets `unknown`, which is FLAGGED,
 * not clean: an unrecognized quote asset is a reason for the user to look, not an
 * implicit endorsement. Adding a new stablecoin to a venue therefore surfaces a badge
 * rather than silently reading as safe.
 *
 * `unknown` is deliberately distinct from `synthetic`. Calling an unrecognized ticker
 * "synthetic" would assert a mechanism we have not verified — the honest statement is
 * that we do not know what backs it.
 */

/**
 * Quote assets backed by fiat reserves (cash / cash-equivalents / T-bills), plus fiat
 * itself. Membership here is the ONLY route to an unflagged `fiat_backed` tier.
 *
 * Note this is a statement about the backing MODEL, not a credit opinion: a fiat-backed
 * issuer still carries issuer, reserve-attestation and redemption risk. It means the
 * asset is not algorithmically or crypto-collateralised, which is the distinction the
 * badge is drawing.
 */
const FIAT_BACKED = new Set([
  'USD', 'EUR', 'GBP',                       // fiat itself
  'USDC', 'USDT', 'EURC',                    // major fiat-reserve stablecoins
  'PYUSD', 'FDUSD', 'TUSD', 'USDP', 'GUSD',  // other fiat-reserve issuers
]);

/**
 * Quote assets we can positively identify as NOT fiat-reserve-backed, with the reason
 * that makes them different. Anything not listed here and not on FIAT_BACKED falls to
 * `unknown` rather than being guessed into this bucket.
 */
const SYNTHETIC = {
  USDE:   { label: 'Synthetic dollar',
            reason: 'USDe (Ethena): synthetic dollar backed by a delta-neutral derivatives position, not fiat '
                  + 'reserves. Carries de-peg, funding-regime and exchange-counterparty risk.' },
  DAI:    { label: 'Crypto-collateralized',
            reason: 'DAI (Sky/MakerDAO): crypto-collateralized CDP stablecoin, not fiat reserves. Peg depends on '
                  + 'collateral value and liquidation mechanics.' },
  FRAX:   { label: 'Algorithmic',
            reason: 'FRAX: fractional-algorithmic stablecoin. Peg depends partly on protocol mechanics rather '
                  + 'than full fiat reserves.' },
  SUSD:   { label: 'Crypto-collateralized',
            reason: 'sUSD (Synthetix): crypto-collateralized synthetic, not fiat reserves.' },
  GHO:    { label: 'Crypto-collateralized',
            reason: 'GHO (Aave): crypto-collateralized stablecoin, not fiat reserves.' },
  CRVUSD: { label: 'Crypto-collateralized',
            reason: 'crvUSD (Curve): crypto-collateralized stablecoin with soft-liquidation mechanics.' },
  LUSD:   { label: 'Crypto-collateralized',
            reason: 'LUSD (Liquity): ETH-collateralized stablecoin, not fiat reserves.' },
  USDD:   { label: 'Algorithmic',
            reason: 'USDD: algorithmic/over-collateralized stablecoin, not fiat reserves.' },
};

const TIER = { FIAT: 'fiat_backed', SYNTH: 'synthetic', UNKNOWN: 'unknown' };

/**
 * Classify a quote asset into a structured, machine-readable risk record.
 *
 * @param {string|null} quoteAsset ticker as listed by the venue, e.g. 'USDC', 'USDE'
 * @returns {{quoteAsset: string|null, quoteRiskTier: string, quoteRiskFlagged: boolean,
 *            quoteRiskLabel: string|null, quoteRiskReason: string|null}}
 */
function classifyQuoteAsset(quoteAsset) {
  const raw = typeof quoteAsset === 'string' ? quoteAsset.trim() : '';
  const key = raw.toUpperCase();

  if (!key) {
    return {
      quoteAsset: null,
      quoteRiskTier: TIER.UNKNOWN,
      quoteRiskFlagged: true,
      quoteRiskLabel: 'Unknown quote',
      quoteRiskReason: 'Quote asset not identified for this route — treated as risk-bearing rather than assumed safe.',
    };
  }
  if (FIAT_BACKED.has(key)) {
    return {
      quoteAsset: raw,
      quoteRiskTier: TIER.FIAT,
      quoteRiskFlagged: false,
      quoteRiskLabel: null,
      quoteRiskReason: null,
    };
  }
  const syn = SYNTHETIC[key];
  if (syn) {
    return {
      quoteAsset: raw,
      quoteRiskTier: TIER.SYNTH,
      quoteRiskFlagged: true,
      quoteRiskLabel: syn.label,
      quoteRiskReason: syn.reason,
    };
  }
  return {
    quoteAsset: raw,
    quoteRiskTier: TIER.UNKNOWN,
    quoteRiskFlagged: true,
    quoteRiskLabel: 'Unrecognized quote',
    quoteRiskReason: `${raw} is not on the fiat-backed allowlist and is not a known synthetic. Its backing model is `
                   + 'unverified — flagged so it is assessed, not assumed safe.',
  };
}

module.exports = { classifyQuoteAsset, FIAT_BACKED, SYNTHETIC, TIER };
