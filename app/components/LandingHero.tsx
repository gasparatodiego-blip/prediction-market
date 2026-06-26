import LandingCTAs from './LandingCTAs';

export default function LandingHero() {
  return (
    <section className="pt-2">
      {/* Badge */}
      <div className="mb-5">
        <span className="font-body text-[10px] uppercase tracking-[0.16em] text-muted border border-line px-2.5 py-[5px] rounded-pill">
          MULTI-STRATEGY SCANNER
        </span>
      </div>

      {/* Headline */}
      <h1 className="font-display font-semibold text-5xl md:text-[3.4rem] leading-[1.04] tracking-[-0.03em] text-ink mb-4 max-w-2xl">
        Multi-strategy arb<br />
        &amp;&nbsp;<span className="text-mint">funding</span> —<br />
        net of fees, live.
      </h1>

      {/* Tagline */}
      <p className="font-body text-[13px] text-ink-2 max-w-lg mb-7 leading-[1.7]">
        Everyone else inflates the numbers.{' '}
        <span className="text-ink font-medium">We measure them</span>{' '}
        — every spread, funding gap, and mispriced market, net of fees, live.
      </p>

      {/* CTAs — open email capture modal, then navigate */}
      <LandingCTAs />

      {/* Disclaimer */}
      <p className="font-body text-[9px] text-muted/40 max-w-xl leading-relaxed">
        Not financial advice. Returns are variable and not guaranteed.
        Do your own research before committing capital.
      </p>
    </section>
  );
}
