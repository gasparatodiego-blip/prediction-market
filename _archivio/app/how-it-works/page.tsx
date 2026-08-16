import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import RadarMark from '@/app/components/ui/RadarMark';
import { GLOSSARY, GLOSSARY_ORDER } from '@/lib/glossary';

// Public, no gating. Every definition here renders from lib/glossary.ts — the
// exact same source the inline <InfoDot> tooltips use — so the page and the
// tooltips can never disagree. Purely educational: no numbers, no data, no CTA.

export const metadata = {
  title: 'How Edgeradar works — the honest engine',
  description:
    'How Edgeradar labels opportunities: the three tiers (Cashable / Arb soft / Signal), the honest-engine promise, edge vs Pinnacle no-vig fair, and a full plain-language glossary.',
};

const TIERS = [
  {
    term: 'cashable' as const,
    cls: 'border-mint-deep/30 bg-mint-tint/40',
    dot: 'bg-mint-deep',
    head: 'text-mint-deep',
  },
  {
    term: 'arb_soft' as const,
    cls: 'border-gold/40 bg-gold-tint/40',
    dot: 'bg-gold',
    head: 'text-gold',
  },
  {
    term: 'signal' as const,
    cls: 'border-violet/30 bg-violet-tint/40',
    dot: 'bg-violet',
    head: 'text-violet',
  },
];

const PROMISES = [
  'Executable prices only. Numbers are drawn from real order books and quoted lines — not open interest, not mid-point guesses.',
  'No fabrication. If a value is unknown it shows as “—”, never a zero and never an invented figure.',
  'Too-good-to-be-true is suppressed. Figures that swing wildly or read implausibly are flagged or held back, not shown as a headline.',
  'Indicative, not guaranteed. Estimates (net $/day, annualized run-rates) are labelled as projections at current conditions — and capped.',
  'Losses shown calmly. A red or negative number is displayed plainly as information, never hidden and never dressed up as an error.',
];

