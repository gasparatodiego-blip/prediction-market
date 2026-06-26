'use client';

import { useEffect, useState } from 'react';

export default function FooterStatus() {
  const [tradersStatus, setTradersStatus] = useState<'live' | 'offline' | 'loading'>('loading');

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/ticker?_=${Date.now()}`);
        if (!res.ok) { setTradersStatus('offline'); return; }
        const data = await res.json();
        const traders = (data.categories ?? []).find((c: { key: string }) => c.key === 'traders');
        setTradersStatus(traders?.status === 'live' ? 'live' : 'offline');
      } catch {
        setTradersStatus('offline');
      }
    }
    load();
  }, []);

  const tradersLabel =
    tradersStatus === 'loading' ? 'TRADERS HUB CHECKING' :
    tradersStatus === 'live'    ? 'TRADERS HUB LIVE'     :
                                  'TRADERS HUB OFFLINE';

  const dotCls =
    tradersStatus === 'live'    ? 'bg-mint-deep' :
    tradersStatus === 'offline' ? 'bg-gold'      :
                                  'bg-muted/30';

  return (
    <div className="flex items-center gap-2">
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotCls} shrink-0`} />
      <span className="font-body text-[10px] uppercase tracking-[0.12em] text-muted">
        CORE SYSTEMS OPERATIONAL · {tradersLabel}
      </span>
    </div>
  );
}
