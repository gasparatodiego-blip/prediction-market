#!/usr/bin/env python3
"""
Cross-venue arbitrage sweep over the recorded raw sport feed. READ-ONLY.

Answers: do genuine arbs exist between DIFFERENT venues (poly x book,
book x book, poly x kalshi) when same-event identity is verified from
METADATA (not price correlation)?

Design decisions (see report for rationale):
  * Event identity is resolved to a specific GAME-DATE from metadata:
      - kalshi: date+time parsed from venue_ticker (KX..GAME-YYMONDDhhmm..)
      - polymarket: date parsed from slug (..-YYYY-MM-DD)
      - book/exchange: NO date in feed -> game_date UNKNOWN (unverifiable)
  * Pairs are formed only across DIFFERENT venues, complementary outcomes.
  * poly x kalshi pairs REQUIRE identical parsed game_date (full verify).
  * book-involving pairs cannot be date-verified (book has no date); they
    are reported separately and never enter a verified headline. Books also
    expose no size -> capacity UNKNOWN.
  * Taker pricing only: prediction leg = best_ask; book leg = implied `price`.
    No midpoints. Arb requires cost_sum < 1.0 at the SAME snapshot cycle.
  * Gates: leg source_ts skew <= 2s; any leg age_sec > 90 = phantom (dropped,
    counted separately).
  * Dedup: opportunities = contiguous runs of cycles (gap <= 90s) for the same
    (event_key, game_date, outcome-orientation, venue-pair).

Usage:
  python3 scripts/sport-cross-venue-sweep.py --date 2026-07-21 \
      [--bucket poly-kalshi|poly-book|book-book|all]
"""
import argparse, json, re, sys, datetime as dt
from collections import defaultdict

