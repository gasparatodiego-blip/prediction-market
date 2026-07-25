// lib/poly-chain-read.ts — READ-ONLY Polygon reads for the event terminal's "what is possible" section.
//
// SAFETY: eth_call / eth_getBalance only. No signer is constructed, no key is loaded, no transaction is
// built. This module physically cannot approve, fund, or place anything — it holds a JsonRpcProvider and
// three view-only ABIs. It is the read half of scripts/maker-wallet-preflight.ts, sharing that script's
// contract constants via lib/poly-contracts.
//
// HONEST ENGINE: every field is a real chain read or `null`. A failed/timed-out call is null (the UI
// renders "—"), NEVER 0 — "we could not read your balance" and "your balance is zero" are different
// facts and the terminal must not conflate them. A balance of exactly 0 that WAS read comes back as the
// number 0 with `read: true`, so the page can honestly print "$0.00" pre-funding.

import { JsonRpcProvider, Contract, formatUnits, formatEther, isAddress } from 'ethers';
import prisma from './prisma';
import { PUSD, CTF, EXCHANGES, DEFAULT_RPC } from './poly-contracts';
import { POLY_MAKER_VENUE } from './venues/polymarket-clob-maker/credentials';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];
const ERC1155_ABI = [
  'function isApprovedForAll(address,address) view returns (bool)',
  'function balanceOf(address,uint256) view returns (uint256)',
];

const CALL_TIMEOUT_MS = 6_000;

/** A read that never throws: resolves to null on error OR timeout. Null means UNREAD, never zero. */
async function safe<T>(p: () => Promise<T>, timeoutMs = CALL_TIMEOUT_MS): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ApprovalRead {
  key: string;
  name: string;
  addr: string;
  /** ERC-20 pUSD allowance granted to this spender, in pUSD. null = unread. */
  collateralAllowance: number | null;
  /** ERC-1155 CTF setApprovalForAll to this spender. null = unread (never defaulted to false). */
  outcomeApproved: boolean | null;
}

export interface ChainReadResult {
  /** The address every figure below belongs to; null when no wallet is configured at all. */
  wallet: string | null;
  /** How the wallet was resolved — 'env' | 'custody' | null. Shown so the operator knows what they read. */
  walletSource: 'env' | 'custody' | null;
  rpcReachable: boolean;
  /** Native gas token, needed to send the approval transactions. null = unread. */
  maticBalance: number | null;
  /** pUSD (v2 settlement collateral). null = unread; 0 = genuinely read as zero. */
  pusdBalance: number | null;
  /** Reserved by resting orders. Always null here — see reservedReason. */
  pusdReserved: number | null;
  reservedReason: string;
  /** balance − reserved. null whenever either input is null (never balance-as-available). */
  pusdAvailable: number | null;
  approvals: ApprovalRead[];
  /** Outcome-token balances for THIS market's two token ids (ERC-1155 on the CTF). null = unread. */
  yesTokenBalance: number | null;
  noTokenBalance: number | null;
  readAt: string;
}

