import { NextResponse } from 'next/server';
import { readChainState } from '@/lib/poly-chain-read';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/rewards/balance — the Polymarket PROXY's real pUSD collateral, for the allocation page.
 *
 * READ-ONLY, PUBLIC. It calls lib/poly-chain-read.readChainState(null, null): an eth_call for the PROXY
 * (funder) balance only — no market tokens, no CLOB credential, no signature, no order object. It cannot
 * arm, fund, approve, sign or place. The proxy is resolved from the stored custody / env, NEVER the signer;
 * both addresses are returned, labelled, so the funder and the signer can never be confused.
 *
 * FRESHNESS CONTRACT (honest-engine): the balance is cached with the chain's own readAt. On an RPC failure
 * the LAST GOOD read is returned only when labelled with its TRUE age (stale:true); if none was ever read,
 * pusdBalance is null → the page renders "—". A genuine on-chain zero (pusdBalance === 0) and an unknown
 * balance (null) are DISTINCT in the payload and must render differently.
 */

const CACHE_MS = 60_000; // balance moves only on fund/withdraw or a fill (maker disarmed → none); 60s is ample

type BalancePayload = {
  proxy: string | null;
  proxySource: 'env' | 'custody' | 'env-funder' | null;
  signer: string | null;
  pusdBalance: number | null; // null = never read (unknown); 0 = genuine on-chain zero
  rpcReachable: boolean;
  readAt: string | null; // ISO of the chain read the balance came from
  ageSeconds: number | null; // age of that read at response time
  stale: boolean; // true when serving a PRIOR read because this refresh failed
  latencyMs: number | null; // measured eth_call latency of the freshest attempt
  cadenceSeconds: number; // how often this route re-reads the chain
  note: string;
};

// Module-scope cache of the last SUCCESSFUL read (survives across requests in the same server process).
let lastGood: { payload: BalancePayload; atMs: number } | null = null;

export async function GET() {
  const now = Date.now();
  // Serve the cache if fresh.
  if (lastGood && now - lastGood.atMs < CACHE_MS) {
    const age = lastGood.payload.readAt ? Math.round((now - Date.parse(lastGood.payload.readAt)) / 1000) : null;
    return NextResponse.json({ ...lastGood.payload, ageSeconds: age, stale: false });
  }

  const t0 = Date.now();
  let read;
  try {
    read = await readChainState(null, null); // PROXY balance only — no tokens, no credential
  } catch {
    read = null;
  }
  const latencyMs = Date.now() - t0;
  const readSucceeded = !!read && read.rpcReachable && read.pusdBalance !== null;

  if (readSucceeded) {
    const payload: BalancePayload = {
      proxy: read!.wallet,
      proxySource: read!.walletSource,
      signer: read!.signer,
      pusdBalance: read!.pusdBalance, // 0 stays 0 (genuine); a real number stays a number
      rpcReachable: true,
      readAt: read!.readAt,
      ageSeconds: 0,
      stale: false,
      latencyMs,
      cadenceSeconds: CACHE_MS / 1000,
      note: 'saldo pUSD reale del proxy (funder), letto on-chain in sola lettura',
    };
    lastGood = { payload, atMs: now };
    return NextResponse.json(payload);
  }

  // Refresh FAILED. Serve the last good read ONLY when labelled with its true age; else "—" (null).
  if (lastGood) {
    const age = lastGood.payload.readAt ? Math.round((now - Date.parse(lastGood.payload.readAt)) / 1000) : null;
    return NextResponse.json({
      ...lastGood.payload,
      ageSeconds: age,
      stale: true,
      latencyMs,
      note: `lettura on-chain fallita: mostro il valore precedente di ${age == null ? '—' : age + 's'} fa (non aggiornato)`,
    });
  }
  return NextResponse.json({
    proxy: read?.wallet ?? null,
    proxySource: read?.walletSource ?? null,
    signer: read?.signer ?? null,
    pusdBalance: null, // never read → unknown, NOT zero
    rpcReachable: !!read?.rpcReachable,
    readAt: null,
    ageSeconds: null,
    stale: false,
    latencyMs,
    cadenceSeconds: CACHE_MS / 1000,
    note: 'saldo mai letto (RPC non raggiungibile): sconosciuto, non zero',
  } satisfies BalancePayload);
}
