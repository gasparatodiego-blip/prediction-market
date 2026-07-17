"use client";

import React, { useState, useEffect, useRef } from "react";

const P = {
  ground: "#FFF9F0", surface: "#FFFFFF", ink: "#2D2418", muted: "#8A7A62",
  faint: "#B5A88F", mint: "#0FA968", amber: "#E0952E", violet: "#7B6FE8",
};

const CATS = ["Prediction market", "Funding arbitrage", "Cash & carry", "Liquidity rewards", "Top traders", "Sports"];

const EDGES = [
  { c: P.mint, k: "LOCKED", cat: "Prediction market", g: "prediction markets", n: "Fed cuts in March", v: "+2.8¢", u: "a contract" },
  { c: P.mint, k: "LOCKED", cat: "Funding arbitrage", g: "funding arbitrage", n: "TRX funding spread", v: "+$0.99", u: "a day, per $1,000" },
  { c: P.mint, k: "LOCKED", cat: "Cash & carry", g: "cash & carry", n: "BTC carry", v: "+3.9%", u: "a year, locked at entry" },
  { c: P.violet, k: "LIKELY", cat: "Liquidity rewards", g: "liquidity rewards", n: "Polymarket maker rewards", v: "+$5.31", u: "a day, per $1,000" },
  { c: P.violet, k: "LIKELY", cat: "Top traders", g: "top traders", n: "0xc4f2 · 68% hit rate", v: "+$8.10", u: "a day, settled on-chain" },
  { c: P.amber, k: "REAL", cat: "Sports", g: "sports", n: "Lakers / Celtics", v: "+3.4%", u: "against the sharp price" },
  { c: P.mint, k: "LOCKED", cat: "Prediction market", g: "prediction markets", n: "Powell out by June", v: "+1.9¢", u: "a contract" },
  { c: P.mint, k: "LOCKED", cat: "Funding arbitrage", g: "funding arbitrage", n: "ETH funding spread", v: "+$1.24", u: "a day, per $1,000" },
  { c: P.mint, k: "LOCKED", cat: "Cash & carry", g: "cash & carry", n: "ETH carry, Jun-26", v: "+4.4%", u: "a year, locked at entry" },
  { c: P.violet, k: "LIKELY", cat: "Liquidity rewards", g: "liquidity rewards", n: "Kalshi maker rewards", v: "+$2.40", u: "a day, per $1,000" },
  { c: P.violet, k: "LIKELY", cat: "Top traders", g: "top traders", n: "0x9ab1 · 64% hit rate", v: "+$3.55", u: "a day, settled on-chain" },
  { c: P.violet, k: "LIKELY", cat: "Sports", g: "sports", n: "St. Louis / Sporting", v: "+7.4%", u: "against the sharp price" },
];

const WAYS = [
  {
    id: "pred", t: "Prediction arbitrage", c: P.mint,
    p: "The same question is listed on two exchanges, and they disagree. A $100 YES contract costs $60 on one, and the $100 NO costs $35 on the other.",
    p2: "One of the two has to win. So the pair pays out $100 no matter how it lands — and you paid $95 for it. The $5 is yours the moment both orders fill.",
    p3: "We only count a price you could actually hit: the live bid and ask, sized to the depth that is really on the book. If the second leg cannot fill, it is not an edge, and we will not show it as one.",
  },
  {
    id: "fund", t: "Funding spread", c: P.mint,
    p: "A perpetual is a bet on a price that never expires. To keep it glued to the real price, the exchange makes one side pay the other every eight hours. That payment is called funding.",
    p2: "Today Binance pays people who are long. OKX charges people who are short. Be long on Binance and short on OKX, same size: you own nothing, the price can do what it likes, and the two payments still land.",
    p3: "We use funding that has actually settled over the last periods, never the predicted rate. A rate that pays today can flip tomorrow, so we show it as dollars a day and never as a yearly promise.",
  },
  {
    id: "carry", t: "Cash & carry", c: P.mint,
    p: "Bitcoin has a price today, and a separate price for June. The June one is usually higher — people pay a little extra to get it later.",
    p2: "Buy the coin today at $100 and sell the June contract at $104. On expiry day the two prices are the same by definition, so the $4 is yours. Nothing to predict: it is arithmetic and a calendar.",
    p3: "The $4 is locked the moment both legs fill, but it arrives slowly, over the days left to expiry. We show it as dollars a day, not as a headline percentage.",
  },
  {
    id: "maker", t: "Maker rewards", c: P.violet,
    p: "Polymarket is a prediction market, and an empty order book is useless to it. So it runs a rewards program: leave real buy and sell orders on the book, and it pays you a slice of a daily pot for being there.",
    p2: "You post a bid at $60 and an ask at $62. You are not predicting anything — you are the shop, quoting both sides. The pot is $18,000 a day, and your slice depends on how tight and how large your quotes are.",
    p3: "We count only rewards that actually accrued, from real resting orders. A book with no genuine competition on it is ignored: it would make the number look far better than it is.",
  },
  {
    id: "trader", t: "Top traders", c: P.violet,
    p: "Every Polymarket trade is public. So is the wallet behind it, and so is what that wallet has actually made once its bets settled.",
    p2: "We rank five thousand of them on settled profit. Follow one and mirror its fills, or just watch what it does and make up your own mind.",
    p3: "The ranking uses realized profit only. An open position is hope, not performance, and it stays out of the headline number.",
  },
  {
    id: "sport", t: "Sports", c: P.amber,
    p: "Forty-four bookmakers price the same match, and they do not all price it well. One of them, Pinnacle, is the one the rest of them follow.",
    p2: "When Book 31 drifts out to 2.18 on a bet the sharp price says is worth 2.11, the same wager pays you more for exactly the same risk. That difference is the edge.",
    p3: "We compare against the live sharp price and count only odds you can actually get on. An offer that vanishes the moment you click is not an edge.",
  },
];

const VIEW = 5;

function useHover() {
  const [h, setH] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(hover: hover) and (pointer: fine)");
    const f = (e: any) => setH(e.matches);
    setH(q.matches);
    q.addEventListener("change", f);
    return () => q.removeEventListener("change", f);
  }, []);
  return h;
}

function useNarrow() {
  const [n, setN] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(max-width: 859px)");
    const f = (e: any) => setN(e.matches);
    setN(q.matches);
    q.addEventListener("change", f);
    return () => q.removeEventListener("change", f);
  }, []);
  return n;
}

