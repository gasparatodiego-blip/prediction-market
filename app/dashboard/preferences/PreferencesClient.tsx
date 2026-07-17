'use client';
import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';

const ALL_PLATFORMS   = ['kalshi', 'polymarket', 'manifold', 'predictit', 'metaculus', 'betfair'];
const ALL_ALERT_TYPES = ['prediction_market', 'funding_rate', 'cex_arb', 'sports_arb', 'info_lag', 'cash_carry'];

export default function PreferencesClient() {
  const { data: session, status } = useSession();
  const [prefs, setPrefs] = useState({
    minRoi: 3, minConfidence: 60,
    platforms: ['kalshi','polymarket','manifold','predictit'],
    alertTypes: ['prediction_market','funding_rate','cex_arb'],
    maxBankroll: 1000, alertsEnabled: true,
  });
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
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="flex gap-1.5">
        {[0,1,2].map(i => (
          <div key={i} className="w-2 h-2 bg-mint rounded-full animate-bounce" style={{ animationDelay: `${i*0.15}s` }} />
        ))}
      </div>
    </div>
  );

  if (status === 'unauthenticated') return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="text-center">
        <p className="font-body text-ink-2 text-sm mb-4">SIGN IN TO MANAGE PREFERENCES</p>
        <Link href="/auth/login" className="px-4 py-2 rounded-button border border-mint/40 bg-mint/10 text-mint font-body text-xs hover:bg-mint/20 transition-colors duration-100">
          SIGN IN
        </Link>
      </div>
    </div>
  );

  const inputClass = "w-full px-3 py-2 rounded-button bg-surface border border-line text-ink font-body text-sm focus:outline-none focus:border-mint/60 placeholder:text-muted";

  return (
    <main className="text-ink">
      <div className="max-w-2xl mx-auto px-4 md:px-6 py-6">
        <form onSubmit={save} className="space-y-5">

          {/* Alert Thresholds */}
          <section className="rounded-card border border-line bg-surface p-5 space-y-5 shadow-card">
            <h2 className="font-body text-xs font-semibold text-muted uppercase tracking-widest">ALERT THRESHOLDS</h2>

            <div>
              <div className="flex justify-between mb-2">
                <label className="font-body text-xs text-ink-2 uppercase tracking-wide">Minimum ROI</label>
                <span className="font-mono text-xs text-mint font-bold tabular-nums">{prefs.minRoi}%</span>
              </div>
              <input type="range" min={0} max={50} step={0.5} value={prefs.minRoi}
                onChange={e => setPrefs(p => ({ ...p, minRoi: parseFloat(e.target.value) }))}
                className="w-full accent-mint" />
              <div className="flex justify-between font-body text-xs text-muted mt-1"><span>0%</span><span>50%</span></div>
            </div>

            <div>
              <div className="flex justify-between mb-2">
                <label className="font-body text-xs text-ink-2 uppercase tracking-wide">Minimum AI Confidence</label>
                <span className="font-mono text-xs text-mint font-bold tabular-nums">{prefs.minConfidence}%</span>
              </div>
              <input type="range" min={0} max={100} step={5} value={prefs.minConfidence}
                onChange={e => setPrefs(p => ({ ...p, minConfidence: parseInt(e.target.value) }))}
                className="w-full accent-mint" />
              <div className="flex justify-between font-body text-xs text-muted mt-1"><span>0%</span><span>100%</span></div>
            </div>

            <div>
              <div className="flex justify-between mb-2">
                <label className="font-body text-xs text-ink-2 uppercase tracking-wide">Default Bankroll</label>
                <span className="font-mono text-xs text-mint font-bold tabular-nums">${prefs.maxBankroll.toLocaleString()}</span>
              </div>
              <input type="number" min={1} value={prefs.maxBankroll}
                onChange={e => setPrefs(p => ({ ...p, maxBankroll: parseFloat(e.target.value) || 1000 }))}
                className={inputClass} />
            </div>
          </section>

          {/* Platforms */}
          <section className="rounded-card border border-line bg-surface p-5 space-y-3 shadow-card">
            <h2 className="font-body text-xs font-semibold text-muted uppercase tracking-widest">PLATFORMS</h2>
            <div className="flex flex-wrap gap-2">
              {ALL_PLATFORMS.map(p => (
                <button type="button" key={p}
                  onClick={() => setPrefs(pr => ({ ...pr, platforms: toggleArr(pr.platforms, p) }))}
                  className={`px-2.5 py-1 rounded-button border font-body text-xs uppercase tracking-wide transition-colors duration-100 ${
                    prefs.platforms.includes(p)
                      ? 'border-mint/50 bg-mint/10 text-mint'
                      : 'border-line bg-bg-soft text-muted hover:border-mint/30 hover:text-ink-2'
                  }`}>
                  {p}
                </button>
              ))}
            </div>
          </section>

          {/* Alert types */}
          <section className="rounded-card border border-line bg-surface p-5 space-y-3 shadow-card">
            <h2 className="font-body text-xs font-semibold text-muted uppercase tracking-widest">ALERT TYPES</h2>
            <div className="flex flex-wrap gap-2">
              {ALL_ALERT_TYPES.map(t => (
                <button type="button" key={t}
                  onClick={() => setPrefs(pr => ({ ...pr, alertTypes: toggleArr(pr.alertTypes, t) }))}
                  className={`px-2.5 py-1 rounded-button border font-body text-xs uppercase tracking-wide transition-colors duration-100 ${
                    prefs.alertTypes.includes(t)
                      ? 'border-mint/50 bg-mint/10 text-mint'
                      : 'border-line bg-bg-soft text-muted hover:border-mint/30 hover:text-ink-2'
                  }`}>
                  {t.replace(/_/g, ' ')}
                </button>
              ))}
            </div>
          </section>

          {/* Telegram alerts */}
          <section className="rounded-card border border-line bg-surface p-5 space-y-4 shadow-card">
            <div className="flex items-center justify-between">
              <h2 className="font-body text-xs font-semibold text-muted uppercase tracking-widest">TELEGRAM ALERTS</h2>
              <button
                type="button"
                onClick={() => setPrefs(p => ({ ...p, alertsEnabled: !p.alertsEnabled }))}
                className="flex items-center gap-2 cursor-pointer"
              >
                <span className="font-body text-xs text-muted">{prefs.alertsEnabled ? 'ON' : 'OFF'}</span>
                <div className={`w-9 h-5 rounded-full transition-colors duration-100 relative ${prefs.alertsEnabled ? 'bg-mint-deep' : 'bg-bg-soft border border-line'}`}>
                  <div className={`w-3.5 h-3.5 rounded-full bg-bg absolute top-0.5 transition-transform duration-100 ${prefs.alertsEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </div>
              </button>
            </div>
            <div>
              <label className="block font-body text-xs text-ink-2 uppercase tracking-wide mb-1.5">
                TELEGRAM CHAT ID
              </label>
              <input type="text" value={telegram} onChange={e => setTelegram(e.target.value)}
                placeholder="e.g. 8844610430 (from @userinfobot)"
                className={inputClass} />
              <p className="font-body text-xs text-muted mt-1">
                Send /start to @userinfobot on Telegram to get your chat ID
              </p>
            </div>
          </section>

          <button type="submit" disabled={saving}
            className={`w-full py-2.5 rounded-button border font-body text-xs uppercase tracking-widest font-semibold transition-colors duration-100 disabled:opacity-50 ${
              saved
                ? 'border-mint-deep/40 bg-mint-tint text-mint-deep'
                : 'border-mint/40 bg-mint/10 text-mint hover:bg-mint/20'
            }`}>
            {saving ? 'SAVING…' : saved ? '✓ SAVED' : 'SAVE PREFERENCES'}
          </button>
        </form>
      </div>
    </main>
  );
}
