import { useEffect, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { healthResponseSchema, type HealthResponse } from '@careops/shared';
import { ArrowRight, CalendarCheck2, ChartLine, ScrollText, Users } from 'lucide-react';
import { PulseLine } from '#/components/auth-layout';
import { Logo } from '#/components/logo';
import { ThemeToggle } from '#/components/theme-toggle';
import { Button } from '#/components/ui/button';
import { cn } from '#/lib/utils';

export const Route = createFileRoute('/')({ component: Home });

type HealthState =
  | { kind: 'checking' }
  | { kind: 'ready'; response: HealthResponse }
  | { kind: 'error'; message: string };

const FEATURES = [
  {
    icon: Users,
    title: 'Patient records',
    body: 'One chart per person — names, birth date, contact details and notes, scoped to your organization.',
  },
  {
    icon: CalendarCheck2,
    title: 'Conflict-guarded booking',
    body: 'Book providers in UTC with overlap rejection, legal status transitions and one-click rescheduling.',
  },
  {
    icon: ChartLine,
    title: 'Live operational reports',
    body: 'Daily volume, status breakdown and provider utilization over a trailing 30-day window.',
  },
  {
    icon: ScrollText,
    title: 'Append-only audit trail',
    body: 'Every create, update and delete is recorded with before/after state — nothing is ever rewritten.',
  },
];

function HealthBadge({ response }: { response: HealthResponse }) {
  const healthy = response.status === 'ok';
  const stores = `${response.mongo === 'up' ? 'mongo up' : 'mongo down'} · ${response.redis === 'up' ? 'redis up' : 'redis down'}`;
  return (
    <span
      data-testid="health-badge"
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[11px]',
        healthy
          ? 'border-success/25 bg-success/10 text-success'
          : 'border-warning/30 bg-warning/10 text-warning',
      )}
    >
      <span className={cn('size-1.5 rounded-full', healthy ? 'bg-success' : 'bg-warning')} />
      API {healthy ? 'healthy' : 'degraded'}: {response.service} ({stores})
    </span>
  );
}

function Home() {
  const [health, setHealth] = useState<HealthState>({ kind: 'checking' });

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json() as unknown)
      .then((body) => {
        const parsed = healthResponseSchema.safeParse(body);
        if (parsed.success) {
          setHealth({ kind: 'ready', response: parsed.data });
        } else {
          setHealth({ kind: 'error', message: 'API response failed contract validation' });
        }
      })
      .catch(() => setHealth({ kind: 'error', message: 'API unreachable' }));
  }, []);

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-dots-faint opacity-60 [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full bg-primary/12 blur-3xl"
      />

      <header className="relative mx-auto flex max-w-6xl items-center justify-between px-4 py-5 lg:px-8">
        <Link to="/" aria-label="CareOps home">
          <Logo />
        </Link>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <Button asChild variant="ghost" size="sm">
            <Link to="/login">Sign in</Link>
          </Button>
          <Button asChild size="sm">
            <Link to="/signup">
              Get started <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        </div>
      </header>

      <main className="relative mx-auto max-w-6xl px-4 lg:px-8">
        <section className="pb-16 pt-14 text-center lg:pb-20 lg:pt-20">
          <div className="animate-rise">
            {health.kind === 'checking' && (
              <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 font-mono text-[11px] text-muted-foreground">
                <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
                Checking API…
              </span>
            )}
            {health.kind === 'ready' && <HealthBadge response={health.response} />}
            {health.kind === 'error' && (
              <span
                data-testid="health-error"
                className="inline-flex items-center gap-2 rounded-full border border-destructive/25 bg-destructive/10 px-3 py-1 font-mono text-[11px] text-destructive"
              >
                <span className="size-1.5 rounded-full bg-destructive" />
                API error: {health.message}
              </span>
            )}
          </div>

          <h1
            className="mx-auto mt-6 max-w-3xl font-display text-4xl font-bold leading-[1.05] tracking-tight animate-rise sm:text-5xl lg:text-6xl"
            style={{ animationDelay: '60ms' }}
          >
            Run your clinic on
            <span className="relative whitespace-nowrap text-primary">
              {' '}
              one calm surface
              <svg
                viewBox="0 0 220 10"
                aria-hidden
                className="absolute -bottom-1 left-0 w-full text-primary/40"
              >
                <path
                  d="M2 7 Q 110 -2 218 6"
                  stroke="currentColor"
                  strokeWidth="3"
                  fill="none"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            .
          </h1>
          <p
            className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-muted-foreground animate-rise lg:text-lg"
            style={{ animationDelay: '120ms' }}
          >
            CareOps unifies patient records, UTC-native scheduling, live reports and an append-only
            audit trail — so your team spends time on care, not coordination.
          </p>
          <div
            className="mt-8 flex flex-wrap items-center justify-center gap-3 animate-rise"
            style={{ animationDelay: '180ms' }}
          >
            <Button asChild size="lg">
              <Link to="/signup">
                Create a workspace <ArrowRight />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/login">Sign in</Link>
            </Button>
          </div>

          <PulseLine className="mx-auto mt-12 h-14 w-full max-w-2xl text-primary/45 animate-rise" />
        </section>

        <section className="grid gap-4 pb-16 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((feature, index) => (
            <article
              key={feature.title}
              className="group rounded-xl border border-border/80 bg-card p-5 shadow-card transition-all duration-200 hover:-translate-y-1 hover:shadow-pop animate-rise"
              style={{ animationDelay: `${240 + index * 70}ms` }}
            >
              <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                <feature.icon className="size-5" />
              </span>
              <h2 className="mt-4 font-display text-base font-semibold">{feature.title}</h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                {feature.body}
              </p>
            </article>
          ))}
        </section>
      </main>

      <footer className="relative border-t border-border/70">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-5 text-xs text-muted-foreground lg:px-8">
          <p className="font-mono uppercase tracking-[0.14em]">
            UTC-native · RBAC · Append-only audit
          </p>
          <nav className="flex items-center gap-4">
            <Link to="/workspace" className="transition-colors hover:text-foreground">
              Workspace
            </Link>
            <Link to="/patients" className="transition-colors hover:text-foreground">
              Patients
            </Link>
            <Link to="/appointments" className="transition-colors hover:text-foreground">
              Appointments
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