/** The wallet whose chain state the terminal reports: env override first, else the custody row. */
async function resolveWallet(): Promise<{ wallet: string | null; source: 'env' | 'custody' | null }> {
  const override = process.env.MAKER_WALLET_ADDRESS;
  if (override && isAddress(override)) return { wallet: override, source: 'env' };
  try {
    const row =
      (await prisma.exchangeKey.findFirst({
        where: { venue: POLY_MAKER_VENUE, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { accountAddress: true },
      })) ||
      (await prisma.exchangeKey.findFirst({
        where: { venue: 'polymarket', revokedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { accountAddress: true },
      }));
    const addr = row?.accountAddress ?? null;
    return addr && isAddress(addr) ? { wallet: addr, source: 'custody' } : { wallet: null, source: null };
  } catch {
    return { wallet: null, source: null };
  }
}

const EMPTY_APPROVALS: ApprovalRead[] = EXCHANGES.map((e) => ({
  key: e.key, name: e.name, addr: e.addr, collateralAllowance: null, outcomeApproved: null,
}));

/**
 * Read the wallet's on-chain position for one market. `tokenId`/`tokenIdNo` are the market's CTF
 * ERC-1155 ids; pass null to skip that balance (it then reads null, not 0).
 */
export async function readChainState(
  tokenId: string | null,
  tokenIdNo: string | null,
): Promise<ChainReadResult> {
  const readAt = new Date().toISOString();
  // Open orders reserve collateral inside the CLOB's own ledger, not on chain. Reading it requires an
  // AUTHENTICATED CLOB session (an API key + signature). This terminal is read-only on the maker path
  // and loads no credential, so `reserved` is honestly unknown — and therefore `available` is too.
  const reservedReason =
    'la quota bloccata dagli ordini aperti vive nel registro del CLOB, non on-chain: leggerla richiede una sessione CLOB autenticata, che questa pagina non apre';
  const base: ChainReadResult = {
    wallet: null, walletSource: null, rpcReachable: false,
    maticBalance: null, pusdBalance: null, pusdReserved: null, reservedReason, pusdAvailable: null,
    approvals: EMPTY_APPROVALS, yesTokenBalance: null, noTokenBalance: null, readAt,
  };

  const { wallet, source } = await resolveWallet();
  if (!wallet) return base;

  const provider = new JsonRpcProvider(process.env.POLYGON_RPC_URL || DEFAULT_RPC);
  try {
    const erc20 = new Contract(PUSD, ERC20_ABI, provider);
    const ctf = new Contract(CTF, ERC1155_ABI, provider);

    // Decimals is itself a chain read; a miss means we cannot scale ANY pUSD figure, so they all stay
    // null rather than being divided by an assumed 6.
    const decRaw = await safe(() => erc20.decimals());
    const dec = decRaw == null ? null : Number(decRaw);

    const [maticRaw, balRaw, ...rest] = await Promise.all([
      safe(() => provider.getBalance(wallet)),
      safe(() => erc20.balanceOf(wallet)),
      ...EXCHANGES.map((e) => safe(() => erc20.allowance(wallet, e.addr))),
      ...EXCHANGES.map((e) => safe(() => ctf.isApprovedForAll(wallet, e.addr))),
      safe(() => (tokenId ? ctf.balanceOf(wallet, BigInt(tokenId)) : Promise.resolve(null))),
      safe(() => (tokenIdNo ? ctf.balanceOf(wallet, BigInt(tokenIdNo)) : Promise.resolve(null))),
    ]);
    const n = EXCHANGES.length;
    const allowRaw = rest.slice(0, n) as (bigint | null)[];
    const approvedRaw = rest.slice(n, 2 * n) as (boolean | null)[];
    const yesRaw = rest[2 * n] as bigint | null;
    const noRaw = rest[2 * n + 1] as bigint | null;

    const asUsd = (v: bigint | null) => (v == null || dec == null ? null : Number(formatUnits(v, dec)));
    // Outcome tokens are whole shares on the CTF (18-dec-free ERC-1155 ids) — the raw integer IS the
    // share count, so it is reported as-is rather than scaled by a decimals() this contract has none of.
    const asShares = (v: bigint | null) => (v == null ? null : Number(v));

    const pusdBalance = asUsd(balRaw as bigint | null);
    return {
      wallet,
      walletSource: source,
      // We reached the node if ANY call came back. A wallet with no history still returns a real 0 here.
      rpcReachable: maticRaw != null || balRaw != null,
      maticBalance: maticRaw == null ? null : Number(formatEther(maticRaw as bigint)),
      pusdBalance,
      pusdReserved: null,
      reservedReason,
      // available = balance − reserved, and reserved is unknown ⇒ available is unknown. Printing the
      // balance here would assert "nothing is reserved", which we did not read.
      pusdAvailable: null,
      approvals: EXCHANGES.map((e, i) => ({
        key: e.key, name: e.name, addr: e.addr,
        collateralAllowance: asUsd(allowRaw[i]),
        outcomeApproved: approvedRaw[i],
      })),
      yesTokenBalance: asShares(yesRaw),
      noTokenBalance: asShares(noRaw),
      readAt,
    };
  } catch {
    return { ...base, wallet, walletSource: source };
  } finally {
    try { provider.destroy(); } catch { /* provider already closed */ }
  }
}
