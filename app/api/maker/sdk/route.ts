import { NextResponse } from 'next/server';
// @ts-ignore — CommonJS adapter (allowJs). Only the two PURE functions are imported: neither reads a
// key, opens a connection, or constructs an order.
import { v2SdkStatus, evaluatePlacementGate } from '@/lib/venues/polymarket-clob-maker/adapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/maker/sdk — does the CLOB v2 SDK gate still fire, IN THIS PROCESS?
 *
 * WHY IT EXISTS. The SDK gate is the one refusal that cannot be checked by trying: reaching it through
 * POST /api/maker/manual/order means submitting a quote that has already passed venue-rules, caps and
 * the kill switch, and if the gate then opens the order is REALLY SENT (MANUAL_ORDER_PLACEMENT governs
 * that path and it is not a dry-run switch for a valid quote). So "is it fixed?" had no zero-cost answer.
 * This endpoint gives one.
 *
 * IT ALSO ANSWERS A QUESTION NODE CANNOT. v2SdkStatus() resolves the SDK differently under webpack than
 * under plain node — that difference IS the bug it was written to expose (webpack compiled
 * `require.resolve(pkg)` to a numeric module id, so `path.dirname()` threw and a correctly installed
 * 1.1.0 was reported absent). Running the same function from a shell proves nothing about the bundle the
 * dashboard actually executes. This route runs it inside that bundle.
 *
 * READ-ONLY, AND NARROWER THAN IT LOOKS. It calls two pure functions: one stats package.json off disk,
 * the other is arithmetic over flags. No order object, no signing key, no venue call, no state written.
 * It cannot place, cancel, arm or kill.
 *
 * WHAT `gate` IS NOT. It evaluates only the SDK → mode → dry-run → funding sub-chain, at the values the
 * manual panel's adapter is really constructed with. The kill switch, the venue allowlist and the
 * server-side risk limits are deliberately NOT included: those are decided at order time by their own
 * fail-closed readers, and reproducing them here would invite reading this as "an order would go
 * through". It is not that. It answers exactly one question: does the SDK gate still refuse.
 *
 * Admin-gated by middleware (ADMIN_ACCESS_SECRET).
 */
export async function GET() {
  try {
    const sdk = v2SdkStatus();

    // The values buildPlacementAdapter (lib/maker/manual-order) really passes: the mode is hardcoded
    // 'live-min' there, the other two are read from THIS process's environment — the same environment
    // the placement path would read. Reported raw alongside the verdict so nothing is taken on trust.
    const mode = 'live-min';
    const dryRun = process.env.MAKER_ADAPTER_DRYRUN === 'true' || process.env.MAKER_ADAPTER_DRYRUN === '1';
    const fundingApproved = process.env.MAKER_FUNDING_APPROVED === 'true';

    const gate = evaluatePlacementGate({ mode, dryRun, fundingApproved, sdk });
    const sdkGateFires = gate.gate === 'v2-sdk-missing' || gate.gate === 'v2-sdk-major';

    return NextResponse.json({
      at: new Date().toISOString(),
      sdk,
      sdkGateFires,
      gate,
      inputs: { mode, dryRun, fundingApproved, modeSource: 'hardcoded in buildPlacementAdapter', envKeys: ['MAKER_ADAPTER_DRYRUN', 'MAKER_FUNDING_APPROVED'] },
      note: sdkGateFires
        ? 'Il gate SDK RIFIUTA ancora in questo processo.'
        : 'Il gate SDK non rifiuta più in questo processo. Questo NON significa che un ordine passerebbe: kill-switch, allowlist di venue e limiti di rischio sono valutati a parte, al momento dell’ordine, dai loro lettori fail-closed.',
    });
  } catch (e) {
    return NextResponse.json(
      { at: new Date().toISOString(), error: (e as Error).message, sdk: null, sdkGateFires: null, gate: null },
      { status: 500 },
    );
  }
}
