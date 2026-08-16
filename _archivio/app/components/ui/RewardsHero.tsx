import RadarScope from './RadarScope';
import PlatformLogo from '@/components/PlatformLogo';

// RewardsHero — a lightweight header motif for the Liquidity Rewards section,
// consistent with the Edgeradar radar aesthetic (reuses RadarScope). Pure CSS/SVG,
// no heavy images. Blips sit inside the reward band to hint "makers resting near mid".
export default function RewardsHero() {
  return (
    <div className="relative overflow-hidden rounded-card shadow-card bg-surface">
      {/* soft mint field */}
      <div
        className="absolute inset-0"
        style={{ background: 'radial-gradient(120% 140% at 85% -20%, rgba(15,190,130,.10), transparent 55%)' }}
        aria-hidden
      />
      <div className="relative flex items-center justify-between gap-4 px-5 py-5 sm:px-6 sm:py-6">
        <div className="min-w-0">
          <p className="font-body text-[11px] uppercase tracking-[0.18em] text-mint-deep/80">Edgeradar · Liquidity Rewards</p>
          <p className="font-display font-bold text-ink leading-tight mt-1 text-lg sm:text-2xl">
            Earn from the spread you rest, not the bet you make
          </p>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span className="inline-flex items-center gap-1.5 font-body text-[11px] text-ink-2 bg-bg-soft border border-line rounded-pill px-2.5 py-1">
              <PlatformLogo platform="polymarket" size={13} /> Polymarket
            </span>
            <span className="inline-flex items-center gap-1.5 font-body text-[11px] text-ink-2 bg-bg-soft border border-line rounded-pill px-2.5 py-1">
              <PlatformLogo platform="kalshi" size={13} /> Kalshi
            </span>
            <span className="font-body text-[11px] text-muted">net $/day · adverse-fill aware · advisory only</span>
          </div>
        </div>
        <div className="hidden sm:block shrink-0">
          <RadarScope
            size={104}
            blips={[
              { top: '42%', left: '58%', color: 'mint' },
              { top: '60%', left: '44%', color: 'gold' },
              { top: '38%', left: '39%', color: 'mint' },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
