import { NextResponse } from 'next/server';
import fs from 'fs';

const FILE = '/tmp/marketmaker-opps.json';

export interface MmOpp {
  source:       string;
  marketTitle:  string;
  url:          string | null;
  currentProb:  number;
  coin:         string;
  movePct:      number;
  direction:    'UP' | 'DOWN';
  confidence:   number;
  action:       string;
  kellyFrac:    number;
  detectedAt:   number;
}

export interface MmResponse {
  updatedAt:     number | null;
  opportunities: MmOpp[];
  dataAge:       number;
}

export async function GET(): Promise<NextResponse<MmResponse>> {
  let data: { updatedAt?: number; opportunities?: MmOpp[] } | null = null;
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}

  const now     = Date.now();
  const updated = data?.updatedAt ?? null;

  return NextResponse.json({
    updatedAt:     updated,
    opportunities: data?.opportunities ?? [],
    dataAge:       updated ? now - updated : 9999999,
  });
}
