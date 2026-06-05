import { NextResponse } from 'next/server';
import fs from 'fs';

const SENTIMENT_FILE = '/tmp/sentiment-data.json';

export async function GET() {
  try {
    if (!fs.existsSync(SENTIMENT_FILE)) {
      return NextResponse.json({ entries: [], updatedAt: 0 });
    }
    const raw  = fs.readFileSync(SENTIMENT_FILE, 'utf8');
    const data = JSON.parse(raw);
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ entries: [], updatedAt: 0 });
  }
}
