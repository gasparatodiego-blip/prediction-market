import type { Provider } from 'ethers';

export interface ProxyResolution {
  /**
   * The funder/proxy wallet to actually use, checksummed — or null (self-custody EOA / unresolved).
   * This is `configured` when MAKER_FUNDER_ADDRESS is set, and only otherwise the on-chain derivation:
   * the configured funder is the address the signing path writes into every order's `maker` field.
   */
  proxyAddress: string | null;
  /** Where proxyAddress came from. 'config' = MAKER_FUNDER_ADDRESS (wins); 'onchain' = the derivation. */
  source: 'config' | 'onchain';
  /** MAKER_FUNDER_ADDRESS, checksummed, or null when unset/malformed. */
  configured: string | null;
  /**
   * What the exchange's ProxyWallet factory returned for this signer. NOT authoritative outside
   * signatureType 1: it is a counterfactual CREATE2 address that never fails and never returns zero,
   * so on a type 2/3 account it names a wallet that may hold nothing. See `applicable`.
   */
  onChain: string | null;
  /** What Polymarket's profile API returned as a cross-check, or null if unreachable. */
  profile: string | null;
  /** profile vs onChain. true = agreed; false = genuine mismatch; null = profile unreachable. */
  agree: boolean | null;
  /** profile vs the CONFIGURED funder — the cross-check that matters, since that is what gets signed for. */
  agreeConfig: boolean | null;
  /** Whether the ProxyWallet derivation is even the right factory for this signature type (type 1 only). */
  applicable: boolean;
  /** Human-readable outcome of the configured-vs-derived check. */
  verdict: string;
}

export interface ProxyAgreement {
  ok: boolean;
  applicable: boolean;
  configured: string | null;
  derived: string | null;
  reason: string;
}

export function resolveProxyOnChain(signer: string, provider: Provider): Promise<string | null>;
export function resolveProxyFromProfileApi(signer: string, fetchImpl?: typeof fetch): Promise<string | null>;
export function resolveProxyForSigner(
  signer: string,
  opts?: {
    provider?: Provider;
    profileFetch?: typeof fetch;
    /** process.env (or any subset) — supplies MAKER_FUNDER_ADDRESS / MAKER_SIGNATURE_TYPE. */
    env?: Record<string, string | undefined>;
    /** Explicit override for the signature type; falls back to env.MAKER_SIGNATURE_TYPE. */
    signatureType?: number | string;
  },
): Promise<ProxyResolution>;
export function isNonZeroAddress(a: unknown): boolean;
/** MAKER_FUNDER_ADDRESS, checksummed, or null when unset/malformed (never fabricated). */
export function configuredFunder(env?: Record<string, string | undefined>): string | null;
/** True only for signatureType 1 — the one account type the ProxyWallet derivation is authoritative for. */
export function derivationApplies(signatureType: number | string | undefined): boolean;
/**
 * Throws when the configured funder contradicts the derivation on a signatureType 1 account (where the
 * derivation IS the authority). Returns a verdict in every other case — including type 2/3, where a
 * difference just means the derivation used the wrong factory and the configured funder stands.
 */
export function assertProxyAgreesWithConfig(args: {
  configured?: string | null;
  derived?: string | null;
  signatureType?: number | string;
}): ProxyAgreement;
