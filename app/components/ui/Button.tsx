import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'ghost';
export type ButtonSize    = 'md' | 'lg';

const BASE =
  'inline-flex items-center justify-center font-body font-medium rounded-button ' +
  'transition-colors duration-150 active:translate-y-[1px] ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/50 ' +
  'select-none disabled:pointer-events-none disabled:opacity-50';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-mint-deep text-white shadow-card hover:bg-mint',
  ghost:   'border border-line text-ink-2 hover:border-mint hover:text-mint-deep',
};

const SIZES: Record<ButtonSize, string> = {
  md: 'px-4 py-2 text-sm gap-1.5',
  lg: 'px-6 py-3 text-base gap-2',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export default function Button({
  variant  = 'primary',
  size     = 'md',
  className = '',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={`${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
    >
      {children}
    </button>
  );
}
