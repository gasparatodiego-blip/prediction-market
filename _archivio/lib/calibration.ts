import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(process.cwd(), 'data', 'opportunities.db');

export const CALIBRATION_BUCKETS = [
  { key: '0-1',    min: 0,   max: 1   },
  { key: '1-3',    min: 1,   max: 3   },
  { key: '3-5',    min: 3,   max: 5   },
  { key: '5-8',    min: 5,   max: 8   },
  { key: '8-12',   min: 8,   max: 12  },
  { key: '12-20',  min: 12,  max: 20  },
  { key: '20-30',  min: 20,  max: 30  },
  { key: '30-50',  min: 30,  max: 50  },
  { key: '50-70',  min: 50,  max: 70  },
  { key: '70-88',  min: 70,  max: 88  },
  { key: '88-95',  min: 88,  max: 95  },
  { key: '95-101', min: 95,  max: 101 },
];

export interface CalibrationBucket {
  bucket_key:  string;
  bucket_min:  number;
  bucket_max:  number;
  total:       number;
  yes_count:   number;
  hit_rate:    number;  // 0–1 fraction
  updated_at:  string;
}

/** bias_score = (market_prob_pct − historical_hit_rate_pct) / market_prob_pct
 *  positive → market is overpriced vs history (longshot bias)
 *  null     → not enough calibration data */
export function computeBiasScore(prob: number, buckets: CalibrationBucket[]): number | null {
  const b = buckets.find(bkt => prob >= bkt.bucket_min && prob < bkt.bucket_max);
  if (!b || b.total < 10) return null;
  const hitRatePct = b.hit_rate * 100;
  if (prob <= 0) return null;
  return (prob - hitRatePct) / prob;
}

export function openCalibrationDb(): Database.Database {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS calibration_markets (
      id           TEXT PRIMARY KEY,
      source       TEXT NOT NULL,
      final_prob   REAL NOT NULL,
      resolved_yes INTEGER NOT NULL,
      fetched_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS calibration_buckets (
      bucket_key TEXT PRIMARY KEY,
      bucket_min REAL NOT NULL,
      bucket_max REAL NOT NULL,
      total      INTEGER NOT NULL,
      yes_count  INTEGER NOT NULL,
      hit_rate   REAL NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

export function loadBucketsSync(): CalibrationBucket[] {
  try {
    const db   = openCalibrationDb();
    const rows = db.prepare('SELECT * FROM calibration_buckets ORDER BY bucket_min').all() as CalibrationBucket[];
    db.close();
    return rows;
  } catch { return []; }
}

export async function runCalibration(): Promise<CalibrationBucket[]> {
  const raw: Array<{ id: string; prob: number; resolvedYes: boolean }> = [];

  for (const offset of [0, 500]) {
    try {
      const url  = `https://api.manifold.markets/v0/search-markets?term=&limit=500&filter=resolved&offset=${offset}`;
      const res  = await fetch(url, { cache: 'no-store' });
      if (!res.ok) break;
      const data = await res.json() as any[];
      if (!Array.isArray(data) || data.length === 0) break;

      for (const m of data) {
        if (m.outcomeType !== 'BINARY')            continue;
        if (!['YES', 'NO'].includes(m.resolution)) continue;
        if (typeof m.probability !== 'number')      continue;
        raw.push({
          id:          `mf-${m.id}`,
          prob:        m.probability * 100,
          resolvedYes: m.resolution === 'YES',
        });
      }
    } catch { break; }
  }

  if (raw.length === 0) return loadBucketsSync();

  const db = openCalibrationDb();
  const ts = new Date().toISOString();

  const ins = db.prepare(`
    INSERT OR REPLACE INTO calibration_markets (id, source, final_prob, resolved_yes, fetched_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const m of raw) ins.run(m.id, 'manifold', m.prob, m.resolvedYes ? 1 : 0, ts);
  })();

  const all = db.prepare(
    'SELECT final_prob, resolved_yes FROM calibration_markets'
  ).all() as Array<{ final_prob: number; resolved_yes: number }>;

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO calibration_buckets
      (bucket_key, bucket_min, bucket_max, total, yes_count, hit_rate, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const bkt of CALIBRATION_BUCKETS) {
      const inBkt   = all.filter(m => m.final_prob >= bkt.min && m.final_prob < bkt.max);
      const yesCnt  = inBkt.filter(m => m.resolved_yes === 1).length;
      const hitRate = inBkt.length > 0 ? yesCnt / inBkt.length : 0;
      upsert.run(bkt.key, bkt.min, bkt.max, inBkt.length, yesCnt, hitRate, ts);
    }
  })();

  const buckets = db.prepare(
    'SELECT * FROM calibration_buckets ORDER BY bucket_min'
  ).all() as CalibrationBucket[];
  db.close();
  return buckets;
}
