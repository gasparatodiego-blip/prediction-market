import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'opportunities.db');

function getDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunities (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp    TEXT    NOT NULL,
      event_name   TEXT    NOT NULL,
      platform_low  TEXT   NOT NULL,
      platform_high TEXT   NOT NULL,
      prob_low     REAL    NOT NULL,
      prob_high    REAL    NOT NULL,
      roi          REAL    NOT NULL,
      spread       REAL    NOT NULL
    )
  `);
  return db;
}

export async function GET() {
  try {
    const db = getDb();
    const records = db.prepare(
      'SELECT * FROM opportunities ORDER BY id DESC LIMIT 100'
    ).all();
    db.close();
    return NextResponse.json({ records });
  } catch (err: any) {
    return NextResponse.json({ records: [], error: err.message }, { status: 200 });
  }
}
