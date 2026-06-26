'use client';
import { useState } from 'react';
import { useSession } from 'next-auth/react';

const PLANS = [
  {
    key:         'free',
    name:        'Free',
    price:       '€0',
    period:      'forever',
    color:       'border-line',
    badge:       null,
    features: [
      'Top 3 opportunities per scan',
      'Basic dashboard',
      'Portfolio tracker',
      '5-minute data delay',
      'No Telegram alerts',
    ],
    cta:    'Current Plan',
    ctaFn:  null,
  },
  {
    key:         'pro',
    name:        'Pro',
    price:       '€15',
    period:      '/month',
    color:       'border-violet',
    badge:       'Most Popular',
    features: [
      'All opportunities (unlimited)',
      'Real-time data',
      'Telegram alerts',
      'Email alerts',
      'Kelly sizing calculator',
      'Full portfolio tracker',
      'Priority support',
    ],
    cta:    'Upgrade to Pro',
    ctaFn:  'pro',
  },
  {
    key:         'profit_share',
    name:        'Profit Share',
    price:       '€0 upfront',
    period:      '+ 10% of profits',
    color:       'border-violet/50',
    badge:       'Best Value',
    features: [
      'Everything in Pro',
      'No monthly fee',
      '10% of tracked profits billed monthly',
      'Personalized onboarding',
      'Direct analyst access',
    ],
    cta:    'Contact Us',
    ctaFn:  'contact',
  },
];

export default function UpgradePage() {
  const { data: session } = useSession();
  const [loading, setLoading] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [error,   setError]   = useState<string | null>(null);

  async function upgrade(plan: string) {
    if (plan === 'contact') {
      window.open('mailto:gasparatodiego@gmail.com?subject=Profit Share Plan', '_blank');
      return;
    }
    if (!session) { window.location.href = '/auth/login'; return; }
    setLoading(plan);
    setError(null);
    try {
      const res  = await fetch('/api/subscription', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      setSuccess(plan);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  return (
    <main className="text-ink">
      <div className="max-w-5xl mx-auto px-4 py-12">
        <div className="text-center mb-10">
          <h1 className="font-display font-bold text-3xl text-ink mb-3">Choose Your Plan</h1>
          <p className="font-body text-muted">Unlock the full power of AI-driven prediction market arbitrage</p>
        </div>

        {error   && <div className="mb-6 p-3 rounded-card bg-coral-tint border border-coral-ink/30 text-coral-ink font-body text-sm text-center">{error}</div>}
        {success && <div className="mb-6 p-3 rounded-card bg-mint-tint border border-mint-deep/30 text-mint-deep font-body text-sm text-center">Plan upgraded successfully! Refresh the page to see changes.</div>}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {PLANS.map(plan => (
            <div key={plan.key} className={`rounded-card border-2 ${plan.color} bg-surface p-6 flex flex-col relative shadow-card`}>
              {plan.badge && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-pill bg-violet text-xs font-body font-bold text-white">
                  {plan.badge}
                </div>
              )}
              <div className="mb-4">
                <h2 className="font-display font-semibold text-xl text-ink mb-1">{plan.name}</h2>
                <div className="flex items-baseline gap-1">
                  <span className="font-display font-black text-3xl text-ink">{plan.price}</span>
                  <span className="font-body text-muted text-sm">{plan.period}</span>
                </div>
              </div>
              <ul className="space-y-2 flex-1 mb-6">
                {plan.features.map(f => (
                  <li key={f} className="flex items-start gap-2 font-body text-sm text-ink-2">
                    <span className="text-mint-deep mt-0.5">✓</span>{f}
                  </li>
                ))}
              </ul>
              {plan.ctaFn ? (
                <button
                  onClick={() => upgrade(plan.ctaFn!)}
                  disabled={loading === plan.ctaFn || success === plan.ctaFn}
                  className={`w-full py-2.5 rounded-button font-body font-semibold text-sm transition-colors
                    ${plan.key === 'pro'
                      ? 'bg-violet hover:bg-violet/90 text-white disabled:opacity-50'
                      : 'bg-violet/70 hover:bg-violet/60 text-white disabled:opacity-50'}`}
                >
                  {loading === plan.ctaFn ? 'Processing…' : success === plan.ctaFn ? '✓ Upgraded' : plan.cta}
                </button>
              ) : (
                <div className="w-full py-2.5 rounded-button font-body font-semibold text-sm text-center bg-bg-soft text-muted">
                  {plan.cta}
                </div>
              )}
            </div>
          ))}
        </div>

        <p className="text-center font-body text-muted text-xs mt-8">
          For Pro: pay via bank transfer or crypto — contact us after clicking Upgrade.<br />
          Not financial advice. Always verify opportunities before trading.
        </p>
      </div>
    </main>
  );
}
