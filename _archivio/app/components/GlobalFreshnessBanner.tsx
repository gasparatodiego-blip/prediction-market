'use client';

// GlobalFreshnessBanner — rules 48/62: when the WHOLE pipeline is stale (the freshest
// core feed is older than the freshness threshold), show ONE calm, global "Data may be
// stale" banner so nothing on the page reads as freshly-true when it isn't. It is
// display-only: it never blocks or hides the content below — the tabs still render their
// last-good data (calm degradation), the banner just tells the user it may be old.
//
// Polls the read-only /api/health guardian report (which computes the banner). Fails
// silent: if health can't be read, no banner (never a false alarm, never a crash).

import { useEffect, useState } from 'react';

interface GuardianHealth { banner: string | null; pipeline?: { ageMin: number | null } }

export default function GlobalFreshnessBanner() {
  const [banner, setBanner] = useState<string | null>(null);
  const [ageMin, setAgeMin] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const g: GuardianHealth | null = data?.guardian ?? null;
        if (!alive) return;
        setBanner(g?.banner ?? null);
        setAgeMin(g?.pipeline?.ageMin ?? null);
      } catch { /* fail silent — no banner beats a false one */ }
    };
    check();
    const id = setInterval(check, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!banner) return null;

  return (
    <div
      className="w-full text-center font-body"
      style={{ background: '#fdf6ec', borderBottom: '1px solid rgba(180,83,9,0.25)', color: '#b45309', fontSize: 12, padding: '6px 12px' }}
      role="status"
    >
      {banner} — some sections may show values older than usual
      {ageMin != null ? ` (updated ${ageMin} min ago)` : ''}.
    </div>
  );
}
