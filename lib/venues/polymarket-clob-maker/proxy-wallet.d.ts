import type { Provider } from 'ethers';

export interface ProxyResolution {
  /** The funder/proxy wallet, checksummed — or null (self-custody EOA / unresolved). */
  proxyAddress: string | null;
  source: 'onchain';
  /** What the on-chain exchange proxy-factory returned. */
  onChain: string | null;
  /** What Polymarket's profile API returned as a cross-check, or null if unreachable. */
  profile: string | null;
  /** true = profile agreed with on-chain; false = genuine mismatch (STOP); null = profile unreachable. */
  agree: boolean | null;
}

export function resolveProxyOnChain(signer: string, provider: Provider): Promise<string | null>;
export function resolveProxyFromProfileApi(signer: string, fetchImpl?: typeof fetch): Promise<string | null>;
export function resolveProxyForSigner(
  signer: string,
  opts?: { provider?: Provider; profileFetch?: typeof fetch },
): Promise<ProxyResolution>;
export function isNonZeroAddress(a: unknown): boolean;
