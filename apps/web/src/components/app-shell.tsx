import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  CalendarDays,
  CalendarPlus,
  LayoutDashboard,
  LayoutGrid,
  LogOut,
  Menu,
  ScrollText,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { WorkspaceMe } from '@careops/shared';
import { Logo, LogoMark } from '#/components/logo';
import { ThemeToggle } from '#/components/theme-toggle';
import { Avatar } from '#/components/ui/avatar';
import { authClient } from '#/lib/auth-client';
import { cn } from '#/lib/utils';

export type NavKey = 'overview' | 'dashboard' | 'patients' | 'appointments' | 'audit';

const NAV: Array<{
  key: NavKey;
  to: '/workspace' | '/dashboard' | '/patients' | '/appointments' | '/audit';
  label: string;
  icon: LucideIcon;
}> = [
  { key: 'overview', to: '/workspace', label: 'Overview', icon: LayoutGrid },
  { key: 'dashboard', to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'patients', to: '/patients', label: 'Patients', icon: Users },
  { key: 'appointments', to: '/appointments', label: 'Appointments', icon: CalendarDays },
  { key: 'audit', to: '/audit', label: 'Audit log', icon: ScrollText },
];

const ROLE_LABEL: Record<WorkspaceMe['organization']['role'], string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

/** Live UTC wall clock — the whole product books in UTC, so the shell shows it. */
function UtcClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span
      title="Current UTC time"
      className="hidden items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[11px] tabular-nums text-muted-foreground sm:inline-flex"
    >
      <span className="size-1.5 animate-pulse rounded-full bg-success" />
      {now.toISOString().slice(11, 19)} UTC
    </span>
  );
}

function SidebarContent({
  me,
  active,
  onNavigate,
}: {
  me: WorkspaceMe;
  active: NavKey;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const canAudit = me.organization.role === 'owner' || me.organization.role === 'admin';
  const items = NAV.filter((item) => item.key !== 'audit' || canAudit);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-5 pb-5 pt-6">
        <Link to="/workspace" onClick={onNavigate} aria-label="CareOps overview">
          <Logo
            wordmarkClassName="text-sidebar-foreground"
            accentClassName="text-[oklch(0.8_0.1_195)]"
          />
        </Link>
      </div>

      <div className="px-4">
        <div className="flex items-center gap-3 rounded-xl border border-sidebar-border bg-sidebar-accent/50 p-3">
          <Avatar name={me.organization.name} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-sidebar-foreground">
              {me.organization.name}
            </p>
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-sidebar-muted">
              {ROLE_LABEL[me.organization.role]} workspace
            </p>
          </div>
        </div>
      </div>

      <nav className="mt-6 flex-1 space-y-1 px-4" aria-label="Primary">
        <p className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-sidebar-muted">
          Workspace
        </p>
        {items.map((item) => {
          const isActive = item.key === active;
          return (
            <Link
              key={item.key}
              to={item.to}
              onClick={onNavigate}
              aria-current={isActive ? 'page' : undefined}
              data-testid={`sidebar-${item.key}`}
              className={cn(
                'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150',
                isActive
                  ? 'bg-sidebar-accent text-sidebar-foreground shadow-sm'
                  : 'text-sidebar-muted hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
              )}
            >
              <item.icon
                className={cn(
                  'size-4.5 transition-colors',
                  isActive ? 'text-[oklch(0.8_0.1_195)]' : 'group-hover:text-sidebar-foreground',
                )}
              />
              {item.label}
              {isActive && (
                <span className="ml-auto size-1.5 rounded-full bg-[oklch(0.8_0.1_195)]" />
              )}
            </Link>
          );
        })}

        <div className="pt-4">
          <Link
            to="/appointments"
            onClick={onNavigate}
            className="flex items-center justify-center gap-2 rounded-lg bg-[oklch(0.72_0.1_195)] px-3 py-2.5 text-sm font-semibold text-[oklch(0.16_0.03_210)] shadow-sm transition-all duration-150 hover:bg-[oklch(0.78_0.1_195)] active:scale-[0.98]"
          >
            <CalendarPlus className="size-4" />
            Book appointment
          </Link>
        </div>
      </nav>

      <div className="border-t border-sidebar-border p-4">
        <div className="flex items-center gap-3">
          <Avatar name={me.user.name} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-sidebar-foreground">{me.user.name}</p>
            <p className="truncate text-xs text-sidebar-muted">{me.user.email}</p>
          </div>
          <button
            type="button"
            aria-label="Sign out"
            title="Sign out"
            onClick={() => {
              void authClient.signOut().then(() => navigate({ to: '/login' }));
            }}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Authenticated application frame: deep-pine sidebar (desktop), slide-over nav
 * (mobile), and a sticky topbar with the live UTC clock and theme switch.
 */
export function AppShell({
  me,
  active,
  children,
}: {
  me: WorkspaceMe;
  active: NavKey;
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const activeLabel = NAV.find((item) => item.key === active)?.label ?? '';

  useEffect(() => {
    if (!mobileOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setMobileOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-sidebar-border bg-sidebar bg-grid-faint lg:block">
        <SidebarContent me={me} active={active} />
      </aside>

      {mobileOpen && (
        <div
          className="fixed inset-0 z-50 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
        >
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-[2px] animate-in fade-in duration-200"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-sidebar bg-grid-faint shadow-pop animate-in slide-in-from-left duration-200">
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setMobileOpen(false)}
              className="absolute right-3 top-6 flex size-8 items-center justify-center rounded-md text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <X className="size-4" />
            </button>
            <SidebarContent me={me} active={active} onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur-md">
          <div className="flex h-14 items-center gap-3 px-4 lg:px-8">
            <button
              type="button"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
              className="flex size-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground shadow-xs transition-colors hover:text-foreground lg:hidden"
            >
              <Menu className="size-4.5" />
            </button>
            <Link to="/workspace" className="lg:hidden" aria-label="CareOps overview">
              <LogoMark className="size-7" />
            </Link>
            <nav
              aria-label="Breadcrumb"
              className="hidden min-w-0 items-center gap-2 text-sm lg:flex"
            >
              <span className="truncate text-muted-foreground">{me.organization.name}</span>
              <span className="text-muted-foreground/50">/</span>
              <span className="truncate font-medium">{activeLabel}</span>
            </nav>
            <div className="ml-auto flex items-center gap-2.5">
              <UtcClock />
              <ThemeToggle />
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl px-4 py-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
