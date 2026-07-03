interface ToggleProps {
  checked:    boolean;
  onChange:   (next: boolean) => void;
  disabled?:  boolean;
  dot?:       'mint' | 'violet';
  label:      string;
  className?: string;
}

const DOT_ON: Record<'mint' | 'violet', string> = {
  mint:   'bg-mint',
  violet: 'bg-violet',
};

export default function Toggle({ checked, onChange, disabled = false, dot = 'mint', label, className = '' }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`
        relative inline-flex items-center h-5 w-9 rounded-pill shrink-0
        transition-colors duration-150
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/50
        disabled:cursor-not-allowed
        ${checked ? DOT_ON[dot] : 'bg-line'}
        ${disabled ? 'opacity-50' : ''}
        ${className}
      `.replace(/\s+/g, ' ').trim()}
    >
      <span
        className={`
          inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm
          transition-transform duration-150
          ${checked ? 'translate-x-[18px]' : 'translate-x-[3px]'}
        `.replace(/\s+/g, ' ').trim()}
      />
    </button>
  );
}
