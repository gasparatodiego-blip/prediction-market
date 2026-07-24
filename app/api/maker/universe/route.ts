import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import fs from 'fs';
import { prisma } from '@/lib/prisma';
import { getMakerSelection, saveMakerSelection } from '@/lib/maker/selection';
import { resolveMakerUniverse } from '@/lib/maker/universe';
import { resolveAdminServiceUserId } from '@/lib/admin-service-account';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FILE = '/tmp/liquidity-rewards.json';

function rawMarkets(): any[] {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    return Array.isArray(data.markets) ? data.markets : [];
  } catch {
    return [];
  }
}

// Shape the resolved set for display — PUBLIC board fields only (title/pool/venue are already public on
// the rewards board). Never any secret. Any Kalshi market present flips kalshiSelected so the UI can state
// the U.S.-eligibility fact.
function shapeResolved(selection: any) {
  const resolved = resolveMakerUniverse(rawMarkets(), selection);
  const markets = resolved.resolvedMarkets.map((m: any) => ({
    marketId: m.marketId,
    title: m.title || m.question || m.slug || m.ticker || m.marketId,
    dailyPool: typeof m.dailyPool === 'number' ? m.dailyPool : null,
    venue: m.venue || null,
  }));
  return {
    marketIds: resolved.resolvedMarketIds,
    markets,
    matchedBeforeCap: resolved.matchedBeforeCap,
    truncated: resolved.truncated,
    maxMarkets: resolved.maxMarkets,
    kalshiSelected: markets.some((m) => m.venue === 'kalshi'),
  };
}

// GET — PUBLIC (middleware exempts it).
//   • no params      → the CURRENT active bot universe + its resolved preview.
//   • ?preview=1&... → resolve the given board filter params as a WOULD-BE selection (no write), so the
//                      confirmation panel can show exactly what promoting the browsed filters would quote.
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    if (sp.get('preview') === '1') {
      const filters: Record<string, string> = {};
      for (const k of ['venue', 'category', 'minPool', 'minDepth', 'maxSpread', 'maxCompetition', 'hideThin']) {
        const v = sp.get(k);
        if (v != null && v !== '') filters[k] = v;
      }
      const maxMarkets = Number(sp.get('maxMarkets'));
      const selection = {
        filters,
        venues: ['polymarket'], // the bot's default venue restriction (it only quotes Polymarket)
        allowlist: [],
        denylist: [],
        maxMarkets: Number.isFinite(maxMarkets) && maxMarkets > 0 ? maxMarkets : 5,
      };
      return NextResponse.json({ preview: true, selection, resolved: shapeResolved(selection) });
    }
    const selection = await getMakerSelection(prisma);
    return NextResponse.json({ selection, resolved: shapeResolved(selection) });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'failed', selection: null, resolved: null }, { status: 500 });
  }
}

// POST — GATED by middleware (same ADMIN_ACCESS_SECRET as /settings). Writes the selection. Body:
// { filters, venues?, allowlist?, denylist?, maxMarkets? }. filters is the board's param object.
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || (body.filters != null && typeof body.filters !== 'object')) {
    return NextResponse.json({ error: 'Missing or invalid fields.' }, { status: 400 });
  }
  try {
    // Owner = the admin service account (the same login-incapable account the credential lane uses).
    const updatedBy = await resolveAdminServiceUserId(prisma);
    const previous = await getMakerSelection(prisma); // for the UI's "what is being replaced"
    const selection = await saveMakerSelection(
      prisma,
      {
        filters: body.filters ?? {},
        venues: Array.isArray(body.venues) ? body.venues : undefined,
        allowlist: Array.isArray(body.allowlist) ? body.allowlist : undefined,
        denylist: Array.isArray(body.denylist) ? body.denylist : undefined,
        maxMarkets: body.maxMarkets,
      },
      updatedBy,
    );
    const resolved = shapeResolved(selection);
    return NextResponse.json({ ok: true, selection, resolved, previous });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'failed to save selection' }, { status: 500 });
  }
}
