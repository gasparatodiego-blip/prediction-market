// lib/execution/simulation-adapter.ts — the ONLY execution adapter in this build.
//
// It PLACES NO ORDER. submit() validates the plan is well-formed and echoes the estimate the
// ticket already showed, tagged simulated:true. There is deliberately no live adapter, no venue
// client import, and no key/permission access anywhere in this file. A real adapter is a future,
// separately-reviewed change gated behind EXECUTION_ENABLED (see ./types).

import { EXECUTION_ENABLED, type ExecutionAdapter, type ExecutionPlan, type ExecutionResult } from './types';

export class SimulationAdapter implements ExecutionAdapter {
  readonly kind = 'simulation' as const;

  async submit(plan: ExecutionPlan): Promise<ExecutionResult> {
    // Belt-and-suspenders: even if some future caller wired this to a live path, EXECUTION_ENABLED
    // is a hard `false`, so the simulation branch is the only reachable one in this build.
    if (EXECUTION_ENABLED) {
      // Unreachable in this build (const false). Intentionally does nothing but refuse — no live
      // adapter exists to delegate to, so we never fabricate a fill.
      return { ok: false, simulated: true, message: 'no live adapter is wired — simulation only' };
    }

    const legCount = Array.isArray(plan.legs) ? plan.legs.length : 0;
    if (legCount === 0) {
      return { ok: false, simulated: true, message: 'no in-band legs to place — nothing to simulate' };
    }
    return {
      ok: true,
      simulated: true,
      message: `simulated ${legCount} leg(s) on ${plan.venue} · no order was placed`,
    };
  }
}

/** The adapter the UI uses. Always simulation in this build. */
export const activeAdapter: ExecutionAdapter = new SimulationAdapter();
