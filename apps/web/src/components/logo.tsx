import { cn } from '#/lib/utils';

/** CareOps mark: a clinical pulse inside a rounded tile. */
export function LogoMark({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden className={cn('size-8', className)}>
      <defs>
        <linearGradient id="careops-mark" x1="0" y1="0" x2="32" y2="32">
          <stop offset="0" stopColor="oklch(0.62 0.11 195)" />
          <stop offset="1" stopColor="oklch(0.42 0.09 215)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#careops-mark)" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" stroke="white" strokeOpacity="0.18" />
      <path
        d="M6 16.5h4.2l2-4.5 3.2 8.5 2.4-6 1.6 2h6.6"
        stroke="white"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Logo({
  className,
  markClassName,
  wordmarkClassName,
  accentClassName = 'text-primary',
}: {
  className?: string;
  markClassName?: string;
  wordmarkClassName?: string;
  accentClassName?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark className={markClassName} />
      <span className={cn('font-display text-lg font-bold tracking-tight', wordmarkClassName)}>
        Care<span className={accentClassName}>Ops</span>
      </span>
    </span>
  );
}