export default function LandingD() {
  const nar = useNarrow();
  const hov = useHover();
  const ROW = nar ? 62 : 68;

  const list = EDGES;

  const [i, setI] = useState(0);
  const [hold, setHold] = useState(false);
  const [pause, setPause] = useState(false);
  const pauseRef = useRef<any>(null);

  useEffect(() => {
    if (hold || pause) return;
    const t = setInterval(() => setI((p) => (p + 1) % list.length), 2200);
    return () => clearInterval(t);
  }, [hold, pause, list.length]);

  useEffect(() => () => clearTimeout(pauseRef.current), []);

  // clic su una tab: salta a quella categoria, resta fermo 3s, poi riprende il giro
  const jump = (cat: any) => {
    const idx = EDGES.findIndex((e) => e.cat === cat);
    if (idx < 0) return;
    setI(idx);
    setPause(true);
    clearTimeout(pauseRef.current);
    pauseRef.current = setTimeout(() => setPause(false), 2000);
  };

  const cur = list[Math.min(i, list.length - 1)];
  const word = cur ? cur.g : "everything";
  const activeCat = cur ? cur.cat : null;

  const heroRef = useRef<any>(null);
  const [stuck, setStuck] = useState(false);
  const [atSix, setAtSix] = useState(false);
  const sixRef = useRef<any>(null);
  const [wi, setWi] = useState(0);
  const way = WAYS[wi];
  const nextWay = WAYS[(wi + 1) % WAYS.length];
  const wayRef = useRef<any>(null);
  const tabsRef = useRef<any>(null);
  const goWay = (n: any) => {
    setWi((n + WAYS.length) % WAYS.length);
    requestAnimationFrame(() => sixRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  useEffect(() => {
    const c = tabsRef.current;
    const el = c?.children?.[wi];
    if (!c || !el) return;
    c.scrollTo({ left: el.offsetLeft - (c.clientWidth - el.clientWidth) / 2, behavior: "smooth" });
  }, [wi]);
  useEffect(() => {
    const el = heroRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([en]) => setStuck(!en.isIntersecting), { threshold: 0 });
    io.observe(el);
    const onScroll = () => {
      const r = sixRef.current?.getBoundingClientRect();
      setAtSix(!!r && r.top <= 140);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { io.disconnect(); window.removeEventListener("scroll", onScroll); };
  }, []);

  return (
    <div className="edg" style={{ background: P.ground, minHeight: "100vh", color: P.ink }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Gabarito:wght@500;600;700&family=Plus+Jakarta+Sans:wght@400;500&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { overflow-x: clip; }
        .s { font-family: 'Plus Jakarta Sans', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
        .edg h1, .edg h2, .edg h3, .edg h4, .edg p, .edg li, .edg span, .edg button { color: inherit; }
        .d { font-family: 'Gabarito', system-ui, sans-serif; letter-spacing: -.02em; }
        .m { font-family: 'DM Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; }
        @keyframes sweep { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
        @keyframes swap { from { opacity: 0; transform: translateY(.3em) } to { opacity: 1; transform: none } }
        .swap { display: inline-block; animation: swap .42s cubic-bezier(.2,.8,.2,1); }

        @keyframes il-cur {
          0%   { transform: translate(100px, 160px); opacity: 0 }
          6%   { opacity: 1 }
          22%, 34% { transform: translate(40px, 66px) }
          50%, 62% { transform: translate(136px, 66px) }
          80%, 94% { transform: translate(92px, 138px); opacity: 1 }
          100% { transform: translate(92px, 138px); opacity: 0 }
        }
        /* una cosa alla volta: ogni evento entra quando il precedente si è fermato */
        @keyframes a-cards { 0%, 18% { opacity: 0; transform: translateY(5px) } 22%, 100% { opacity: 1; transform: none } }
        @keyframes a-c1 { 0%, 1% { opacity: 0; transform: scale(.85) } 4%, 14% { opacity: 1; transform: none } 17%, 100% { opacity: 0; transform: none } }
        @keyframes a-c2 { 0%, 23% { opacity: 0; transform: scale(.85) } 26%, 36% { opacity: 1; transform: none } 39%, 100% { opacity: 0; transform: none } }
        @keyframes a-c3 { 0%, 40% { opacity: 0; transform: scale(.85) } 43%, 53% { opacity: 1; transform: none } 56%, 100% { opacity: 0; transform: none } }
        @keyframes a-c4 { 0%, 57% { opacity: 0; transform: scale(.85) } 60%, 70% { opacity: 1; transform: none } 73%, 100% { opacity: 0; transform: none } }
        @keyframes a-c5 { 0%, 74% { opacity: 0; transform: scale(.85) } 77%, 97% { opacity: 1; transform: none } 100% { opacity: 0; transform: none } }
        @keyframes a-cur {
          0%, 26% { transform: translate(100px, 130px); opacity: 0 }
          28% { opacity: 1 }
          31%, 35% { transform: translate(46px, 91px); opacity: 1 }
          45%, 49% { transform: translate(142px, 91px); opacity: 1 }
          56% { transform: translate(193px, 108px); opacity: 1 }
          60%, 100% { transform: translate(193px, 108px); opacity: 0 }
        }
        @keyframes a-press { 0%, 32% { transform: scale(1) } 34% { transform: scale(.78) } 37%, 46% { transform: scale(1) } 48% { transform: scale(.78) } 51%, 100% { transform: scale(1) } }
        @keyframes a-ra { 0%, 32% { opacity: 0; transform: scale(.3) } 34% { opacity: .5 } 41%, 100% { opacity: 0; transform: scale(1.9) } }
        @keyframes a-rb { 0%, 46% { opacity: 0; transform: scale(.3) } 48% { opacity: .5 } 55%, 100% { opacity: 0; transform: scale(1.9) } }
        @keyframes a-fa { 0%, 34% { opacity: 0 } 37%, 97% { opacity: 1 } 100% { opacity: 0 } }
        @keyframes a-fb { 0%, 48% { opacity: 0 } 51%, 97% { opacity: 1 } 100% { opacity: 0 } }
        @keyframes a-p1 { 0%, 38% { opacity: 0; transform: translateY(4px) } 41%, 97% { opacity: 1; transform: none } 100% { opacity: 0 } }
        @keyframes a-p2 { 0%, 52% { opacity: 0; transform: translateY(4px) } 55%, 97% { opacity: 1; transform: none } 100% { opacity: 0 } }
        @keyframes a-sum { 0%, 60% { opacity: 0; transform: translateY(4px) } 63%, 97% { opacity: 1; transform: none } 100% { opacity: 0 } }
        @keyframes a-pay { 0%, 66% { opacity: 0; transform: translateY(4px) } 69%, 97% { opacity: 1; transform: none } 100% { opacity: 0 } }
        @keyframes a-bar { 0%, 69% { transform: scaleX(0) } 94%, 100% { transform: scaleX(1) } }
        @keyframes a-fin { 0%, 78% { opacity: 0; transform: scale(.92) } 81%, 97% { opacity: 1; transform: none } 100% { opacity: 0 } }
        @keyframes a-note {
          0%, 85% { opacity: 0; transform: scale(.3) }
          88% { opacity: 1 }
          92%, 99% { opacity: 1; transform: scale(1) }
          100% { opacity: 0; transform: scale(1) }
        }

        @keyframes m-fin { 0%, 62% { opacity: 0; transform: scale(.94) } 66%, 97% { opacity: 1; transform: none } 100% { opacity: 0 } }
        @keyframes b-cur {
          0%, 26% { transform: translate(100px, 196px); opacity: 0 }
          28% { opacity: 1 }
          31%, 35% { transform: translate(96px, 138px); opacity: 1 }
          45%, 49% { transform: translate(96px, 106px); opacity: 1 }
          56% { transform: translate(193px, 62px); opacity: 1 }
          60%, 100% { transform: translate(193px, 62px); opacity: 0 }
        }

        @keyframes c-gap { 0%, 56% { opacity: 0 } 60%, 100% { opacity: 1 } }
        @keyframes c-dot { 0%, 61% { transform: translate(20px, 146px); opacity: 0 } 63% { opacity: 1 } 80%, 100% { transform: translate(182px, 168px); opacity: 1 } }
        @keyframes c-d1 { 0%, 61% { opacity: 0 } 63%, 66% { opacity: 1 } 68%, 100% { opacity: 0 } }
        @keyframes c-d2 { 0%, 67% { opacity: 0 } 69%, 71% { opacity: 1 } 73%, 100% { opacity: 0 } }
        @keyframes c-d3 { 0%, 72% { opacity: 0 } 74%, 76% { opacity: 1 } 78%, 100% { opacity: 0 } }
        @keyframes c-d4 { 0%, 77% { opacity: 0 } 80%, 100% { opacity: 1 } }

        @keyframes t-cur {
          0%, 20% { transform: translate(100px, 176px); opacity: 0 }
          23% { opacity: 1 }
          28%, 38% { transform: translate(60px, 74px); opacity: 1 }
          46%, 100% { transform: translate(60px, 90px); opacity: 1 }
        }
        @keyframes t-row1 { 0%, 26% { opacity: 0 } 29%, 40% { opacity: 1 } 44%, 100% { opacity: 0 } }
        @keyframes t-row2 { 0%, 45% { opacity: 0 } 49%, 100% { opacity: 1 } }
        @keyframes t-draw { 0%, 56% { stroke-dashoffset: 150 } 76%, 100% { stroke-dashoffset: 0 } }
        @keyframes t-win { 0%, 58% { transform: scaleX(0) } 78%, 100% { transform: scaleX(1) } }

        @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important } }

        /* ---------- layout: phone first, then tablet, then desktop ---------- */
        .wrap { max-width: 940px; margin: 0 auto; padding: 0 clamp(16px, 4.5vw, 32px); }
        .clip { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .val { white-space: nowrap; flex-shrink: 0; }
        .foot { flex-wrap: wrap; gap: 8px 16px; }
        .row { padding-left: clamp(14px, 3.6vw, 22px); padding-right: clamp(14px, 3.6vw, 22px); }

        .nav { display: flex; justify-content: space-between; align-items: center; gap: 10px;
               padding: 14px 0; flex-wrap: nowrap; }
        .ctaS { display: inline }
        .ctaL { display: none }
        .livec { display: none }

        .hero { padding: 14px 0 0; display: grid; grid-template-columns: 1fr; gap: 18px;
                align-items: center; }
        .hero-list { order: 2; }
        .hero-copy { order: 1; }

        .tabs { display: flex; flex-wrap: wrap; gap: 5px; padding: 0 0 9px; }
        .tab { border-radius: 999px; cursor: pointer; white-space: nowrap;
               font-size: clamp(11.5px, 3.1vw, 13px); padding: 7px clamp(10px, 2.8vw, 16px);
               transition: background .35s cubic-bezier(.2,.8,.2,1), color .35s; }

        .six { padding: 16px 0 12px; scroll-margin-top: 12px; }

        @media (max-width: 699px) {
          html { scroll-snap-type: y proximity; scroll-padding-top: 56px; }
          .hero { min-height: calc(100vh - 66px); min-height: calc(100dvh - 66px); align-content: start; }
          .hero, .six, .cta { scroll-snap-align: start; }
        }
        .waysub { display: none; }
        .waybody1 { display: none; }
        .waybody2 { display: none; }
        .waynote { display: none; }
        .illu { max-height: 300px; }
        .waytabs { display: flex; flex-wrap: nowrap; justify-content: flex-start; gap: 6px; margin: 12px 0;
                   overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch;
                   padding-bottom: 2px; scroll-snap-type: x proximity; }
        .waytabs::-webkit-scrollbar { display: none; }
        .waytabs .tab { flex: 0 0 auto; scroll-snap-align: center; }
        .waynext { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
        .way-in { animation: swap .32s ease both; }
        .way { display: grid; grid-template-columns: 1fr; gap: 14px; align-items: start;
               background: ${P.surface}; border-radius: 22px; padding: clamp(14px, 3.4vw, 26px);
               box-shadow: 0 8px 26px -14px rgba(45,36,24,0.2); }

        @media (min-width: 440px) { .ctaS { display: none } .ctaL { display: inline } }
        @media (min-width: 520px) { .livec { display: inline } }

        /* tablet and up: long copy returns, tabs wrap, no forced full screens */
        @media (min-width: 700px) {
          .nav { padding: 20px 0; }
          .hero { padding: 28px 0 0; gap: 24px; align-content: center; }
          .six { padding: clamp(52px, 9vw, 80px) 0 0; }
          .way { grid-template-columns: 1fr 330px; gap: 26px; min-height: 320px; }
          .waynote, .waysub, .waybody1, .waybody2 { display: block; }
          .waynext { display: none; }
          .illu { max-height: none; }
          .waytabs { flex-wrap: wrap; justify-content: center; overflow-x: visible; margin: 26px 0 16px; }
        }

        /* desktop */
        @media (min-width: 860px) {
          .nav { padding: 24px 0; }
          .hero { gap: 34px; padding: 44px 0 0; }
        }
      `}</style>

      <div className="s" style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 40, pointerEvents: "none",
        transform: stuck ? "none" : "translateY(-110%)", opacity: stuck ? 1 : 0,
        transition: "transform .35s cubic-bezier(.2,.8,.2,1), opacity .25s",
        background: P.ground + "F2", backdropFilter: "blur(10px)",
        borderBottom: `1px solid ${P.ink}0F` }}>
        <div className="wrap" style={{ display: "flex", alignItems: "center",
          justifyContent: atSix ? "flex-end" : "space-between", gap: 12, height: 56 }}>
          {!atSix && (
            <div className="d clip" style={{ fontSize: "clamp(11.5px, 3.3vw, 17px)", fontWeight: 700, flex: 1, minWidth: 0 }}>
              Live edges in <span key={word} className="swap" style={{ color: P.mint }}>{word}</span>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexShrink: 0 }}>
            {!atSix && <span className="m livec" style={{ fontSize: 10.5, color: P.faint, whiteSpace: "nowrap", flexShrink: 0 }}>{list.length} live</span>}
            <span style={{ background: P.mint, color: "#fff", padding: "8px 16px", borderRadius: 999,
              fontWeight: 600, fontSize: 12.5, cursor: "pointer", whiteSpace: "nowrap",
              flexShrink: 0, pointerEvents: "auto" }}>Free trial</span>
          </div>
        </div>
      </div>

      <div className="s wrap">

        <nav className="nav">
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <Mark />
            <span className="d" style={{ fontSize: "clamp(19px, 5vw, 28px)", fontWeight: 700, letterSpacing: "-.03em", whiteSpace: "nowrap" }}>Edgeradar</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ color: P.muted, fontSize: 13.5, cursor: "pointer", padding: "9px 2px", whiteSpace: "nowrap", flexShrink: 0 }}>Sign in</span>
            <span style={{ background: P.mint, color: "#fff", padding: "10px 15px", borderRadius: 999,
              fontWeight: 600, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>
              <span className="ctaL">Free 7-day trial</span><span className="ctaS">Free trial</span>
            </span>
          </div>
        </nav>

        <section className="hero">

          <div className="hero-list" style={{ minWidth: 0 }}>
            <div className="tabs">
              {CATS.map((c) => {
                const on = c === activeCat;
                return (
                  <span key={c} className="tab" onClick={() => jump(c)}
                    style={{ background: on ? P.mint : P.surface, color: on ? "#fff" : P.muted,
                      fontWeight: on ? 600 : 500,
                      boxShadow: on ? "none" : "0 2px 10px -5px rgba(45,36,24,0.2)" }}>{c}</span>
                );
              })}
            </div>
            <List edges={list} row={ROW} view={nar ? 4 : VIEW} nar={nar} hov={hov} i={i} setI={setI} setHold={setHold}
              onPick={(n: any) => {
                setI(n);
                setPause(true);
                clearTimeout(pauseRef.current);
                pauseRef.current = setTimeout(() => setPause(false), 2000);
              }} />
          </div>

          <div className="hero-copy" style={{ minWidth: 0 }}>
            <h1 ref={heroRef} className="d" style={{ fontSize: "clamp(29px, 7.6vw, 50px)", fontWeight: 700, lineHeight: 1.08 }}>
              Live edges in<br />
              <span key={word} className="swap" style={{ color: P.mint }}>{word}.</span>
            </h1>
            <p style={{ fontSize: "clamp(13.5px, 3.7vw, 17px)", color: P.muted, marginTop: 9, lineHeight: 1.5, maxWidth: 620 }}>
              One list:
              <span style={{ color: P.ink, fontWeight: 600 }}> what to buy, where, and what it pays a day.</span>{" "}
              Updated while you watch.
            </p>
          </div>
        </section>

        <section ref={sixRef} className="six">
          <h2 className="d" style={{ fontSize: "clamp(22px, 5.6vw, 30px)", fontWeight: 700, textAlign: "center" }}>Six places we look.</h2>
          <p className="waysub" style={{ fontSize: "clamp(14px, 3.6vw, 15px)", color: P.muted, textAlign: "center", marginTop: 10,
            lineHeight: 1.55, maxWidth: 440, marginLeft: "auto", marginRight: "auto" }}>
            Six different ways a price can be wrong. One at a time, in plain words.
          </p>

          <div className="waytabs" ref={tabsRef}>
            {WAYS.map((w, k) => {
              const on = k === wi;
              return (
                <button key={w.id} className="tab" onClick={() => setWi(k)}
                  style={{ border: `1px solid ${on ? w.c : P.ink + "18"}`, background: on ? w.c : "transparent",
                    color: on ? "#fff" : P.muted, fontWeight: on ? 600 : 500, cursor: "pointer" }}>
                  {w.t}
                </button>
              );
            })}
          </div>

          <div ref={wayRef} className="way way-in" key={way.id}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span style={{ width: 7, height: 7, borderRadius: 4, background: way.c, flexShrink: 0 }} />
                <div className="d" style={{ fontSize: "clamp(19px, 4.6vw, 21px)", fontWeight: 700 }}>{way.t}</div>
              </div>
              <p className="waybody1" style={{ fontSize: "clamp(13.5px, 3.5vw, 14.5px)", color: P.muted, lineHeight: 1.65, marginTop: 10 }}>{way.p}</p>
              {way.p2 && <p className="waybody2" style={{ fontSize: "clamp(13.5px, 3.5vw, 14.5px)", color: P.muted, lineHeight: 1.65, marginTop: 12 }}>{way.p2}</p>}
              {way.p3 && <p className="waynote" style={{ fontSize: "clamp(12.5px, 3.3vw, 13.5px)", color: P.faint, lineHeight: 1.6, marginTop: 12,
                borderLeft: `2px solid ${way.c}44`, paddingLeft: 11 }}>{way.p3}</p>}
            </div>
            <Il id={way.id} c={way.c} />
          </div>

          <div className="waynext">
            <button className="tab" onClick={() => goWay(wi - 1)}
              style={{ border: `1px solid ${P.ink}18`, background: "transparent", color: P.muted, cursor: "pointer",
                flexShrink: 0, padding: "10px 14px" }}>←</button>
            <button className="tab" onClick={() => goWay(wi + 1)}
              style={{ border: `1px solid ${nextWay.c}`, background: nextWay.c, color: "#fff", cursor: "pointer",
                fontWeight: 600, flex: 1, minWidth: 0, textAlign: "center" }}>
              Next · {nextWay.t} →
            </button>
          </div>
        </section>

        <section className="cta" style={{ padding: "clamp(56px, 10vw, 88px) 0 72px", textAlign: "center" }}>
          <span style={{ background: P.mint, color: "#fff", padding: "17px 40px", borderRadius: 999,
            fontWeight: 600, fontSize: "clamp(15px, 4vw, 17px)", cursor: "pointer", display: "inline-block" }}>
            Start your free trial
          </span>
          <div style={{ fontSize: 13, color: P.faint, marginTop: 14 }}>Seven days. Cancel whenever.</div>
        </section>

        <footer className="foot" style={{ borderTop: `1px solid ${P.ink}10`, padding: "22px 0 46px", display: "flex",
          justifyContent: "space-between", fontSize: 13, color: P.muted }}>
          <span>We never touch your funds.</span>
          <span className="m" style={{ fontSize: 12, color: P.faint }}>EU · UK · US</span>
        </footer>
      </div>
    </div>
  );
}

/* ---------- illustrazioni: stesso racconto per tutte e sei ---------- */

const MONO = "'DM Mono', ui-monospace, monospace";
const DISP = "'Gabarito', system-ui, sans-serif";
const L = "20s linear infinite";
const fb: React.CSSProperties = { transformBox: "fill-box", transformOrigin: "center" };

const B = {
  poly: { n: "Polymarket",  c: "#1652F0" },
  kal:  { n: "Kalshi",      c: "#00A88F" },
  bin:  { n: "Binance",     c: "#D9A21B" },
  okx:  { n: "OKX",         c: "#3C3C3C" },
  der:  { n: "Deribit",     c: "#0F7B8A" },
  pin:  { n: "Pinnacle",    c: "#3C3C3C" },
  bk:   { n: "Book 31",     c: "#E0952E" },
  wal:  { n: "0xc4f2…9b",   c: "#7B6FE8" },
};

const SCENES = {
  pred: {
    title: "“Will the Fed cut in March?”",
    chips: [
      ["Same question, two exchanges", "ink"],
      ["Buy YES on Polymarket · $60", B.poly.c],
      ["Buy NO on Kalshi · $35", B.kal.c],
      ["One of them has to win", "ink"],
      ["Now add it up", "c"],
    ],
    cards: [
      { b: B.poly, side: "YES", price: "$60", btn: "BUY", done: "FILLED" },
      { b: B.kal, side: "NO", price: "$35", btn: "BUY", done: "FILLED" },
    ],
    r1: ["Paid on Polymarket", "$60"],
    r2: ["Paid on Kalshi", "$35"],
    sum: ["Total you paid", "$95"],
    pay: ["One of them pays", "$100"],
    fin: ["$100 − $95", "+$5"],
    note: "That gap is the spread — your profit",
  },
  fund: {
    title: "Ethereum perpetual · $10k each side",
    chips: [
      ["One coin, two venues", "ink"],
      ["Long $10k on Binance", B.bin.c],
      ["Short $10k on OKX", B.okx.c],
      ["Long + short = you are flat", "ink"],
      ["The funding still lands", "c"],
    ],
    cards: [
      { b: B.bin, side: "LONG", price: "$10k", btn: "OPEN", done: "LIVE" },
      { b: B.okx, side: "SHORT", price: "$10k", btn: "OPEN", done: "LIVE" },
    ],
    r1: ["You are flat", "$0"],
    hideR2: true,
    bar: ["Next funding", "every 8h"],
    fin: ["Net funding, per day", "+$5"],
    note: "Funding is the spread — your profit",
  },
  sport: {
    title: "Lakers / Celtics · moneyline",
    chips: [
      ["Forty-four books, one game", "ink"],
      ["The sharp price · 2.11", "ink"],
      ["Book 31 has drifted · 2.18", B.bk.c],
      ["Same bet, better price", "ink"],
      ["Now add it up", "c"],
    ],
    cards: [
      { b: B.pin, side: "SHARP", price: "2.11", btn: "CHECK", done: "CHECKED" },
      { b: B.bk, side: "HOME", price: "2.18", btn: "BET", done: "PLACED" },
    ],
    r1: ["The sharp price says", "2.11"],
    r2: ["Book 31 pays", "2.18"],
    sum: ["Sharp price returns", "$100"],
    pay: ["Book 31 returns", "$103"],
    fin: ["$103 − $100", "+$3"],
    note: "That drift is the edge — your profit",
  },
};

const RED = "#D8483C";
const GRN = "#0FA968";

function Chips({ list, c }: any) {
  const col = (k: any) => (k === "ink" ? P.ink : k === "c" ? c : k);
  const anims = ["a-c1", "a-c2", "a-c3", "a-c4", "a-c5"];
  return (
    <g>
      {list.map(([txt, k]: any, n: any) => {
        const w = Math.min(178, txt.length * 5.15 + 22);
        return (
          <g key={n} style={{ ...fb, animation: `${anims[n]} ${L}` }}>
            <rect x={100 - w / 2} y="32" width={w} height="20" rx="10" fill={col(k) + "1E"} />
            <text x="100" y="46" textAnchor="middle"
              style={{ fontFamily: DISP, fontSize: 10.5, fontWeight: 700, fill: col(k) }}>{txt}</text>
          </g>
        );
      })}
    </g>
  );
}

const Pointer = ({ an = "a-cur" }: any) => (
  <g style={{ animation: `${an} ${L}` }}>
    <g style={{ ...fb, animation: `a-press ${L}` }}>
      <path d="M0 0 L0 15 L4.1 11.4 L6.8 17.2 L9.7 15.9 L6.9 10.3 L12 10 Z"
        transform="scale(.58)" fill={P.ink} stroke="#FFF" strokeWidth="1.3" strokeLinejoin="round" />
    </g>
  </g>
);

/* ---- Maker rewards: order book ---- */
const ASKS = [["65¢", "1,240", 1240], ["64¢", "890", 890], ["63¢", "640", 640], ["62¢", "310", 310]];
const BIDS = [["60¢", "420", 420], ["59¢", "780", 780], ["58¢", "1,050", 1050], ["57¢", "1,600", 1600]];
const MAXD = 1700;

function BookScene({ c }: any) {
  const row = ([p, sz, d]: any, y: any, col: any, mine: any, an: any) => (
    <g key={p + y}>
      <rect x={182 - (8 + (d / MAXD) * 120)} y={y - 7} width={8 + (d / MAXD) * 120} height="9" rx="2" fill={col + "1C"} />
      <text x="18" y={y} style={{ fontFamily: MONO, fontSize: 8.5, fill: col }}>{p}</text>
      <text x="182" y={y} textAnchor="end" style={{ fontFamily: MONO, fontSize: 8, fill: P.muted }}>{sz}</text>
      {mine && (
        <g style={{ animation: `${an} ${L}` }}>
          <rect x="13" y={y - 8} width="174" height="11" rx="3" fill={P.surface} />
          <rect x="13" y={y - 8} width="174" height="11" rx="3" fill={c + "1A"} stroke={c} strokeWidth="1.2" />
          <text x="18" y={y} style={{ fontFamily: MONO, fontSize: 8.5, fill: c }}>{p}</text>
          <text x="182" y={y} textAnchor="end" style={{ fontFamily: DISP, fontSize: 6.8, fontWeight: 700, fill: c }}>YOUR LIMIT · 500</text>
        </g>
      )}
    </g>
  );
  return (
    <g>
      <text x="100" y="19" textAnchor="middle" style={{ fontFamily: DISP, fontSize: 9.5, fontWeight: 600, fill: P.muted }}>
        Polymarket · the order book
      </text>
      <Chips c={c} list={[
        ["A book needs both sides", "ink"],
        ["Limit BUY 500 at 60¢", c],
        ["Limit SELL 500 at 62¢", c],
        ["They trade against you", "ink"],
        ["Take your share", "c"],
      ]} />

      <rect x="8" y="58" width="184" height="122" rx="11" fill={P.surface} stroke={P.ink + "14"} />
      <text x="18" y="70" style={{ fontFamily: DISP, fontSize: 7, fontWeight: 700, fill: P.faint, letterSpacing: ".1em" }}>PRICE</text>
      <text x="182" y="70" textAnchor="end" style={{ fontFamily: DISP, fontSize: 7, fontWeight: 700, fill: P.faint, letterSpacing: ".1em" }}>SIZE</text>

      {ASKS.map((a, i) => row(a, 82 + i * 10, RED, i === 3, "a-p2"))}

      <line x1="13" y1="118" x2="187" y2="118" stroke={P.ink + "12"} />
      <text x="18" y="128" style={{ fontFamily: DISP, fontSize: 7.5, fontWeight: 700, fill: P.muted, letterSpacing: ".08em" }}>SPREAD</text>
      <text x="182" y="128" textAnchor="end" style={{ fontFamily: MONO, fontSize: 9.5, fill: P.ink }}>2¢</text>
      <line x1="13" y1="134" x2="187" y2="134" stroke={P.ink + "12"} />

      {BIDS.map((b, i) => row(b, 144 + i * 10, GRN, i === 0, "a-p1"))}

      <g>
        <rect x="8" y="184" width="184" height="42" rx="11" fill={P.surface} stroke={P.ink + "14"} />
        <text x="18" y="196" style={{ fontFamily: DISP, fontSize: 7, fontWeight: 700, fill: P.faint, letterSpacing: ".04em" }}>
          POLYMARKET PAYS FOR LIQUIDITY
        </text>
        <text x="18" y="208" style={{ fontFamily: DISP, fontSize: 8.5, fontWeight: 500, fill: P.muted }}>Pot, per day</text>
        <text x="182" y="208" textAnchor="end" style={{ fontFamily: MONO, fontSize: 9.5, fill: P.ink, animation: `a-sum ${L}` }}>$18,000</text>
        <text x="18" y="221" style={{ fontFamily: DISP, fontSize: 9.5, fontWeight: 700, fill: P.ink }}>Your share, 0.03%</text>
        <text x="182" y="222" textAnchor="end" style={{ ...fb, fontFamily: MONO, fontSize: 15, fill: c, animation: `m-fin ${L}` }}>+$5</text>
      </g>

      <g style={{ ...fb, animation: `a-note ${L}` }}>
        <rect x="14" y="230" width="172" height="16" rx="8" fill={c} />
        <text x="100" y="241.5" textAnchor="middle" style={{ fontFamily: DISP, fontSize: 8.5, fontWeight: 700, fill: "#FFF" }}>
          They pay you to keep the shop open
        </text>
      </g>

      <circle cx="100" cy="144" r="11" fill="none" stroke={c} strokeWidth="2.5" style={{ ...fb, animation: `a-ra ${L}` }} />
      <circle cx="100" cy="112" r="11" fill="none" stroke={c} strokeWidth="2.5" style={{ ...fb, animation: `a-rb ${L}` }} />
      <Pointer an="b-cur" />
    </g>
  );
}

/* ---- Cash & carry: i trenta giorni ---- */
function CarryScene({ c }: any) {
  const card = (x: any, b: any, side: any, price: any, btn: any, done: any, fl: any, ring: any, step: any) => (
    <g>
      <rect x={x} y="58" width="88" height="46" rx="11" fill={P.surface} stroke={P.ink + "14"} />
      <circle cx={x + 11} cy="68" r="3.5" fill={b.c} />
      <text x={x + 18} y="71" style={{ fontFamily: DISP, fontSize: 8, fontWeight: 600, fill: P.muted }}>{b.n}</text>
      <circle cx={x + 78} cy="67.5" r="6.5" fill={P.ink + "0D"} />
      <text x={x + 78} y="70.5" textAnchor="middle" style={{ fontFamily: DISP, fontSize: 8, fontWeight: 700, fill: P.muted }}>{step}</text>
      <text x={x + 10} y="88" style={{ fontFamily: DISP, fontSize: 11.5, fontWeight: 700, fill: c }}>{side}</text>
      <text x={x + 78} y="88" textAnchor="end" style={{ fontFamily: MONO, fontSize: 10.5, fill: P.ink }}>{price}</text>
      <rect x={x + 10} y="92" width="68" height="10" rx="5" fill={P.ink + "0A"} />
      <text x={x + 44} y="99.5" textAnchor="middle" style={{ fontFamily: DISP, fontSize: 7, fontWeight: 700, fill: P.faint }}>{btn}</text>
      <g style={{ animation: `${fl} ${L}` }}>
        <rect x={x} y="58" width="88" height="46" rx="11" fill={c + "10"} stroke={c} strokeWidth="2" />
        <rect x={x + 10} y="92" width="68" height="10" rx="5" fill={c} />
        <text x={x + 44} y="99.5" textAnchor="middle" style={{ fontFamily: DISP, fontSize: 7, fontWeight: 700, fill: "#FFF" }}>{done}</text>
      </g>
      <circle cx={x + 44} cy="97" r="9" fill="none" stroke={c} strokeWidth="2.5" style={{ ...fb, animation: `${ring} ${L}` }} />
    </g>
  );
  const day = (t: any, an: any) => (
    <text x="162" y="145" textAnchor="middle"
      style={{ fontFamily: DISP, fontSize: 17, fontWeight: 700, fill: P.ink, animation: `${an} ${L}` }}>{t}</text>
  );
  return (
    <g>
      <text x="100" y="19" textAnchor="middle" style={{ fontFamily: DISP, fontSize: 9.5, fontWeight: 600, fill: P.muted }}>
        Bitcoin · today vs the June future
      </text>
      <Chips c={c} list={[
        ["One asset, two dates", "ink"],
        ["Buy the spot · $100", B.bin.c],
        ["Sell the June future · $104", B.der.c],
        ["Thirty days go by", "ink"],
        ["They meet. Keep the gap.", "c"],
      ]} />

      <g style={{ animation: `a-cards ${L}` }}>
        {card(8, B.bin, "SPOT", "$100", "BUY", "FILLED", "a-fa", "a-ra", "1")}
        {card(104, B.der, "JUNE", "$104", "SELL", "FILLED", "a-fb", "a-rb", "2")}
      </g>

      <g>
        <rect x="8" y="110" width="184" height="80" rx="11" fill={P.surface} stroke={P.ink + "14"} />
        <text x="18" y="126" style={{ fontFamily: DISP, fontSize: 8.5, fontWeight: 700, fill: P.faint, letterSpacing: ".08em" }}>DAYS TO EXPIRY</text>

        <rect x="140" y="116" width="44" height="36" rx="7" fill={P.surface} stroke={P.ink + "1A"} />
        <path d="M140 123 a7 7 0 0 1 7 -7 h30 a7 7 0 0 1 7 7 v3 h-44 z" fill={B.der.c} />
        <text x="162" y="124" textAnchor="middle" style={{ fontFamily: DISP, fontSize: 5.5, fontWeight: 700, fill: "#FFF", letterSpacing: ".12em" }}>JUNE</text>
        <text x="162" y="151" textAnchor="middle" style={{ fontFamily: DISP, fontSize: 5.5, fontWeight: 600, fill: P.faint, letterSpacing: ".06em" }}>DAY</text>

        <line x1="20" y1="168" x2="182" y2="168" stroke={GRN} strokeWidth="1.8" />
        <text x="20" y="180" style={{ fontFamily: DISP, fontSize: 7.5, fill: P.muted }}>spot $100</text>
        <line x1="20" y1="146" x2="182" y2="168" stroke={B.der.c} strokeWidth="1.8" strokeDasharray="3 3" />
        <text x="24" y="142" style={{ fontFamily: DISP, fontSize: 7.5, fill: B.der.c }}>June future $104</text>

        <line x1="20" y1="146" x2="20" y2="168" stroke={c} strokeWidth="1.4" />
        <circle cx="20" cy="146" r="2" fill={c} />
        <circle cx="20" cy="168" r="2" fill={c} />
        <text x="26" y="160" style={{ fontFamily: MONO, fontSize: 9, fill: c }}>$4</text>
        <text x="182" y="180" textAnchor="end" style={{ fontFamily: DISP, fontSize: 7.5, fill: P.muted }}>expiry · gap $0</text>

        {day("Day 1", "c-d1")}
        {day("Day 10", "c-d2")}
        {day("Day 20", "c-d3")}
        {day("Day 30", "c-d4")}

        <circle cx="0" cy="0" r="3.5" fill={B.der.c} stroke="#FFF" strokeWidth="1.2" style={{ animation: `c-dot ${L}` }} />
      </g>

      <text x="18" y="211" style={{ fontFamily: DISP, fontSize: 10.5, fontWeight: 700, fill: P.ink }}>Locked on day 1</text>
      <text x="182" y="213" textAnchor="end" style={{ ...fb, fontFamily: MONO, fontSize: 18, fill: c, animation: `a-fin ${L}` }}>+$4</text>
      <g style={{ ...fb, animation: `a-note ${L}` }}>
        <rect x="14" y="222" width="172" height="20" rx="10" fill={c} />
        <text x="100" y="235.5" textAnchor="middle" style={{ fontFamily: DISP, fontSize: 9, fontWeight: 700, fill: "#FFF" }}>
          You predicted nothing. You waited.
        </text>
      </g>
      <Pointer />
    </g>
  );
}

/* ---- Top traders: la classifica ---- */
const LB = [
  ["1", "0x7a1c…4e", "+$12,480", "71%"],
  ["2", "0xc4f2…9b", "+$9,310", "68%"],
  ["3", "0x33be…07", "+$7,940", "64%"],
  ["4", "0xd1a8…5c", "+$6,120", "59%"],
  ["5", "0x0e52…b3", "+$4,870", "57%"],
];

function TraderScene({ c }: any) {
  return (
    <g>
      <text x="100" y="19" textAnchor="middle" style={{ fontFamily: DISP, fontSize: 9.5, fontWeight: 600, fill: P.muted }}>
        Five thousand wallets · ranked on settled profit
      </text>
      <Chips c={c} list={[
        ["Everyone is ranked", "ink"],
        ["Scroll the leaderboard", "ink"],
        ["Stop on one of them", c],
        ["See what actually settled", "ink"],
        ["Copy it, or just watch", "c"],
      ]} />

      <rect x="8" y="58" width="184" height="102" rx="11" fill={P.surface} stroke={P.ink + "14"} />
      <text x="18" y="70" style={{ fontFamily: DISP, fontSize: 7, fontWeight: 700, fill: P.faint, letterSpacing: ".1em" }}>WALLET</text>
      <text x="140" y="70" textAnchor="end" style={{ fontFamily: DISP, fontSize: 7, fontWeight: 700, fill: P.faint, letterSpacing: ".1em" }}>SETTLED P&amp;L</text>
      <text x="182" y="70" textAnchor="end" style={{ fontFamily: DISP, fontSize: 7, fontWeight: 700, fill: P.faint, letterSpacing: ".1em" }}>WIN</text>

      {LB.map(([r, w, pnl, win]: any, i: any) => {
        const y = 84 + i * 16;
        return (
          <g key={r}>
            {i < 2 && (
              <rect x="13" y={y - 10} width="174" height="14" rx="4" fill={c + "14"} stroke={c} strokeWidth="1.1"
                style={{ animation: `${i === 0 ? "t-row1" : "t-row2"} ${L}` }} />
            )}
            <text x="18" y={y} style={{ fontFamily: DISP, fontSize: 8, fontWeight: 700, fill: P.faint }}>{r}</text>
            <text x="28" y={y} style={{ fontFamily: MONO, fontSize: 8.5, fill: P.ink }}>{w}</text>
            <text x="140" y={y} textAnchor="end" style={{ fontFamily: MONO, fontSize: 9, fill: GRN }}>{pnl}</text>
            <text x="182" y={y} textAnchor="end" style={{ fontFamily: MONO, fontSize: 8.5, fill: P.muted }}>{win}</text>
          </g>
        );
      })}

      <g style={{ animation: `t-row2 ${L}` }}>
        <rect x="8" y="166" width="184" height="52" rx="11" fill={P.surface} stroke={c} strokeWidth="1.3" />
        <text x="18" y="180" style={{ fontFamily: MONO, fontSize: 9, fill: P.ink }}>0xc4f2…9b</text>
        <text x="182" y="180" textAnchor="end" style={{ fontFamily: DISP, fontSize: 7.5, fontWeight: 600, fill: P.muted }}>340 settled trades</text>

        <path d="M18 208 L38 202 L58 205 L78 194 L98 197 L118 186 L138 181"
          stroke={c} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"
          strokeDasharray="150" style={{ animation: `t-draw ${L}` }} />
        <text x="18" y="214" style={{ fontFamily: DISP, fontSize: 7, fill: P.faint }}>SETTLED EQUITY</text>

        <text x="182" y="196" textAnchor="end" style={{ fontFamily: DISP, fontSize: 7.5, fontWeight: 600, fill: P.muted }}>win rate 68%</text>
        <rect x="146" y="200" width="36" height="5" rx="2.5" fill={P.ink + "12"} />
        <rect x="146" y="200" width="24.5" height="5" rx="2.5" fill={c}
          style={{ transformBox: "fill-box", transformOrigin: "left", animation: `t-win ${L}` } as React.CSSProperties} />
        <text x="182" y="215" textAnchor="end" style={{ fontFamily: MONO, fontSize: 15, fill: GRN }}>+$9,310</text>
      </g>

      <g style={{ ...fb, animation: `a-note ${L}` }}>
        <rect x="14" y="224" width="172" height="18" rx="9" fill={c} />
        <text x="100" y="236.5" textAnchor="middle" style={{ fontFamily: DISP, fontSize: 8.5, fontWeight: 700, fill: "#FFF" }}>
          Ranked on what settled, not on hope
        </text>
      </g>

      <Pointer an="t-cur" />
    </g>
  );
}

function Scene({ id, c }: any) {
  const s = (SCENES as any)[id];
  const col = (k: any) => (k === "ink" ? P.ink : k === "c" ? c : k);
  const lab = { fontFamily: DISP, fontSize: 9.5, fontWeight: 500, fill: P.muted };
  const val = { fontFamily: MONO, fontSize: 12.5, fill: P.ink };
  const anims = ["a-c1", "a-c2", "a-c3", "a-c4", "a-c5"];

  const chip = ([txt, k]: any, n: any) => {
    const w = Math.min(178, txt.length * 5.15 + 22);
    return (
      <g key={n} style={{ ...fb, animation: `${anims[n]} ${L}` }}>
        <rect x={100 - w / 2} y="32" width={w} height="20" rx="10" fill={col(k) + "1E"} />
        <text x="100" y="46" textAnchor="middle"
          style={{ fontFamily: DISP, fontSize: 10.5, fontWeight: 700, fill: col(k) }}>{txt}</text>
      </g>
    );
  };

  const card = (d: any, x: any, fl: any, ring: any, step: any) => (
    <g>
      <rect x={x} y="58" width="88" height="46" rx="11" fill={P.surface} stroke={P.ink + "14"} />
      <circle cx={x + 11} cy="68" r="3.5" fill={d.b.c} />
      <text x={x + 18} y="71" style={{ fontFamily: DISP, fontSize: 8, fontWeight: 600, fill: P.muted }}>{d.b.n}</text>
      <circle cx={x + 78} cy="67.5" r="6.5" fill={P.ink + "0D"} />
      <text x={x + 78} y="70.5" textAnchor="middle" style={{ fontFamily: DISP, fontSize: 8, fontWeight: 700, fill: P.muted }}>{step}</text>
      <text x={x + 10} y="88" style={{ fontFamily: DISP, fontSize: 11.5, fontWeight: 700, fill: c }}>{d.side}</text>
      <text x={x + 78} y="88" textAnchor="end" style={{ fontFamily: MONO, fontSize: 10.5, fill: P.ink }}>{d.price}</text>
      <rect x={x + 10} y="92" width="68" height="10" rx="5" fill={P.ink + "0A"} />
      <text x={x + 44} y="99.5" textAnchor="middle" style={{ fontFamily: DISP, fontSize: 7, fontWeight: 700, fill: P.faint }}>{d.btn}</text>
      <g style={{ animation: `${fl} ${L}` }}>
        <rect x={x} y="58" width="88" height="46" rx="11" fill={c + "10"} stroke={c} strokeWidth="2" />
        <rect x={x + 10} y="92" width="68" height="10" rx="5" fill={c} />
        <text x={x + 44} y="99.5" textAnchor="middle" style={{ fontFamily: DISP, fontSize: 7, fontWeight: 700, fill: "#FFF" }}>{d.done}</text>
      </g>
      <circle cx={x + 44} cy="97" r="9" fill="none" stroke={c} strokeWidth="2.5" style={{ ...fb, animation: `${ring} ${L}` }} />
    </g>
  );

  return (
    <g>
      <text x="100" y="19" textAnchor="middle" style={{ fontFamily: DISP, fontSize: 9.5, fontWeight: 600, fill: P.muted }}>{s.title}</text>

      {s.chips.map(chip)}

      <g style={{ animation: `a-cards ${L}` }}>
        {card(s.cards[0], 8, "a-fa", "a-ra", "1")}
        {card(s.cards[1], 104, "a-fb", "a-rb", "2")}
      </g>

      <rect x="8" y="110" width="184" height="134" rx="12" fill={P.surface} stroke={P.ink + "14"} />
      <text x="18" y={s.hideR2 ? 143 : 127} style={{ ...lab, fontWeight: s.hideR2 ? 700 : 500, fill: s.hideR2 ? P.ink : P.muted }}>{s.r1[0]}</text>
      <text x="182" y={s.hideR2 ? 143 : 127} textAnchor="end" style={{ ...val, fontSize: s.hideR2 ? 13.5 : 12.5, animation: `a-p1 ${L}` }}>{s.r1[1]}</text>

      {!s.hideR2 && (
        <g>
          <text x="18" y="143" style={lab}>{s.r2[0]}</text>
          <text x="182" y="143" textAnchor="end" style={{ ...val, animation: `a-p2 ${L}` }}>{s.r2[1]}</text>
        </g>
      )}
      {s.sum && (
        <g>
          <line x1="18" y1="151" x2="182" y2="151" stroke={P.ink + "16"} />
          <text x="18" y="167" style={{ ...lab, fontWeight: 700, fill: P.ink }}>{s.sum[0]}</text>
          <text x="182" y="167" textAnchor="end" style={{ ...val, fontSize: 13.5, animation: `a-sum ${L}` }}>{s.sum[1]}</text>
        </g>
      )}
      {s.bar ? (
        <g>
          <text x="18" y="182" style={lab}>{s.bar[0]}</text>
          <text x="182" y="182" textAnchor="end" style={{ fontFamily: MONO, fontSize: 10, fill: P.faint }}>{s.bar[1]}</text>
          <rect x="18" y="186" width="164" height="4" rx="2" fill={P.ink + "12"} />
          <rect x="18" y="186" width="164" height="4" rx="2" fill={c}
            style={{ transformBox: "fill-box", transformOrigin: "left", animation: `a-bar ${L}` } as React.CSSProperties} />
        </g>
      ) : (
        <g>
          <text x="18" y="185" style={lab}>{s.pay[0]}</text>
          <text x="182" y="185" textAnchor="end" style={{ ...val, fontSize: 13.5, fill: c, animation: `a-pay ${L}` }}>{s.pay[1]}</text>
        </g>
      )}
      <line x1="18" y1="193" x2="182" y2="193" stroke={P.ink + "16"} />
      <text x="18" y="211" style={{ fontFamily: DISP, fontSize: 10.5, fontWeight: 700, fill: P.ink }}>{s.fin[0]}</text>
      <text x="182" y="213" textAnchor="end" style={{ ...fb, fontFamily: MONO, fontSize: 20, fill: c, animation: `a-fin ${L}` }}>{s.fin[1]}</text>

      <g style={{ ...fb, animation: `a-note ${L}` }}>
        <rect x="14" y="220" width="172" height="20" rx="10" fill={c} />
        <text x="100" y="233.5" textAnchor="middle" style={{ fontFamily: DISP, fontSize: 9, fontWeight: 700, fill: "#FFF" }}>{s.note}</text>
      </g>

      <Pointer />
    </g>
  );
}

function Il({ id, c }: any) {
  return (
    <div className="illu" style={{ background: P.ground, borderRadius: 14, border: `1px solid ${P.ink}0F`,
      overflow: "hidden", minWidth: 0, aspectRatio: "200 / 248", margin: "0 auto" }}>
      <svg viewBox="0 0 200 248" width="100%" height="100%" style={{ display: "block" }}>
        {id === "maker" ? <BookScene c={c} />
          : id === "carry" ? <CarryScene c={c} />
          : id === "trader" ? <TraderScene c={c} />
          : <Scene id={id} c={c} />}
      </svg>
    </div>
  );
}

/* ---------- lista ---------- */

function List({ edges, row, view: viewMax, nar, hov, i, setI, setHold, onPick }: any) {
  const shell = { background: P.surface, borderRadius: 22, overflow: "hidden", minWidth: 0,
    boxShadow: "0 24px 60px -22px rgba(45,36,24,0.3)" };

  if (!edges.length) return (
    <div style={{ ...shell, padding: "48px 26px", textAlign: "center" }}>
      <div className="d" style={{ fontSize: 19, fontWeight: 600, color: P.faint }}>Nothing on the board clears fees right now.</div>
      <div style={{ fontSize: 13, color: P.faint, marginTop: 8 }}>Still scanning. We&apos;ll light up the moment one does.</div>
    </div>
  );

  const view = Math.min(viewMax, edges.length);
  const off = Math.min(Math.max(0, i - 2), Math.max(0, edges.length - view));
  const cur = edges[Math.min(i, edges.length - 1)];

  return (
    <div onMouseEnter={() => hov && setHold(true)} onMouseLeave={() => hov && setHold(false)} style={shell}>
      <div style={{ height: row * view, overflow: "hidden", transition: "height .4s cubic-bezier(.2,.8,.2,1)" }}>
        <div style={{ transform: `translateY(${-off * row}px)`, transition: "transform .55s cubic-bezier(.2,.8,.2,1)" }}>
          {edges.map((e: any, n: any) => {
            const on = n === i;
            return (
              <div key={e.n} className="row" onMouseEnter={() => hov && setI(n)} onClick={() => onPick(n)}
                style={{ height: row, display: "flex", alignItems: "center", gap: 12,
                  cursor: "pointer", background: on ? e.c + "0D" : "transparent",
                  borderLeft: `3px solid ${on ? e.c : "transparent"}`, borderBottom: `1px solid ${P.ink}0A`,
                  transition: "background .35s, border-color .35s" }}>
                <span style={{ width: 7, height: 7, borderRadius: 4, background: e.c, flexShrink: 0,
                  opacity: on ? 1 : .4, transition: "opacity .35s" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="d clip" style={{ fontSize: on ? (nar ? 16 : 15) : (nar ? 14.5 : 13.5), fontWeight: 600,
                    color: on ? P.ink : P.muted, transition: "font-size .35s, color .35s" }}>{e.n}</div>
                  <div style={{ marginTop: 3, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", rowGap: 2 }}>
                    <span className="m" style={{ fontSize: 9, fontWeight: 500, letterSpacing: ".06em", flexShrink: 0,
                      padding: "2px 6px", borderRadius: 4, transition: "color .35s, background .35s",
                      color: on ? e.c : P.faint, background: on ? e.c + "16" : P.ink + "08" }}>{e.k}</span>
                    <span style={{ fontSize: nar ? 12 : 11, fontWeight: 500, color: on ? P.muted : P.faint,
                      transition: "color .35s" }}>{e.g}</span>
                    {on && <span style={{ fontSize: nar ? 11.5 : 10.5, color: P.faint }}>· {e.u}</span>}
                  </div>
                </div>
                <span className="m val" style={{ fontSize: on ? (nar ? 22 : 25) : 16, color: on ? e.c : P.faint,
                  transition: "font-size .35s, color .35s" }}>{e.v}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="row" style={{ paddingTop: 11, paddingBottom: 11, display: "flex", justifyContent: "space-between",
        alignItems: "center", gap: 10, background: P.ground + "80" }}>
        <span className="m" style={{ fontSize: 10, color: P.faint, whiteSpace: "nowrap" }}>{edges.length} live · 12s ago</span>
        <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
          {edges.map((_: any, n: any) => <span key={n} style={{ width: 4, height: 4, borderRadius: 2,
            background: n === i ? cur.c : P.ink + "1A", transition: "background .3s" }} />)}
        </div>
      </div>
    </div>
  );
}

function Mark() {
  return (
    <svg width="38" height="38" viewBox="0 0 38 38" style={{ flexShrink: 0 }}>
      <defs>
        <linearGradient id="sw" x1="19" y1="19" x2="36" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={P.mint} stopOpacity=".38" />
          <stop offset="1" stopColor={P.mint} stopOpacity="0" />
        </linearGradient>
      </defs>
      <circle cx="19" cy="19" r="17" fill="none" stroke={P.mint} strokeWidth="1.6" opacity=".22" />
      <circle cx="19" cy="19" r="11.5" fill="none" stroke={P.mint} strokeWidth="1.6" opacity=".38" />
      <circle cx="19" cy="19" r="6" fill="none" stroke={P.mint} strokeWidth="1.6" opacity=".55" />
      <g style={{ animation: "sweep 3.4s linear infinite", transformOrigin: "19px 19px" }}>
        <path d="M19 19 L36 19 A17 17 0 0 0 27.5 4.3 Z" fill="url(#sw)" />
        <line x1="19" y1="19" x2="36" y2="19" stroke={P.mint} strokeWidth="1.4" opacity=".75" />
        <circle cx="26.5" cy="11.5" r="4.6" fill={P.mint} />
      </g>
    </svg>
  );
}
