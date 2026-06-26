/**
 * Temporary Edgeradar UI primitive preview.
 * Delete this route before launch.
 *
 * Note: placed at app/preview/ (not app/_preview/) because Next.js App Router
 * treats underscore-prefixed folders as private and excludes them from routing.
 */

import Button       from '@/app/components/ui/Button';
import Pill         from '@/app/components/ui/Pill';
import Eyebrow      from '@/app/components/ui/Eyebrow';
import SectionHeading from '@/app/components/ui/SectionHeading';
import EdgeChip     from '@/app/components/ui/EdgeChip';
import RadarMark    from '@/app/components/ui/RadarMark';
import RadarScope   from '@/app/components/ui/RadarScope';
import BlipRow      from '@/app/components/ui/BlipRow';
import StatCard     from '@/app/components/ui/StatCard';

export const metadata = { title: 'UI Preview | Edgeradar' };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <p className="font-body text-[10px] uppercase tracking-widest text-muted border-b border-line pb-2">
        {title}
      </p>
      {children}
    </section>
  );
}

export default function PreviewPage() {
  return (
    <div className="min-h-screen bg-bg">
      <div className="max-w-[760px] mx-auto px-8 py-12 space-y-12">

        {/* Page header */}
        <div>
          <Eyebrow className="mb-2">Edgeradar · Design System</Eyebrow>
          <SectionHeading as="h1" className="text-3xl">
            UI Primitive Preview
          </SectionHeading>
          <p className="font-body text-muted mt-2">
            Component showcase — not a production route.
          </p>
        </div>

        {/* ── Typography ──────────────────────────────────────────────────────── */}
        <Section title="Typography">
          <Eyebrow>Live Opportunities · 3 cashable</Eyebrow>
          <SectionHeading>Find the edge before the market corrects</SectionHeading>
          <SectionHeading centered as="h3" className="text-xl text-muted">
            Centered h3 variant
          </SectionHeading>
        </Section>

        {/* ── Pill ────────────────────────────────────────────────────────────── */}
        <Section title="Pill">
          <div className="flex gap-3 flex-wrap items-center">
            <Pill>3 live arbs</Pill>
            <Pill>Updated 2 min ago</Pill>
            <Pill>Net of fees</Pill>
          </div>
        </Section>

        {/* ── Button ──────────────────────────────────────────────────────────── */}
        <Section title="Button">
          <div className="flex gap-3 flex-wrap items-center">
            <Button variant="primary" size="md">View opportunities</Button>
            <Button variant="primary" size="lg">Get started</Button>
            <Button variant="ghost"   size="md">Learn more</Button>
            <Button variant="ghost"   size="lg">Dismiss</Button>
          </div>
        </Section>

        {/* ── EdgeChip — all 5 variants ───────────────────────────────────────── */}
        <Section title="EdgeChip · all variants">
          <div className="flex gap-3 flex-wrap items-center">
            <EdgeChip variant="cashable"    />
            <EdgeChip variant="paper"       />
            <EdgeChip variant="signal"      />
            <EdgeChip variant="speculative" />
            <EdgeChip variant="trap"        />
          </div>
          <p className="font-body text-[12px] text-muted">
            Cashable shows the animated RadarMark; others show a static dot.
          </p>
        </Section>

        {/* ── RadarMark — multiple sizes ──────────────────────────────────────── */}
        <Section title="RadarMark · sizes 12 / 18 / 28 / 40px">
          <div className="flex items-center gap-6">
            <div className="flex flex-col items-center gap-1">
              <RadarMark size={12} />
              <span className="font-mono text-[9px] text-muted">12</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <RadarMark size={18} />
              <span className="font-mono text-[9px] text-muted">18</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <RadarMark size={28} />
              <span className="font-mono text-[9px] text-muted">28</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <RadarMark size={40} />
              <span className="font-mono text-[9px] text-muted">40</span>
            </div>
          </div>
        </Section>

        {/* ── RadarScope ──────────────────────────────────────────────────────── */}
        <Section title="RadarScope · 150px · 3 blips (mint / violet / gold)">
          <div className="flex gap-8 flex-wrap items-start">
            <RadarScope
              size={150}
              blips={[
                { top: '28%', left: '62%', color: 'mint'   },
                { top: '67%', left: '33%', color: 'violet' },
                { top: '42%', left: '74%', color: 'gold'   },
              ]}
            />
            <RadarScope size={80} />
          </div>
        </Section>

        {/* ── BlipRow ─────────────────────────────────────────────────────────── */}
        <Section title="BlipRow · 2 rows">
          <div className="bg-surface rounded-card shadow-card divide-y divide-line overflow-hidden">
            <BlipRow
              icon="⚡"
              tileColor="mint"
              name="BTC / ETH Funding Spread"
              sub="Binance short · Hyperliquid long · 8h reset"
              chip="cashable"
              value="+$42"
              unit="/day · net of fees"
              valueTone="up"
            />
            <BlipRow
              icon="🔭"
              tileColor="violet"
              name="US Election 2026 — Senate"
              sub="Polymarket × Kalshi · confidence 71%"
              chip="signal"
              value="4.2%"
              unit="spread · legs unconfirmed"
            />
          </div>
        </Section>

        {/* ── StatCard ────────────────────────────────────────────────────────── */}
        <Section title="StatCard · honest-engine snapshot">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <StatCard
              label="Best net $/day"
              value="+$42/day"
              note="BTC funding · Binance × Hyperliquid"
              demoted="≈18.6%/yr · run-rate, not guaranteed"
            />
            <StatCard
              label="Cashable arbs"
              value="3"
              note="Both legs verified · fees deducted"
              demoted="Updated 2 min ago · repriced live"
            />
          </div>
        </Section>

      </div>
    </div>
  );
}
