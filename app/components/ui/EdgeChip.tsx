import RadarMark from './RadarMark';

export type EdgeChipVariant =
  | 'cashable'
  | 'paper'
  | 'signal'
  | 'copy_trader'
  | 'speculative'
  | 'trap';

const LABELS: Record<EdgeChipVariant, string> = {
  cashable:    'CASHABLE',
  paper:       'PAPER',
  signal:      'SIGNAL',
  copy_trader: 'COPY TRADER',
  speculative: 'SPECULATIVE',
  trap:        'TRAP',
};

// Tailwind class pairs for each variant.
// `trap` uses inline style for the tint (#FDECEA) since there is no trap-tint key.
const CHIP_CLS: Record<EdgeChipVariant, string> = {
  cashable:    'bg-mint-tint   text-mint-deep',
  paper:       'bg-coral-tint  text-coral-ink',
  signal:      'bg-violet-tint text-violet',
  copy_trader: 'bg-violet-tint text-violet',
  speculative: 'bg-gold-tint   text-gold',
  trap:        'text-[#E5564E]',            // bg applied via inline style below
};

// Static dot color for non-cashable variants.
const DOT_CLS: Partial<Record<EdgeChipVariant, string>> = {
  paper:       'bg-coral-ink',
  signal:      'bg-violet',
  copy_trader: 'bg-violet',
  speculative: 'bg-gold',
  trap:        'bg-[#E5564E]',
};

interface EdgeChipProps {
  variant:    EdgeChipVariant;
  className?: string;
}

export default function EdgeChip({ variant, className = '' }: EdgeChipProps) {
  const isCashable = variant === 'cashable';
  const isTrap     = variant === 'trap';

  return (
    <span
      className={`
        inline-flex items-center gap-1.5
        px-2 py-[3px]
        rounded-md
        font-body font-semibold text-[9.5px] tracking-wide uppercase
        ${CHIP_CLS[variant]}
        ${className}
      `.replace(/\s+/g, ' ').trim()}
      style={isTrap ? { backgroundColor: '#FDECEA' } : undefined}
    >
      {/* Leading indicator — animated RadarMark for cashable, static dot otherwise */}
      {isCashable ? (
        <RadarMark size={10} />
      ) : (
        <span
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${DOT_CLS[variant] ?? ''}`}
          aria-hidden
        />
      )}

      {LABELS[variant]}
    </span>
  );
}
