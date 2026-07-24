import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
// The arming gate. Reads REAL state (offline signing, on-chain funder balance + approvals, cancel-creds,
// the in-process guard, the kill switch) at call time — never a cached flag. Read-only: it signs an order
// OFFLINE (submits nothing) and otherwise only reads. Importing the placement adapter is deliberately
// avoided; this route cannot place anything.
import { runPreflight } from '@/lib/maker/preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/maker/preflight — run all six checks and return the table + go verdict. Admin-gated (middleware).
 * Always HTTP 200 with the table; the `go` boolean carries the verdict (a red check ⇒ go:false, no override).
 */
export async function GET() {
  try {
    const r = await runPreflight({ prisma, env: process.env });
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json(
      { at: new Date().toISOString(), checks: [], go: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
