import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { readArming } from '@/lib/maker/arming';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/maker/gates — READ-ONLY. The four gates the market screen's execution section states, each with
 * its REAL value and how to change it. Admin-gated by middleware (everything under /api/maker is).
 *
 * WHOSE TRUTH: the dashboard is a different pm2 process with its own environment, so reading
 * process.env.MAKER_MODE here would answer a question nobody asked — the engine's environment is what
 * governs whether an order can be placed. Every gate below is therefore read from the ENGINE's own
 * published state (/tmp/maker-state.json, written by agent35 every cycle) and carries the age of that
 * state. When the engine's state is missing or stale, the gate reports `null` with a stated reason: not
 * knowing whether the engine is live and believing it is off are different facts.
 *
 * This endpoint CHANGES NOTHING. It sets no env, arms nothing, and touches no order path.
 */

const STATE_FILE = '/tmp/maker-state.json';
// agent35 ticks every 3s; past this the file is not describing the running engine.
const STATE_STALE_MS = 60_000;

function readJson(p: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export async function GET() {
  const now = Date.now();
  const state = readJson(STATE_FILE);
  const hb = readJson(path.join(process.cwd(), 'data', 'maker-heartbeat.json'));

  const stateTs = state?.generatedAt ? Date.parse(state.generatedAt) : NaN;
  const stateAgeMs = Number.isFinite(stateTs) ? now - stateTs : null;
  const engineFresh = stateAgeMs != null && stateAgeMs >= 0 && stateAgeMs <= STATE_STALE_MS;

  // Only a FRESH engine state may answer a gate. Otherwise every gate is null + a reason.
  const unknownReason = state == null
    ? 'il motore non ha ancora pubblicato uno stato (/tmp/maker-state.json assente)'
    : !engineFresh
      ? `stato del motore vecchio di ${stateAgeMs != null ? Math.round(stateAgeMs / 1000) : '—'}s — non descrive il processo in esecuzione`
      : null;

  const mode: string | null = engineFresh && typeof state?.mode === 'string' ? state.mode : null;
  const fundingApproved: boolean | null =
    engineFresh && typeof state?.fundingApproved === 'boolean' ? state.fundingApproved : null;

  // The durable arming record is read directly (same module the arm route and the engine use), so the
  // TTL is enforced on this read too — an expired arm can never be reported as armed.
  let arming: { armed: boolean; expiresInSec: number | null; expiresAt: string | null; totalSizeUsd: number | null; ttlSeconds: number | null } = {
    armed: false, expiresInSec: null, expiresAt: null, totalSizeUsd: null, ttlSeconds: null,
  };
  try {
    const a = readArming();
    arming = {
      armed: !!a.armed,
      expiresInSec: a.expiresInSec ?? null,
      expiresAt: a.record?.expiresAt ?? null,
      totalSizeUsd: a.record?.totalSizeUsd ?? null,
      ttlSeconds: a.record?.ttlSeconds ?? null,
    };
  } catch { /* fail closed: stays disarmed */ }

  return NextResponse.json({
    at: new Date(now).toISOString(),
    engine: {
      fresh: engineFresh,
      ageSec: stateAgeMs != null ? Math.round(stateAgeMs / 1000) : null,
      cycle: typeof hb?.cycle === 'number' ? hb.cycle : null,
      lastError: typeof hb?.lastError === 'string' ? hb.lastError : null,
      unknownReason,
    },
    gates: {
      // STEP 2 — the human attestation that the wallet is funded and the v2 approvals are granted.
      funding: {
        key: 'MAKER_FUNDING_APPROVED',
        value: fundingApproved,
        pass: fundingApproved === true,
        how: 'attestazione umana: si imposta MAKER_FUNDING_APPROVED=true nell\'ambiente del motore (agents/ecosystem.config.js) dopo aver finanziato pUSD sul funder e concesso le approvazioni ai due exchange v2, poi si riavvia agent35-maker.',
      },
      // STEP 3 — the staged activation ladder. Only live-min / live can reach a venue write.
      mode: {
        key: 'MAKER_MODE',
        value: mode,
        pass: mode === 'live-min' || mode === 'live',
        ladder: ['off', 'paper', 'live-min', 'live'],
        how: 'si cambia MAKER_MODE nell\'ambiente del motore (agents/ecosystem.config.js) e si riavvia agent35-maker. off e paper non possono raggiungere una scrittura sul venue.',
      },
      // The durable kill, and the engine's own view of whether a venue write is reachable at all.
      kill: {
        killed: engineFresh ? !!state?.durableKill?.killed : null,
        reason: state?.durableKill?.reason ?? null,
      },
      canWrite: engineFresh && typeof state?.canWrite === 'boolean' ? state.canWrite : null,
    },
    arming,
    source: '/tmp/maker-state.json (agent35-maker) + data/maker-arming.json — read-only, changes nothing',
  });
}