MONTHS = {m: i + 1 for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"])}

SKEW_MAX_S = 2.0
AGE_MAX_S = 90
DEDUP_GAP_S = 90


def parse_kalshi_date(ticker):
    # KXMLBGAME-26JUL201840MINCLE-CLE  or  KXWNBAGAME-26JUL20NYDAL-NY (no time)
    if not ticker:
        return None
    m = re.search(r'-(\d{2})([A-Z]{3})(\d{2})(\d{4})?', ticker)
    if not m:
        return None
    yy, mon, dd = m.group(1), m.group(2), m.group(3)
    if mon not in MONTHS:
        return None
    return f"20{yy}-{MONTHS[mon]:02d}-{int(dd):02d}"


def parse_poly_date(slug):
    # wnba-nyl-dal-2026-07-20 / mlb-sd-atl-2026-07-23
    if not slug:
        return None
    m = re.search(r'(\d{4})-(\d{2})-(\d{2})$', slug)
    return m.group(0) if m else None


def sts_ms(rec):
    s = rec.get("source_ts")
    if not isinstance(s, str):
        return None
    try:
        return int(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return None


def fee_net(cost, src, stype):
    """Net taker cost after the project's documented fee model.
    kalshi: +0.07*P*(1-P) ; polymarket: *1.01 ; book: vig already in price ;
    exchange: +2% commission (approx, applied as *1.02 on cost)."""
    if src == "kalshi":
        return cost + 0.07 * cost * (1 - cost)
    if src == "polymarket":
        return cost * 1.01
    if stype == "exchange":
        return cost * 1.02
    return cost  # book


def taker_cost(rec):
    """Implied cost to BUY this outcome as a taker; (gross, net, size_or_None)."""
    st = rec.get("source_type")
    src = rec.get("source")
    if st == "prediction":
        ba = rec.get("best_ask")
        if ba is None:
            return None, None, None
        return ba, fee_net(ba, src, st), rec.get("best_ask_size")
    p = rec.get("price")
    if p is None:
        return None, None, None
    return p, fee_net(p, src, st), None


def load(date):
    path = f"data/sport-raw/{date}.jsonl"
    # group: event_key -> ts -> list of compact legs
    groups = defaultdict(lambda: defaultdict(list))
    kalshi_tk = defaultdict(set)
    poly_slug = defaultdict(set)
    book_eid = defaultdict(set)
    n = 0
    for line in open(path):
        n += 1
        try:
            o = json.loads(line)
        except Exception:
            continue
        ek = o.get("event_key")
        src = o.get("source")
        stype = o.get("source_type")
        vt = o.get("venue_ticker")
        if src == "kalshi":
            kalshi_tk[ek].add(vt)
            gd = parse_kalshi_date(vt)
        elif src == "polymarket":
            poly_slug[ek].add(vt)
            gd = parse_poly_date(vt)
        else:
            book_eid[ek].add(o.get("event_id"))
            gd = None
        cost, netc, size = taker_cost(o)
        groups[ek][o["ts"]].append({
            "src": src, "stype": stype, "out": o.get("outcome"),
            "cost": cost, "netc": netc, "size": size, "gd": gd, "vt": vt,
            "sts": sts_ms(o), "age": o.get("age_sec"), "live": o.get("is_live"),
            "eid": o.get("event_id"),
        })
    return groups, kalshi_tk, poly_slug, book_eid, n


def game_dates_of(tickers, parser):
    ds = set()
    for t in tickers:
        d = parser(t)
        if d:
            ds.add(d)
    return ds


def bucket_of(a, b):
    sa, sb = a["src"], b["src"]
    if {sa, sb} == {"polymarket", "kalshi"}:
        return "poly-kalshi"
    if "polymarket" in (sa, sb) and (a["stype"] in ("book", "exchange") or b["stype"] in ("book", "exchange")):
        return "poly-book"
    if a["stype"] in ("book", "exchange") and b["stype"] in ("book", "exchange"):
        return "book-book"
    return None  # e.g. kalshi x book (kalshi has no verified date match to book) -> ignore per task scope


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True)
    ap.add_argument("--bucket", default="all",
                    choices=["all", "poly-kalshi", "poly-book", "book-book"])
    args = ap.parse_args()

    groups, kalshi_tk, poly_slug, book_eid, nlines = load(args.date)

    # ---------- PHASE 1 : identity / contamination ----------
    print(f"===== PHASE 1  identity & contamination  ({args.date}, {nlines:,} lines) =====")
    all_ev = set(groups)
    contaminated = {}
    for ek in sorted(all_ev):
        kd = game_dates_of(kalshi_tk.get(ek, ()), parse_kalshi_date)
        pd = game_dates_of(poly_slug.get(ek, ()), parse_poly_date)
        reasons = []
        if len(kd) > 1:
            reasons.append(f"{len(kd)} kalshi game-dates {sorted(kd)}")
        if len(pd) > 1:
            reasons.append(f"{len(pd)} poly slugs {sorted(pd)}")
        if kd and pd and not (kd & pd):
            reasons.append(f"kalshi/poly date disagree K{sorted(kd)} P{sorted(pd)}")
        if reasons:
            contaminated[ek] = reasons
    print(f"total event_keys: {len(all_ev)} | contaminated: {len(contaminated)} | "
          f"clean: {len(all_ev) - len(contaminated)}")
    for ek, rs in contaminated.items():
        print(f"  [QUARANTINE] {ek}")
        for r in rs:
            print(f"       - {r}")
    clean = all_ev - set(contaminated)
    print(f"\nclean event_keys ({len(clean)}):")
    for ek in sorted(clean):
        venues = set()
        for ts, legs in groups[ek].items():
            for l in legs:
                venues.add(l["src"] if l["src"] in ("kalshi", "polymarket") else l["stype"])
        print(f"  {ek:52} venues={sorted(venues)}")

    # ---------- PHASE 2-4 : cross-venue pairing ----------
    # NOTE: we enforce game-date identity at the PAIR level (stronger than the
    # coarse event_key quarantine): a poly-kalshi pair must share parsed dates.
    print(f"\n===== PHASE 2-4  cross-venue pairing (bucket={args.bucket}) =====")
    stats = defaultdict(lambda: {"same_venue_skipped": 0, "candidates": 0,
                                 "age_phantom": 0, "skew_dropped": 0,
                                 "date_mismatch_skipped": 0, "arb_cycles": 0,
                                 "arb_cycles_net": 0})
    # arb cycles collected for dedup:  key -> list of (ts, ...)
    arb_cycles = defaultdict(list)

    for ek in sorted(all_ev):
        for ts in sorted(groups[ek]):
            legs = groups[ek][ts]
            for i in range(len(legs)):
                for j in range(i + 1, len(legs)):
                    a, b = legs[i], legs[j]
                    # complementary outcomes only
                    if {a["out"], b["out"]} != {"home", "away"}:
                        continue
                    bk = bucket_of(a, b)
                    if bk is None:
                        continue
                    if args.bucket != "all" and bk != args.bucket:
                        continue
                    # EXCLUDE same-venue
                    if a["src"] == b["src"]:
                        stats[bk]["same_venue_skipped"] += 1
                        continue
                    # date identity gate
                    if bk == "poly-kalshi":
                        if not (a["gd"] and b["gd"] and a["gd"] == b["gd"]):
                            stats[bk]["date_mismatch_skipped"] += 1
                            continue
                    if a["cost"] is None or b["cost"] is None:
                        continue
                    stats[bk]["candidates"] += 1
                    # staleness guard
                    if (a["age"] or 0) > AGE_MAX_S or (b["age"] or 0) > AGE_MAX_S:
                        stats[bk]["age_phantom"] += 1
                        continue
                    # skew guard
                    if a["sts"] is not None and b["sts"] is not None:
                        skew = abs(a["sts"] - b["sts"]) / 1000.0
                    else:
                        skew = None
                    if skew is not None and skew > SKEW_MAX_S:
                        stats[bk]["skew_dropped"] += 1
                        continue
                    cost = a["cost"] + b["cost"]
                    netcost = a["netc"] + b["netc"]
                    if cost >= 1.0:
                        continue
                    stats[bk]["arb_cycles"] += 1
                    if netcost < 1.0:
                        stats[bk]["arb_cycles_net"] += 1
                    # orientation key: which venue holds which outcome
                    orient = tuple(sorted([(a["src"], a["out"]), (b["src"], b["out"])]))
                    key = (ek, a["gd"] or b["gd"], bk, orient)
                    size_a, size_b = a["size"], b["size"]
                    cap_known = size_a is not None and size_b is not None
                    arb_cycles[key].append({
                        "ts": ts, "cost": cost, "netcost": netcost,
                        "edge": 1.0 / cost - 1.0, "netedge": 1.0 / netcost - 1.0,
                        "a": a, "b": b, "skew": skew, "cap_known": cap_known,
                        "cap_shares": (min(size_a, size_b) if cap_known else None),
                    })

    print("\n-- gate accounting per bucket --")
    for bk in ("poly-kalshi", "poly-book", "book-book"):
        if args.bucket != "all" and bk != args.bucket:
            continue
        s = stats[bk]
        print(f"  {bk:12} same_venue_excluded={s['same_venue_skipped']:7} "
              f"date_mismatch_excluded={s['date_mismatch_skipped']:7} "
              f"candidates={s['candidates']:7} age>90_phantom={s['age_phantom']:6} "
              f"skew>2s_dropped={s['skew_dropped']:5} arb_cycles(gross)={s['arb_cycles']:5} "
              f"arb_cycles(NET)={s['arb_cycles_net']:5}")

    # dedup into opportunities (contiguous runs)
    print("\n===== RESULTS : deduped opportunities (contiguous window, gap<=90s) =====")
    def summarize(bk_filter):
        opps = []
        for key, cyc in arb_cycles.items():
            ek, gd, bk, orient = key
            if bk != bk_filter:
                continue
            cyc.sort(key=lambda c: c["ts"])
            run = [cyc[0]]
            for c in cyc[1:]:
                if (c["ts"] - run[-1]["ts"]) / 1000.0 <= DEDUP_GAP_S:
                    run.append(c)
                else:
                    opps.append((key, run)); run = [c]
            opps.append((key, run))
        return opps

    for bk in ("poly-kalshi", "poly-book", "book-book"):
        if args.bucket != "all" and bk != args.bucket:
            continue
        opps = summarize(bk)
        print(f"\n########## BUCKET {bk} : {len(opps)} opportunit(y/ies) ##########")
        if not opps:
            print("  (none)")
            continue
        edges = []
        for key, run in sorted(opps, key=lambda x: -max(c["edge"] for c in x[1])):
            ek, gd, _bk, orient = key
            first, last = run[0], run[-1]
            persist = (last["ts"] - first["ts"]) / 1000.0
            emax = max(c["edge"] for c in run) * 100
            emin = min(c["edge"] for c in run) * 100
            nemax = max(c["netedge"] for c in run) * 100
            net_survives = any(c["netcost"] < 1.0 for c in run)
            cap_known = all(c["cap_known"] for c in run)
            edges.append(emax)
            u = lambda ms: dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime('%m-%d %H:%M:%S')
            legdesc = " + ".join(f"{s}:{o}" for (s, o) in orient)
            flag = "" if net_survives else "   <-- VANISHES after fees (net cost >= 1.00)"
            print(f"\n  {ek}  game_date={gd}")
            print(f"    venues/orientation: {legdesc}")
            print(f"    window {u(first['ts'])} -> {u(last['ts'])}  ({persist:.0f}s, {len(run)} cycles)")
            print(f"    GROSS edge%: min {emin:.2f} / max {emax:.2f}  |  NET edge% max {nemax:.2f}{flag}")
            print(f"    cost_sum {first['cost']:.4f}->{last['cost']:.4f}  netcost {first['netcost']:.4f}->{last['netcost']:.4f}")
            # price path
            path = " ".join(f"{c['a']['cost']}+{c['b']['cost']}={c['cost']:.3f}" for c in run[:8])
            print(f"    path (a+b=cost): {path}{' ...' if len(run) > 8 else ''}")
            # capacity + skew + age
            skews = [c['skew'] for c in run if c['skew'] is not None]
            ages = [max(c['a']['age'] or 0, c['b']['age'] or 0) for c in run]
            if cap_known:
                capsh = min(c['cap_shares'] for c in run)
                capusd = capsh * first['cost']
                print(f"    bindingCapacity: {capsh:.2f} shares (~${capusd:.2f} deployable)  "
                      f"skew {min(skews) if skews else '—'}-{max(skews) if skews else '—'}s  maxAge {max(ages)}s")
            else:
                print(f"    bindingCapacity: UNKNOWN (>=1 book leg exposes no size)  "
                      f"skew {min(skews) if skews else '—'}-{max(skews) if skews else '—'}s  maxAge {max(ages)}s")
        if edges:
            edges.sort()
            print(f"\n  edge%% distribution: min {edges[0]:.2f} / med {edges[len(edges)//2]:.2f} / max {edges[-1]:.2f}")

    return arb_cycles


if __name__ == "__main__":
    main()
