import { useSyncExternalStore } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { applyTheme, getStoredTheme, subscribeTheme, type Theme } from '#/lib/theme';
import { cn } from '#/lib/utils';

const OPTIONS: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: 'system', label: 'System theme', icon: Monitor },
  { value: 'light', label: 'Light theme', icon: Sun },
  { value: 'dark', label: 'Dark theme', icon: Moon },
];

const serverTheme = () => 'system' as const;

/** Segmented system/light/dark switch. The head script applies the choice pre-paint. */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useSyncExternalStore(subscribeTheme, getStoredTheme, serverTheme);

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full border border-border bg-muted/60 p-0.5',
        className,
      )}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          data-testid={`theme-${value}`}
          onClick={() => applyTheme(value)}
          className={cn(
            'flex size-6.5 items-center justify-center rounded-full text-muted-foreground transition-all duration-200 hover:text-foreground',
            theme === value &&
              'bg-card text-primary shadow-sm ring-1 ring-border hover:text-primary',
          )}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}
