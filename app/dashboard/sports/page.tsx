import SectionHelp from '@/app/components/SectionHelp';

export default function SportsPage() {
  return (
    <div className="max-w-[1100px] mx-auto px-4 py-6">
      <div className="mb-5">
        <h1 className="font-mono text-sm uppercase tracking-widest text-text-primary">
          SPORTS ARBITRAGE
        </h1>
        <p className="font-mono text-[10px] text-text-muted mt-0.5">
          CROSS-BOOKMAKER SUREBETS · ENGINE READY · LIVE DATA OFFLINE
        </p>
      </div>

      <SectionHelp section="sports" />

      {/* Offline notice */}
      <div className="border border-warning/30 bg-warning/5 px-4 py-4 flex flex-wrap items-start gap-x-6 gap-y-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-warning shrink-0 mt-px">
          OFFLINE
        </span>
        <div className="space-y-1">
          <p className="font-mono text-[11px] text-text-secondary leading-relaxed">
            Live odds fetching via OddsAPI is disabled. The free-tier quota is too small for
            continuous scanning. A paid OddsAPI subscription is required to activate this section.
          </p>
          <p className="font-mono text-[10px] text-text-muted/60">
            The matching engine, stake-split calculator, and margin logic are built and ready.
            No live data — no opportunities to display.
          </p>
        </div>
      </div>
    </div>
  );
}
