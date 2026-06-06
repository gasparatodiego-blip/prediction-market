'use client';
import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';

const ALL_PLATFORMS   = ['kalshi', 'polymarket', 'manifold', 'predictit', 'metaculus', 'betfair'];
const ALL_ALERT_TYPES = ['prediction_market', 'funding_rate', 'cex_arb', 'sports_arb', 'info_lag', 'cash_carry'];

export default function PreferencesPage() {
  const { data: session, status } = useSession();
  const [prefs,   setPrefs]   = useState({ minRoi: 3, minConfidence: 60, platforms: ['kalshi','polymarket','manifold','predictit'], alertTypes: ['prediction_market','funding_rate','cex_arb'], maxBankroll: 1000, alertsEnabled: true });
  const [telegram, setTelegram] = useState('');
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [saved,    setSaved]    = useState(false);

  useEffect(() => {
    if (status === 'authenticated') loadPrefs();
  }, [status]);

  async function loadPrefs() {
    const res  = await fetch('/api/user/preferences');
    if (res.ok) {
      const data = await res.json();
      if (data.minRoi        != null) setPrefs(p => ({ ...p, minRoi:        data.minRoi }));
      if (data.minConfidence != null) setPrefs(p => ({ ...p, minConfidence: data.minConfidence }));
      if (data.platforms?.length)     setPrefs(p => ({ ...p, platforms:     data.platforms }));
      if (data.alertTypes?.length)    setPrefs(p => ({ ...p, alertTypes:    data.alertTypes }));
      if (data.maxBankroll   != null) setPrefs(p => ({ ...p, maxBankroll:   data.maxBankroll }));
      if (data.alertsEnabled != null) setPrefs(p => ({ ...p, alertsEnabled: data.alertsEnabled }));
    }
    // Load telegram from user
    const uRes = await fetch('/api/user/preferences');
    setLoading(false);
  }

  function toggleArr(arr: string[], val: string): string[] {
    return arr.includes(val) ? arr.filter(x => x !== val) : [...arr, val];
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await fetch('/api/user/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...prefs, telegramChatId: telegram || undefined }),
    });
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  if (status === 'loading' || loading) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="flex gap-2">{[0,1,2].map(i => <div key={i} className="w-2.5 h-2.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: `${i*0.15}s` }} />)}</div>
    </div>
  );

  if (status === 'unauthenticated') return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="text-center">
        <p className="text-gray-300 mb-4">Sign in to manage preferences</p>
        <Link href="/auth/login" className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500">Sign In</Link>
      </div>
    </div>
  );

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <header className="sticky top-0 z-10 border-b border-gray-800 bg-gray-900/90 backdrop-blur-sm px-4 md:px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Preferences</h1>
          <p className="text-xs text-gray-500">{session?.user?.email}</p>
        </div>
        <Link href="/dashboard" className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 text-xs hover:border-gray-500 hover:text-gray-300">← Dashboard</Link>
      </header>

      <div className="max-w-2xl mx-auto px-4 md:px-6 py-6">
        <form onSubmit={save} className="space-y-7">

          {/* Thresholds */}
          <section className="rounded-xl border border-gray-800 bg-gray-900/40 p-5 space-y-5">
            <h2 className="text-sm font-bold text-gray-300">Alert Thresholds</h2>

            <div>
              <div className="flex justify-between mb-2">
                <label className="text-xs text-gray-400 font-semibold">Minimum ROI</label>
                <span className="text-xs text-blue-400 font-bold">{prefs.minRoi}%</span>
              </div>
              <input type="range" min={0} max={50} step={0.5} value={prefs.minRoi}
                onChange={e => setPrefs(p => ({ ...p, minRoi: parseFloat(e.target.value) }))}
                className="w-full accent-blue-500" />
              <div className="flex justify-between text-xs text-gray-600 mt-1"><span>0%</span><span>50%</span></div>
            </div>

            <div>
              <div className="flex justify-between mb-2">
                <label className="text-xs text-gray-400 font-semibold">Minimum AI Confidence</label>
                <span className="text-xs text-blue-400 font-bold">{prefs.minConfidence}%</span>
              </div>
              <input type="range" min={0} max={100} step={5} value={prefs.minConfidence}
                onChange={e => setPrefs(p => ({ ...p, minConfidence: parseInt(e.target.value) }))}
                className="w-full accent-blue-500" />
              <div className="flex justify-between text-xs text-gray-600 mt-1"><span>0%</span><span>100%</span></div>
            </div>

            <div>
              <div className="flex justify-between mb-2">
                <label className="text-xs text-gray-400 font-semibold">Default Bankroll</label>
                <span className="text-xs text-blue-400 font-bold">${prefs.maxBankroll.toLocaleString()}</span>
              </div>
              <input type="number" min={1} value={prefs.maxBankroll}
                onChange={e => setPrefs(p => ({ ...p, maxBankroll: parseFloat(e.target.value) || 1000 }))}
                className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500" />
            </div>
          </section>

          {/* Platforms */}
          <section className="rounded-xl border border-gray-800 bg-gray-900/40 p-5 space-y-3">
            <h2 className="text-sm font-bold text-gray-300">Platforms</h2>
            <div className="flex flex-wrap gap-2">
              {ALL_PLATFORMS.map(p => (
                <button type="button" key={p} onClick={() => setPrefs(pr => ({ ...pr, platforms: toggleArr(pr.platforms, p) }))}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors capitalize ${
                    prefs.platforms.includes(p) ? 'border-blue-600 bg-blue-900/50 text-blue-300' : 'border-gray-700 text-gray-500 hover:border-gray-500'
                  }`}>{p}</button>
              ))}
            </div>
          </section>

          {/* Alert types */}
          <section className="rounded-xl border border-gray-800 bg-gray-900/40 p-5 space-y-3">
            <h2 className="text-sm font-bold text-gray-300">Alert Types</h2>
            <div className="flex flex-wrap gap-2">
              {ALL_ALERT_TYPES.map(t => (
                <button type="button" key={t} onClick={() => setPrefs(pr => ({ ...pr, alertTypes: toggleArr(pr.alertTypes, t) }))}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                    prefs.alertTypes.includes(t) ? 'border-blue-600 bg-blue-900/50 text-blue-300' : 'border-gray-700 text-gray-500 hover:border-gray-500'
                  }`}>{t.replace(/_/g, ' ')}</button>
              ))}
            </div>
          </section>

          {/* Telegram */}
          <section className="rounded-xl border border-gray-800 bg-gray-900/40 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-gray-300">Telegram Alerts</h2>
              <label className="flex items-center gap-2 cursor-pointer">
                <span className="text-xs text-gray-500">Enabled</span>
                <div className={`w-10 h-5 rounded-full transition-colors cursor-pointer ${prefs.alertsEnabled ? 'bg-blue-600' : 'bg-gray-700'}`}
                  onClick={() => setPrefs(p => ({ ...p, alertsEnabled: !p.alertsEnabled }))}>
                  <div className={`w-4 h-4 rounded-full bg-white m-0.5 transition-transform ${prefs.alertsEnabled ? 'translate-x-5' : ''}`} />
                </div>
              </label>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Your Telegram Chat ID</label>
              <input type="text" value={telegram} onChange={e => setTelegram(e.target.value)}
                placeholder="e.g. 8844610430 (from @userinfobot)"
                className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500" />
              <p className="text-xs text-gray-600 mt-1">Send /start to @userinfobot on Telegram to get your chat ID</p>
            </div>
          </section>

          <button type="submit" disabled={saving}
            className={`w-full py-3 rounded-xl text-sm font-bold transition-colors ${saved ? 'bg-green-600 text-white' : 'bg-blue-600 hover:bg-blue-500 text-white'} disabled:opacity-50`}>
            {saving ? 'Saving…' : saved ? '✓ Saved!' : 'Save Preferences'}
          </button>
        </form>
      </div>
    </main>
  );
}
