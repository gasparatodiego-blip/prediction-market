#!/usr/bin/env python3
"""
Forensic replay of the recorded sport-arb raw order-book feed.

READ-ONLY. Streams a large raw JSONL feed line-by-line (never loads it fully),
filters to one event over a time window, and reconstructs the per-leg
(price / size / freshness) time series so a human can judge whether a given
quote was LIVE (moving) or STALE (byte-identical / cached / not takeable).

It does NOT change any classification logic. It only measures and prints.

Usage:
  python3 scripts/sport-arb-forensic-replay.py \
      --file data/sport-raw/2026-07-21.jsonl \
      --event "dallas wings" \
      --window 1784598684944:1784599824952 \
      [--source polymarket] [--outcome home]

--window is inclusive, in epoch milliseconds (startMs:endMs).
--event is a case-insensitive substring matched against event_key.
"""
import argparse, json, hashlib, sys, datetime as dt


def u(ms):
    if ms is None:
        return "—"
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime("%H:%M:%S")


def best_ask_of(rec):
    """Executable taker price to BUY this outcome, and size at that level."""
    ba = rec.get("best_ask")
    bas = rec.get("best_ask_size")
    return ba, bas


def depth_hash(rec):
    dl = rec.get("depth_levels")
    if dl is None:
        return "—"
    return hashlib.sha1(json.dumps(dl, sort_keys=True).encode()).hexdigest()[:10]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--event", required=True, help="substring of event_key (case-insensitive)")
    ap.add_argument("--window", required=True, help="startMs:endMs epoch ms, inclusive")
    ap.add_argument("--source", default=None, help="optional source filter (polymarket/kalshi/...)")
    ap.add_argument("--outcome", default=None, help="optional outcome filter (home/away)")
    args = ap.parse_args()

    start, end = (int(x) for x in args.window.split(":"))
    ev = args.event.lower()

    # collect only matching lines; a single event over ~20 min is a tiny subset
    series = {}  # (source, outcome) -> list of records
    scanned = 0
    for line in open(args.file):
        scanned += 1
        if ev not in line.lower():
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        if ev not in (o.get("event_key") or "").lower():
            continue
        t = o.get("ts")
        if t is None or t < start or t > end:
            continue
        if args.source and o.get("source") != args.source:
            continue
        if args.outcome and o.get("outcome") != args.outcome:
            continue
        key = (o.get("source"), o.get("outcome"))
        series.setdefault(key, []).append(o)
        if scanned % 2000000 == 0:
            print(f"  ...scanned {scanned:,} lines", file=sys.stderr)

    print(f"scanned {scanned:,} lines; matched {sum(len(v) for v in series.values())} records "
          f"across {len(series)} (source,outcome) legs\n")

    for key in sorted(series, key=lambda k: (str(k[0]), str(k[1]))):
        recs = sorted(series[key], key=lambda r: r["ts"])
        src, out = key
        print(f"===== {src} / outcome={out}  ({len(recs)} snapshots) =====")
        print(f"{'wallclk':>8} {'srcTs':>8} {'age':>4} {'bid':>6} {'ask':>6} "
              f"{'askSz':>10} {'bidSz':>10} {'live':>5} {'acc':>4} {'depthHash':>10}")
        prev_hash = None
        prev_srcts = None
        distinct_payloads = 0
        distinct_srcts = 0
        srcts_gaps = []
        for r in recs:
            h = depth_hash(r)
            ba, bas = best_ask_of(r)
            bb = r.get("best_bid")
            bbs = r.get("best_bid_size")
            # parse source_ts to ms
            sts = r.get("source_ts")
            sts_ms = None
            if isinstance(sts, str):
                try:
                    sts_ms = int(dt.datetime.fromisoformat(sts.replace("Z", "+00:00")).timestamp() * 1000)
                except Exception:
                    sts_ms = None
            acc = r.get("accepting_orders")
            acc_s = "—" if acc is None else ("Y" if acc else "N")
            live_s = "Y" if r.get("is_live") else "n"
            mark = "" if h == prev_hash else "  <-- CHANGED"
            print(f"{u(r['ts']):>8} {u(sts_ms):>8} {str(r.get('age_sec')):>4} "
                  f"{str(bb):>6} {str(ba):>6} {str(bas):>10} {str(bbs):>10} "
                  f"{live_s:>5} {acc_s:>4} {h:>10}{mark}")
            if h != prev_hash:
                distinct_payloads += 1
                prev_hash = h
            if sts_ms != prev_srcts:
                if prev_srcts is not None and sts_ms is not None:
                    srcts_gaps.append((sts_ms - prev_srcts) / 1000)
                distinct_srcts += 1
                prev_srcts = sts_ms
        span = (recs[-1]["ts"] - recs[0]["ts"]) / 1000 if len(recs) > 1 else 0
        print(f"  -> {len(recs)} snapshots over {span:.0f}s | "
              f"distinct depth payloads: {distinct_payloads} | "
              f"distinct source_ts: {distinct_srcts}")
        if srcts_gaps:
            print(f"  -> source_ts refresh gaps (s): "
                  f"min {min(srcts_gaps):.0f} / med {sorted(srcts_gaps)[len(srcts_gaps)//2]:.0f} / max {max(srcts_gaps):.0f}")
        print()


if __name__ == "__main__":
    main()