export default function HowItWorksPage() {
  return (
    <div
      className="min-h-screen text-ink"
      style={{
        background:
          'radial-gradient(circle at 50% -10%, rgba(15,190,130,.05), transparent 60%), #F5F8F6',
      }}
    >
      {/* Top bar — matches EdgeradarHeader chrome (this route is outside the dashboard layout) */}
      <header className="sticky top-0 z-40 bg-surface border-b border-line">
        <div className="max-w-[860px] mx-auto px-4 flex items-center h-12 gap-4">
          <Link href="/dashboard" className="flex items-center gap-2 shrink-0">
            <RadarMark size={22} />
            <span className="font-display font-semibold text-[17px] text-ink tracking-tight leading-none">
              Edgeradar
            </span>
          </Link>
          <Link
            href="/dashboard"
            className="ml-auto inline-flex items-center gap-1.5 font-body text-[13px] text-muted hover:text-ink-2 transition-colors"
          >
            <ArrowLeft size={14} /> Back to dashboard
          </Link>
        </div>
      </header>

      <main className="max-w-[860px] mx-auto px-4 py-10">
        {/* Intro */}
        <p className="font-body text-[11px] uppercase tracking-[0.18em] text-mint-deep mb-3">
          How it works
        </p>
        <h1 className="font-display font-bold text-ink text-[30px] leading-tight tracking-tight mb-4">
          Honest numbers, plainly labelled.
        </h1>
        <p className="font-body text-[14px] text-ink-2 leading-relaxed max-w-[620px] mb-10">
          Edgeradar scans prediction markets, sportsbooks and perp/spot venues for
          edge. Every figure is measured from executable prices and labelled for
          exactly what it is — a locked arbitrage, a fragile one, or a favorable
          bet that can still lose. Nothing here is a promise of profit.
        </p>

        {/* Three tiers */}
        <section className="mb-12">
          <h2 className="font-display font-semibold text-ink text-[19px] mb-1">
            The three tiers
          </h2>
          <p className="font-body text-[13px] text-muted mb-5 leading-relaxed">
            Every opportunity is sorted into one of three honesty tiers. The color
            follows it everywhere on the dashboard.
          </p>
          <div className="space-y-3">
            {TIERS.map(({ term, cls, dot, head }) => {
              const g = GLOSSARY[term];
              return (
                <div key={term} className={`rounded-card border ${cls} px-4 py-4`}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`w-2 h-2 rounded-full ${dot}`} aria-hidden />
                    <span className={`font-body font-semibold text-[12px] uppercase tracking-wide ${head}`}>
                      {g.title}
                    </span>
                  </div>
                  <p className="font-body text-[13px] text-ink-2 leading-relaxed">
                    {g.short}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        {/* Honest-engine promise */}
        <section className="mb-12">
          <h2 className="font-display font-semibold text-ink text-[19px] mb-1">
            The honest-engine promise
          </h2>
          <p className="font-body text-[13px] text-muted mb-5 leading-relaxed">
            Five rules the whole product is built around.
          </p>
          <ul className="space-y-3">
            {PROMISES.map((p, i) => (
              <li key={i} className="flex gap-3">
                <span
                  className="mt-[6px] w-1.5 h-1.5 rounded-full bg-mint-deep shrink-0"
                  aria-hidden
                />
                <span className="font-body text-[13px] text-ink-2 leading-relaxed">
                  {p}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* Edge vs no-vig fair */}
        <section className="mb-12">
          <h2 className="font-display font-semibold text-ink text-[19px] mb-1">
            How we compute edge vs a sharp book
          </h2>
          <div className="rounded-card bg-surface shadow-card px-5 py-5 mt-4 space-y-3">
            <p className="font-body text-[13px] text-ink-2 leading-relaxed">
              A sportsbook’s odds always carry a built-in margin — the{' '}
              <b className="text-ink">vig</b>. On our roster only{' '}
              <b className="text-ink">Pinnacle</b> is treated as a{' '}
              <b className="text-ink">sharp book</b>: its prices set the reference.
            </p>
            <p className="font-body text-[13px] text-ink-2 leading-relaxed">
              We strip Pinnacle’s vig out of both sides of a market to recover the{' '}
              <b className="text-ink">no-vig fair</b> line — the implied fair
              probability with no house margin. That fair line is the anchor.
            </p>
            <p className="font-body text-[13px] text-ink-2 leading-relaxed">
              A soft book’s price is then compared to that fair line. If it pays
              more than fair, the gap is the <b className="text-ink">Signal</b> edge.
              It is favorable — but a single bet, so it can still lose. Only when
              opposing legs together price below 1 do we call it a true arbitrage
              (<b className="text-mint-deep">Cashable</b> if a Pinnacle leg covers
              it, <b className="text-gold">Arb soft</b> if not).
            </p>
          </div>
        </section>

        {/* Full glossary — rendered from the same source as the tooltips */}
        <section>
          <h2 className="font-display font-semibold text-ink text-[19px] mb-1">
            Glossary
          </h2>
          <p className="font-body text-[13px] text-muted mb-5 leading-relaxed">
            Every term that carries an ⓘ dot on the dashboard, defined once here.
          </p>
          <dl className="rounded-card bg-surface shadow-card divide-y divide-line/70 overflow-hidden">
            {GLOSSARY_ORDER.map((term) => {
              const g = GLOSSARY[term];
              return (
                <div key={term} className="px-5 py-4">
                  <dt className="font-body font-semibold text-[13px] text-ink mb-1">
                    {g.title}
                  </dt>
                  <dd className="font-body text-[13px] text-ink-2 leading-relaxed">
                    {g.short}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>

        <p className="font-body text-[11px] text-muted mt-10 leading-relaxed">
          Edgeradar surfaces opportunities and shows its work. It does not place
          trades for you, and no figure here is financial advice or a guarantee of
          profit.
        </p>
      </main>
    </div>
  );
}
