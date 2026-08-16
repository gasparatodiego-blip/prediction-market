"use client";
import { useEffect, useState } from "react";

interface ScanData {
  timestamp: string;
  kalshi_markets: number;
  polymarket_markets: number;
  arbitrages_found: number;
  opportunities: any[];
}

export default function LiveOpportunities() {
  const [data, setData] = useState<ScanData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = () => {
      fetch("/latest-opportunities.json?" + Date.now())
        .then((res) => res.json())
        .then((json) => {
          setData(json);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    };
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="bg-surface border border-line rounded-card p-4">
        <div className="animate-pulse">
          <div className="h-4 bg-bg-soft rounded w-3/4 mb-2"></div>
          <div className="h-3 bg-bg-soft rounded w-1/2"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-surface border border-line rounded-card p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="font-body text-[10px] uppercase tracking-wider text-mint">
          LIVE OPPORTUNITIES
        </span>
        <span className="font-mono text-[10px] text-muted">
          {data?.timestamp ? new Date(data.timestamp).toLocaleTimeString() : "--:--:--"}
        </span>
      </div>

      {data?.arbitrages_found && data.arbitrages_found > 0 ? (
        <div className="space-y-2">
          <div className="text-mint-deep font-body font-semibold text-sm">
            {data.arbitrages_found} opportunità trovate!
          </div>
          {data.opportunities.slice(0, 3).map((opp, i) => (
            <div key={i} className="text-xs text-ink-2 border-l-2 border-mint-deep pl-2">
              {opp.market || opp.question}
            </div>
          ))}
        </div>
      ) : (
        <div>
          <div className="text-ink font-body text-sm">
            {data?.kalshi_markets || 0} Kalshi · {data?.polymarket_markets || 0} Polymarket
          </div>
          <div className="text-muted font-body text-xs mt-1">
            ✅ Nessun arbitraggio cashable al momento
          </div>
          <div className="text-muted font-body text-[10px] mt-2">
            Ultima scansione: {data?.timestamp ? new Date(data.timestamp).toLocaleString() : "--"}
          </div>
        </div>
      )}
    </div>
  );
}
