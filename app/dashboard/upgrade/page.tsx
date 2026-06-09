'use client';
import { useState } from 'react';
import { useSession } from 'next-auth/react';

const PLANS = [
  {
    key:         'free',
    name:        'Free',
    price:       '€0',
    period:      'forever',
    color:       'border-gray-700',
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
    color:       'border-blue-500',
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
    color:       'border-purple-500',
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
    <main className="text-text-primary">
      <div className="max-w-5xl mx-auto px-4 py-12">
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold mb-3">Choose Your Plan</h1>
          <p className="text-gray-400">Unlock the full power of AI-driven prediction market arbitrage</p>
        </div>

        {error   && <div className="mb-6 p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-300 text-sm text-center">{error}</div>}
        {success && <div className="mb-6 p-3 rounded-lg bg-green-900/40 border border-green-700 text-green-300 text-sm text-center">Plan upgraded successfully! Refresh the page to see changes.</div>}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {PLANS.map(plan => (
            <div key={plan.key} className={`rounded-xl border-2 ${plan.color} bg-gray-900/60 p-6 flex flex-col relative`}>
              {plan.badge && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-blue-600 text-xs font-bold text-white">
                  {plan.badge}
                </div>
              )}
              <div className="mb-4">
                <h2 className="text-xl font-bold mb-1">{plan.name}</h2>
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-black">{plan.price}</span>
                  <span className="text-gray-400 text-sm">{plan.period}</span>
                </div>
              </div>
              <ul className="space-y-2 flex-1 mb-6">
                {plan.features.map(f => (
                  <li key={f} className="flex items-start gap-2 text-sm text-gray-300">
                    <span className="text-green-400 mt-0.5">✓</span>{f}
                  </li>
                ))}
              </ul>
              {plan.ctaFn ? (
                <button
                  onClick={() => upgrade(plan.ctaFn!)}
                  disabled={loading === plan.ctaFn || success === plan.ctaFn}
                  className={`w-full py-2.5 rounded-lg font-semibold text-sm transition-colors
                    ${plan.key === 'pro'
                      ? 'bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50'
                      : 'bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-50'}`}
                >
                  {loading === plan.ctaFn ? 'Processing…' : success === plan.ctaFn ? '✓ Upgraded' : plan.cta}
                </button>
              ) : (
                <div className="w-full py-2.5 rounded-lg font-semibold text-sm text-center bg-gray-800 text-gray-400">
                  {plan.cta}
                </div>
              )}
            </div>
          ))}
        </div>

        <p className="text-center text-gray-500 text-xs mt-8">
          For Pro: pay via bank transfer or crypto — contact us after clicking Upgrade.<br />
          Not financial advice. Always verify opportunities before trading.
        </p>
      </div>
    </main>
  );
}
