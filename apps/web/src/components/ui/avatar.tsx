import { cn } from '#/lib/utils';

const SIZES = {
  sm: 'size-7 text-[10px]',
  default: 'size-9 text-xs',
  lg: 'size-12 text-sm',
  xl: 'size-16 text-lg',
} as const;

function hueOf(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  return hash;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]![0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

/** Initials avatar with a stable per-person hue drawn from the palette space. */
export function Avatar({
  name,
  size = 'default',
  className,
}: {
  name: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      style={{ '--avatar-hue': hueOf(name) } as React.CSSProperties}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-display font-semibold ring-1 ring-inset ring-black/5 dark:ring-white/10',
        'bg-[oklch(0.93_0.045_var(--avatar-hue))] text-[oklch(0.42_0.09_var(--avatar-hue))]',
        'dark:bg-[oklch(0.33_0.05_var(--avatar-hue))] dark:text-[oklch(0.86_0.06_var(--avatar-hue))]',
        SIZES[size],
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
