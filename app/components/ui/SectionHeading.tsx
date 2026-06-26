import type { HTMLAttributes, ReactNode } from 'react';

type HeadingTag = 'h1' | 'h2' | 'h3';

interface SectionHeadingProps extends HTMLAttributes<HTMLHeadingElement> {
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
  ...rest
}: SectionHeadingProps) {
  return (
    <Tag
      {...rest}
      className={`font-display font-bold tracking-tight text-ink ${centered ? 'text-center' : ''} ${className}`}
    >
      {children}
    </Tag>
  );
}
