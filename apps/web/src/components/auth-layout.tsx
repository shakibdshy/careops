import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { CalendarCheck2, ScrollText, Users } from 'lucide-react';
import { Logo } from '#/components/logo';
import { ThemeToggle } from '#/components/theme-toggle';

/** Traveling pulse used as the brand's ambient decoration. */
export function PulseLine({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 480 80" fill="none" aria-hidden className={className}>
      <path
        d="M0 40 H140 l12-20 16 40 14-30 10 10 H250 l12-20 16 40 14-30 10 10 H480"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="120 360"
        className="animate-pulse-line"
      />
    </svg>
  );
}

const POINTS = [
  { icon: CalendarCheck2, text: 'Conflict-guarded booking in UTC' },
  { icon: Users, text: 'Role-based access for the whole team' },
  { icon: ScrollText, text: 'Append-only audit trail on every change' },
];

/** Split-panel frame for sign-in / sign-up / invitation screens. */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen">
      <div className="absolute right-4 top-4 z-10">
        <ThemeToggle />
      </div>

      <aside className="relative hidden w-[44%] flex-col justify-between overflow-hidden bg-sidebar bg-grid-faint p-10 text-sidebar-foreground lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute -left-32 -top-32 size-96 rounded-full bg-[oklch(0.6_0.11_195/0.22)] blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-40 -right-24 size-96 rounded-full bg-[oklch(0.55_0.1_160/0.16)] blur-3xl"
        />
        <Link to="/" aria-label="CareOps home" className="relative">
          <Logo
            wordmarkClassName="text-sidebar-foreground"
            accentClassName="text-[oklch(0.8_0.1_195)]"
          />
        </Link>
        <div className="relative">
          <p className="font-display text-4xl font-bold leading-[1.1] tracking-tight">
            The calm surface for clinical operations.
          </p>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-sidebar-muted">
            Patients, appointments, reports and an append-only audit trail — one UTC-native
            workspace for your whole team.
          </p>
          <ul className="mt-8 space-y-3.5">
            {POINTS.map((point) => (
              <li
                key={point.text}
                className="flex items-center gap-3 text-sm text-sidebar-foreground/90"
              >
                <span className="flex size-8 items-center justify-center rounded-lg border border-sidebar-border bg-sidebar-accent/60 text-[oklch(0.8_0.1_195)]">
                  <point.icon className="size-4" />
                </span>
                {point.text}
              </li>
            ))}
          </ul>
        </div>
        <div className="relative">
          <PulseLine className="h-12 w-full text-[oklch(0.8_0.1_195/0.5)]" />
          <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.14em] text-sidebar-muted">
            CareOps · clinical operations
          </p>
        </div>
      </aside>

      <main className="flex flex-1 items-center justify-center bg-background px-4 py-12">
        <div className="w-full max-w-sm animate-rise">
          <Link to="/" aria-label="CareOps home" className="mb-8 inline-flex lg:hidden">
            <Logo />
          </Link>
          <h1 className="font-display text-2xl font-bold tracking-tight">{title}</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
          <div className="mt-6">{children}</div>
          {footer && <div className="mt-5 text-center text-sm text-muted-foreground">{footer}</div>}
        </div>
      </main>
    </div>
  );
}
