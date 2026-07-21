// lib/execution/types.ts — execution-ready contract for the liquidity-rewards placement ticket.
//
// SIMULATION ONLY IN THIS BUILD. These types define the EXACT object a real venue adapter would
// consume later, but no adapter here sends a real order. Guarding the whole surface:
//
//   • EXECUTION_ENABLED is a hard compile-time `false` — NOT an env var, NOT user-toggleable.
//     Every "arm/submit" affordance is gated on it, so a real order is impossible in this build.
//   • This module imports NOTHING that reads a key or talks to a venue with trading permission
//     (no lib/key-custody, no venue REST client). It is pure data + a simulation adapter.
//
// To wire real execution LATER (a separate, reviewed change): implement ExecutionAdapter against a
// venue client, flip EXECUTION_ENABLED, and add the credential/permission path behind it. Until
// then the only adapter is SimulationAdapter, which returns the estimate and places no order.

export const EXECUTION_ENABLED = false as const;   // hard OFF — do not read env, do not toggle in UI

export type Venue = 'polymarket' | 'kalshi';
export type LegSide = 'yes' | 'no';

/** One resting order the plan would place. priceCents is executable (snapped to the market tick). */
export interface ExecutionLeg {
  side:       LegSide;
  priceCents: number;
  sizeUsd:    number;
}

/** The structured plan the placement UI emits — the exact shape real execution will consume. */
export interface ExecutionPlan {
  venue:           Venue;
  marketId:        string;      // Polymarket conditionId / Kalshi ticker
  legs:            ExecutionLeg[];
  distanceFromMid: number;      // cents, representative distance of the plan from the executable mid
  createdAtIso:    string;      // stamped by the caller (UI) — this module never calls Date
}

/** What a submit returns. In simulation, `simulated` is always true and no order id exists. */
export interface ExecutionResult {
  ok:         boolean;
  simulated:  boolean;
  message:    string;
  /** Echo of the plan's estimate at submit time (gross $/day, share). Never a fill. */
  estimate?:  { grossDailyUsd: number | null; sharePct: number };
  orderIds?:  string[];         // only ever populated by a REAL adapter (none exists in this build)
}

/** The interface a real venue adapter would implement. Only SimulationAdapter is provided. */
export interface ExecutionAdapter {
  readonly kind: 'simulation' | 'live';
  submit(plan: ExecutionPlan): Promise<ExecutionResult>;
}
