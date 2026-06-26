import type { ReactNode } from 'react';

type HeadingTag = 'h1' | 'h2' | 'h3';

interface SectionHeadingProps {
  children:  ReactNode;
  centered?: boolean;
  as?:       HeadingTag;
  className?: string;
}

export default function SectionHeading({
  children,
  centered,
  as: Tag   = 'h2',
  className = '',
}: SectionHeadingProps) {
  return (
    <Tag
      className={`font-display font-bold tracking-tight text-ink ${centered ? 'text-center' : ''} ${className}`}
    >
      {children}
    </Tag>
  );
}
