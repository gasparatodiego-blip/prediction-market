import LandingCTAs from './LandingCTAs';

export default function LandingHero() {
  return (
    <section className="pt-2">
      {/* Badge */}
      <div className="mb-5">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted border border-border px-2.5 py-[5px]">
          MULTI-STRATEGY SCANNER
        </span>
      </div>

      {/* Headline */}
      <h1 className="font-sans font-semibold text-5xl md:text-[3.4rem] leading-[1.04] tracking-[-0.03em] text-text-primary mb-4 max-w-2xl">
        Multi-strategy arb<br />
        &amp;&nbsp;<span className="text-accent">funding</span> —<br />
        net of fees, live.
      </h1>

      {/* Tagline */}
      <p className="font-mono text-[12px] text-text-secondary max-w-lg mb-7 leading-[1.7]">
        Everyone else inflates the numbers.{' '}
        <span className="text-text-primary">We measure them</span>{' '}
        — every spread, funding gap, and mispriced market, net of fees, live.
      </p>

      {/* CTAs — open email capture modal, then navigate */}
      <LandingCTAs />

      {/* Disclaimer */}
      <p className="font-mono text-[9px] text-text-muted/40 max-w-xl leading-relaxed">
        Not financial advice. Returns are variable and not guaranteed.
        Do your own research before committing capital.
      </p>
    </section>
  );
}
