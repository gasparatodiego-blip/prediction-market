import type { Metadata } from "next";
import {
  Instrument_Serif,
  IBM_Plex_Mono,
  Hanken_Grotesk,
  Fraunces,
  Spectral,
  JetBrains_Mono,
  Archivo,
  Sora,
  Manrope,
  Newsreader,
  Anton,
  Baloo_2,
  Nunito_Sans,
  Bebas_Neue,
  Libre_Baskerville,
  Syne,
  Spline_Sans_Mono,
  Martian_Mono,
} from "next/font/google";
import styles from "./gallery.module.css";

// ─────────────────────────────────────────────────────────────────────────────
// THROWAWAY PREVIEW ROUTE — /preview/landings
// 12 distinct landing hero directions for the same product (Edgeradar), shown
// side by side so a direction can be chosen. NOT the real landing. Every number
// here is a STATIC illustrative placeholder — this route is never wired to the
// honest-engine data. Delete after a direction is picked.
// ─────────────────────────────────────────────────────────────────────────────

export const metadata: Metadata = {
  title: "Preview · Landing Gallery",
  robots: { index: false, follow: false },
};

// ── Fonts (one deliberate pairing per direction, none reused) ────────────────
const instrument = Instrument_Serif({ subsets: ["latin"], weight: ["400"], style: ["normal", "italic"], variable: "--f-instrument", display: "swap" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--f-plexmono", display: "swap" });
const hanken = Hanken_Grotesk({ subsets: ["latin"], variable: "--f-hanken", display: "swap" });
const fraunces = Fraunces({ subsets: ["latin"], style: ["normal", "italic"], variable: "--f-fraunces", display: "swap" });
const spectral = Spectral({ subsets: ["latin"], weight: ["300", "400", "500", "600"], style: ["normal", "italic"], variable: "--f-spectral", display: "swap" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--f-jetbrains", display: "swap" });
const archivo = Archivo({ subsets: ["latin"], variable: "--f-archivo", display: "swap" });
const sora = Sora({ subsets: ["latin"], variable: "--f-sora", display: "swap" });
const manrope = Manrope({ subsets: ["latin"], variable: "--f-manrope", display: "swap" });
const newsreader = Newsreader({ subsets: ["latin"], style: ["normal", "italic"], variable: "--f-newsreader", display: "swap" });
const anton = Anton({ subsets: ["latin"], weight: ["400"], variable: "--f-anton", display: "swap" });
const baloo = Baloo_2({ subsets: ["latin"], variable: "--f-baloo", display: "swap" });
const nunito = Nunito_Sans({ subsets: ["latin"], variable: "--f-nunito", display: "swap" });
const bebas = Bebas_Neue({ subsets: ["latin"], weight: ["400"], variable: "--f-bebas", display: "swap" });
const baskerville = Libre_Baskerville({ subsets: ["latin"], weight: ["400", "700"], style: ["normal", "italic"], variable: "--f-baskerville", display: "swap" });
const syne = Syne({ subsets: ["latin"], variable: "--f-syne", display: "swap" });
const splineMono = Spline_Sans_Mono({ subsets: ["latin"], variable: "--f-splinemono", display: "swap" });
const martian = Martian_Mono({ subsets: ["latin"], variable: "--f-martian", display: "swap" });

// every font variable available page-wide (attached to <main>)
const allFontVars = [
  instrument, plexMono, hanken, fraunces, spectral, jetbrains, archivo, sora,
  manrope, newsreader, anton, baloo, nunito, bebas, baskerville, syne, splineMono, martian,
].map((f) => f.variable).join(" ");

// ── Deterministic helpers (seeded — no Math.random, stable render) ───────────
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Direction 01 — the field of ~340 markets, 9 glowing in tier colours
const fieldRng = mulberry32(20260714);
const FIELD = Array.from({ length: 340 }, () => ({
  x: fieldRng() * 100,
  y: fieldRng() * 100,
  s: 1.2 + fieldRng() * 2.2,
  o: 0.1 + fieldRng() * 0.32,
}));
const TIERS = ["mint", "amber", "violet"] as const;
const GLOW = [18, 47, 92, 133, 170, 214, 251, 288, 320].map((i, k) => ({
  i,
  tier: TIERS[k % 3],
}));
const glowMap = new Map(GLOW.map((g) => [g.i, g.tier]));

// Direction 07 — one big "live-looking" chart (illustrative series)
const chartRng = mulberry32(4242);
const N = 56;
const series = Array.from({ length: N }, (_, k) => {
  const base = 18 + k * 0.9 + Math.sin(k / 4) * 6;
  return Math.max(4, base + (chartRng() - 0.5) * 14);
});
const maxY = Math.max(...series);
const W = 1000, H = 420;
const pts = series.map((v, k) => [
  (k / (N - 1)) * W,
  H - (v / maxY) * (H - 40) - 20,
]);
const linePath = pts.map((p, k) => `${k ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
const areaPath = `${linePath} L${W} ${H} L0 ${H} Z`;

// Direction 11 — motion dots that resolve on load
const motionRng = mulberry32(9091);
const MOTION = Array.from({ length: 96 }, (_, i) => ({
  x: motionRng() * 100,
  y: motionRng() * 100,
  d: motionRng() * 1.4,
  i,
}));

// Direction 12 — departure board rows (illustrative)
const BOARD = [
  { m: "BTC 27JUN BASIS", v: "DERIBIT", e: "+3.71%", s: "CLEAR", t: "go" },
  { m: "ETH FUNDING CARRY", v: "BYBIT", e: "+1.94%", s: "CLEAR", t: "go" },
  { m: "US ELECTION · SEN", v: "POLYMKT", e: "-0.40%", s: "NO EDGE", t: "no" },
  { m: "NFL · SPREAD ARB", v: "PINNACLE", e: "+0.62%", s: "THIN", t: "thin" },
  { m: "SOL 26SEP BASIS", v: "OKX", e: "+2.15%", s: "CLEAR", t: "go" },
  { m: "OSCARS · BEST PIC", v: "MANIFOLD", e: "-1.20%", s: "NO EDGE", t: "no" },
  { m: "GOLD CASH & CARRY", v: "ASTER", e: "+0.09%", s: "THIN", t: "thin" },
  { m: "BNB FUNDING", v: "BINANCE", e: "+1.38%", s: "CLEAR", t: "go" },
];

// ── Gallery chrome ───────────────────────────────────────────────────────────
function Strip({ n, name, font }: { n: string; name: string; font: string }) {
  return (
    <div className={styles.strip}>
      <span className={styles.stripNum}>{n}</span>
      <span className={styles.stripDot}>·</span>
      <span className={styles.stripName}>{name}</span>
      <span className={styles.stripFont}>{font}</span>
    </div>
  );
}

export default function LandingGallery() {
  return (
    <main className={`${styles.root} ${allFontVars}`}>
      {/* Persistent preview banner — this is a throwaway design gallery */}
      <div className={styles.banner}>
        <strong>PREVIEW</strong>
        <span>throwaway hero gallery · 12 directions for the same product</span>
        <span className={styles.bannerWarn}>numbers are illustrative — not live data</span>
      </div>

      {/* 01 · THE LIVING FIELD ────────────────────────────────────────────── */}
      <Strip n="01" name="The living field" font="Instrument Serif" />
      <section className={`${styles.hero} ${styles.d01}`}>
        <div className={styles.d01Field} aria-hidden>
          {FIELD.map((p, i) => {
            const tier = glowMap.get(i);
            return (
              <span
                key={i}
                className={tier ? `${styles.d01Dot} ${styles.d01Glow} ${styles[`t_${tier}`]}` : styles.d01Dot}
                style={{ left: `${p.x}%`, top: `${p.y}%`, width: p.s, height: p.s, opacity: tier ? 1 : p.o }}
              />
            );
          })}
          <div className={styles.d01Sweep} />
        </div>
        <div className={styles.d01Copy}>
          <h1 className={styles.d01Head}>
            85,000 markets.<br />
            Almost all of them<br />
            <em>are worth nothing.</em>
          </h1>
          <div className={styles.d01Legend}>
            <span className={`${styles.d01Chip} ${styles.t_mint}`} />
            <span className={`${styles.d01Chip} ${styles.t_amber}`} />
            <span className={`${styles.d01Chip} ${styles.t_violet}`} />
            <span>9 cleared every fee today. Edgeradar shows only those.</span>
          </div>
        </div>
      </section>

      {/* 02 · RADICAL MINIMAL ─────────────────────────────────────────────── */}
      <Strip n="02" name="Radical minimal" font="Hanken Grotesk" />
      <section className={`${styles.hero} ${styles.d02}`}>
        <span className={styles.d02Mark}>Edgeradar</span>
        <div className={styles.d02Center}>
          <span className={styles.d02Kicker}>survived every fee today</span>
          <span className={styles.d02Num}>9</span>
          <span className={styles.d02Sub}>out of 84,912 markets scanned</span>
        </div>
        <span className={styles.d02Foot}>Some days the honest answer is zero. We show that too.</span>
      </section>

      {/* 03 · EDITORIAL ───────────────────────────────────────────────────── */}
      <Strip n="03" name="Editorial" font="Fraunces / Spectral" />
      <section className={`${styles.hero} ${styles.d03}`}>
        <div className={styles.d03Mast}>
          <span className={styles.d03Masthead}>Edgeradar</span>
          <span className={styles.d03Dateline}>The ledger that won't lie to you</span>
        </div>
        <div className={styles.d03Grid}>
          <div className={styles.d03Lead}>
            <h1 className={styles.d03Head}>The only number we refuse to inflate.</h1>
            <p className={styles.d03Dek}>
              Rivals print <span className={styles.d03Ink}>1,914% APR</span> and the word
              “risk-free.” We scan eighty-five thousand markets, subtract every fee to the
              cent, and publish what is actually left — even on the days when the honest
              figure is nothing at all.
            </p>
          </div>
          <div className={styles.d03Fig}>
            <span className={styles.d03FigLabel}>After fees, today</span>
            <span className={styles.d03FigNum}>+9.1%</span>
            <span className={styles.d03FigNote}>top edge, 1 of 9 that cleared</span>
            <div className={styles.d03Table}>
              <div><span>Scanned</span><span>84,912</span></div>
              <div><span>Cleared fees</span><span>9</span></div>
              <div><span>Median edge</span><span>+2.3%</span></div>
              <div><span>Days at zero</span><span>common</span></div>
            </div>
          </div>
        </div>
      </section>

      {/* 04 · TERMINAL ────────────────────────────────────────────────────── */}
      <Strip n="04" name="Terminal" font="JetBrains Mono" />
      <section className={`${styles.hero} ${styles.d04}`}>
        <div className={styles.d04Panel}>
          <div className={styles.d04Bar}>
            <span className={styles.d04Dotr} /><span className={styles.d04Doty} /><span className={styles.d04Dotg} />
            <span className={styles.d04Title}>edgeradar — scan</span>
          </div>
          <pre className={styles.d04Body}>
{`> sweep markets ............ 84,912 ok
> subtract fees ........... done
> filter survivors ........ `}<span className={styles.d04Hi}>9 clear</span>{`
> median edge ............. +2.3%
> verdict ................. `}<span className={styles.d04Go}>take the 9</span>{`

  we do not round up. we do not
  invent yield. when nothing
  survives, this reads 0.`}
          </pre>
        </div>
      </section>

      {/* 05 · SWISS GRID ──────────────────────────────────────────────────── */}
      <Strip n="05" name="Swiss grid" font="Archivo" />
      <section className={`${styles.hero} ${styles.d05}`}>
        <div className={styles.d05Grid}>
          <div className={styles.d05Mark}>Edgeradar</div>
          <div className={styles.d05Meta}>Arbitrage, after fees<br />Prediction markets · Crypto · Sportsbooks</div>
          <div className={styles.d05Big}>
            <span className={styles.d05Small}>survived / scanned</span>
            <span className={styles.d05Ratio}><b className={styles.d05Red}>9</b>/84,912</span>
          </div>
          <div className={styles.d05Rule} />
          <div className={styles.d05Statement}>
            We surface only the handful that clear every fee.<span className={styles.d05Red}> Often that handful is empty.</span>
          </div>
        </div>
      </section>

      {/* 06 · GLASS DEPTH ─────────────────────────────────────────────────── */}
      <Strip n="06" name="Glass depth" font="Sora / Manrope" />
      <section className={`${styles.hero} ${styles.d06}`}>
        <div className={styles.d06Aura} aria-hidden />
        <div className={styles.d06Aura2} aria-hidden />
        <div className={styles.d06Stack}>
          <h1 className={styles.d06Head}>The truth, after every fee.</h1>
          <div className={styles.d06Panels}>
            <div className={`${styles.d06Card} ${styles.d06CardA}`}><span className={styles.d06CardNum}>85k</span><span>markets scanned live</span></div>
            <div className={`${styles.d06Card} ${styles.d06CardB}`}><span className={styles.d06CardNum}>9</span><span>survived the fees</span></div>
            <div className={`${styles.d06Card} ${styles.d06CardC}`}><span className={styles.d06CardNum}>0</span><span>on an honest day</span></div>
          </div>
          <p className={styles.d06Sub}>No inflated APR. No “risk-free.” Just what's left.</p>
        </div>
      </section>

      {/* 07 · DATA IS THE HERO ────────────────────────────────────────────── */}
      <Strip n="07" name="Data is the hero" font="Newsreader / IBM Plex Mono" />
      <section className={`${styles.hero} ${styles.d07}`}>
        <svg className={styles.d07Chart} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
          <defs>
            <linearGradient id="d07grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#37E0B0" stopOpacity="0.42" />
              <stop offset="100%" stopColor="#37E0B0" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill="url(#d07grad)" />
          <path d={linePath} fill="none" stroke="#5AF0C4" strokeWidth="2.4" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className={styles.d07Cap}>
          <span className={styles.d07Num}>84,912</span>
          <span className={styles.d07Txt}>markets scanned today. The line is everything that was left once the fees came out — nine points cleared, the rest fell to the floor.</span>
        </div>
      </section>

      {/* 08 · BRUTALIST ───────────────────────────────────────────────────── */}
      <Strip n="08" name="Brutalist" font="Anton / JetBrains Mono" />
      <section className={`${styles.hero} ${styles.d08}`}>
        <div className={styles.d08Head}>
          <span className={styles.d08Line}>WE SHOW</span>
          <span className={`${styles.d08Line} ${styles.d08Mark2}`}>ZERO</span>
          <span className={styles.d08Line}>WHEN IT'S ZERO.</span>
        </div>
        <div className={styles.d08Row}>
          <span className={styles.d08Cell}>85,000 SCANNED</span>
          <span className={styles.d08Cell}>EVERY FEE SUBTRACTED</span>
          <span className={styles.d08Cell}>9 SURVIVE / 0 SOME DAYS</span>
        </div>
      </section>

      {/* 09 · WARM AND HUMAN ──────────────────────────────────────────────── */}
      <Strip n="09" name="Warm and human" font="Baloo 2 / Nunito Sans" />
      <section className={`${styles.hero} ${styles.d09}`}>
        <div className={styles.d09Art} aria-hidden>
          <div className={styles.d09Lens}>
            <span className={styles.d09Spark} />
            <span className={styles.d09Spark} />
            <span className={styles.d09Spark} />
          </div>
        </div>
        <div className={styles.d09Copy}>
          <h1 className={styles.d09Head}>Find the rare sure thing.<br />Or hear an honest “not today.”</h1>
          <p className={styles.d09Sub}>
            We watch 85,000 markets so you don't have to, take out every fee, and only
            wave you over when something truly clears. No jargon. No pressure. No made-up returns.
          </p>
          <span className={styles.d09Cta}>See what cleared today</span>
        </div>
      </section>

      {/* 10 · SPLIT SCREEN ────────────────────────────────────────────────── */}
      <Strip n="10" name="Split screen" font="Bebas Neue / Libre Baskerville" />
      <section className={`${styles.hero} ${styles.d10}`}>
        <div className={styles.d10Lie}>
          <span className={styles.d10LieTag}>what they advertise</span>
          <span className={styles.d10LieNum}>1,914%</span>
          <span className={styles.d10LieApr}>APR</span>
          <span className={styles.d10LieRisk}>✦ RISK-FREE ✦</span>
        </div>
        <div className={styles.d10Truth}>
          <span className={styles.d10TruthTag}>what actually cleared</span>
          <span className={styles.d10TruthNum}>+9.1%</span>
          <span className={styles.d10TruthNote}>after every fee, on the nine markets that survived out of 84,912.</span>
          <span className={styles.d10TruthMark}>Edgeradar</span>
        </div>
      </section>

      {/* 11 · MOTION FIRST ────────────────────────────────────────────────── */}
      <Strip n="11" name="Motion first" font="Syne / Spline Sans Mono" />
      <section className={`${styles.hero} ${styles.d11}`}>
        <div className={styles.d11Field} aria-hidden>
          {MOTION.map((p) => (
            <span
              key={p.i}
              className={styles.d11Dot}
              style={{ left: `${p.x}%`, top: `${p.y}%`, ["--d" as string]: `${p.d}s` }}
            />
          ))}
          <div className={styles.d11Scan} />
        </div>
        <div className={styles.d11Answer}>
          <span className={styles.d11Tag}>scan resolved</span>
          <span className={styles.d11Num}>9 survived</span>
          <span className={styles.d11Sub}>84,912 scanned · every fee subtracted</span>
        </div>
      </section>

      {/* 12 · DEPARTURE BOARD ─────────────────────────────────────────────── */}
      <Strip n="12" name="Departure board" font="Martian Mono" />
      <section className={`${styles.hero} ${styles.d12}`}>
        <div className={styles.d12Head}>
          <span>DEPARTURES</span>
          <span className={styles.d12HeadSub}>EDGES AFTER FEES · {`{`}illustrative{`}`}</span>
        </div>
        <div className={styles.d12Cols}>
          <span>MARKET</span><span>VENUE</span><span>EDGE</span><span>STATUS</span>
        </div>
        <div className={styles.d12Board}>
          {BOARD.map((r, i) => (
            <div key={i} className={styles.d12Row} style={{ ["--r" as string]: `${i * 0.12}s` }}>
              <span className={styles.d12M}>{r.m}</span>
              <span className={styles.d12V}>{r.v}</span>
              <span className={styles.d12E}>{r.e}</span>
              <span className={`${styles.d12S} ${styles[`s_${r.t}`]}`}>{r.s}</span>
            </div>
          ))}
        </div>
      </section>

      <div className={styles.end}>end of preview · pick a direction · this route is disposable</div>
    </main>
  );
}
