import type { LucideIcon } from 'lucide-react';
import { Card } from '#/components/ui/card';
import { cn } from '#/lib/utils';

const TONES = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/12 text-warning',
  info: 'bg-info/10 text-info',
  destructive: 'bg-destructive/10 text-destructive',
} as const;

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'primary',
  className,
  style,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
  tone?: keyof typeof TONES;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <Card className={cn('flex items-center gap-4 p-4 lg:p-5', className)} style={style}>
      <span
        className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl', TONES[tone])}
      >
        <Icon className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {label}
        </span>
        <span className="mt-0.5 block font-display text-2xl font-bold tabular-nums leading-tight">
          {value}
        </span>
        {hint && <span className="block truncate text-xs text-muted-foreground">{hint}</span>}
      </span>
    </Card>
  );
}
