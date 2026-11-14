import { useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  createInvitationSchema,
  organizationCurrentSchema,
  type WorkspaceMe,
} from '@careops/shared';
import {
  ArrowUpRight,
  CalendarDays,
  CircleAlert,
  CircleCheck,
  LayoutDashboard,
  LogOut,
  ScrollText,
  Send,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { AppShell } from '#/components/app-shell';
import { PageHeader } from '#/components/page-header';
import { PageLoading } from '#/components/page-loading';
import { Alert, AlertDescription } from '#/components/ui/alert';
import { Avatar } from '#/components/ui/avatar';
import { Badge } from '#/components/ui/badge';
import { Button } from '#/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card';
import { Input } from '#/components/ui/input';
import { Label } from '#/components/ui/label';
import { apiGet } from '#/lib/api';
import { authClient } from '#/lib/auth-client';
import { useWorkspace } from '#/lib/use-workspace';

export const Route = createFileRoute('/workspace')({ component: Workspace });

const ROLE_VARIANT: Record<string, 'default' | 'info' | 'secondary'> = {
  owner: 'default',
  admin: 'info',
  member: 'secondary',
};

function Workspace() {
  const me = useWorkspace('/workspace');
  if (!me) {
    return <PageLoading />;
  }
  return <WorkspaceOverview me={me} />;
}

function WorkspaceOverview({ me }: { me: WorkspaceMe }) {
  const navigate = useNavigate();
  const canManage = me.organization.role === 'owner' || me.organization.role === 'admin';
  const orgQuery = useQuery({
    queryKey: ['organizations', 'current'],
    queryFn: () => apiGet('/api/organizations/current', organizationCurrentSchema),
  });
  const org = orgQuery.data;

  const shortcuts: Array<{
    to: '/dashboard' | '/patients' | '/appointments' | '/audit';
    testId: string;
    label: string;
    description: string;
    icon: LucideIcon;
  }> = [
    {
      to: '/dashboard',
      testId: 'nav-dashboard',
      label: 'Dashboard',
      description: 'Volume, status mix and provider utilization.',
      icon: LayoutDashboard,
    },
    {
      to: '/patients',
      testId: 'nav-patients',
      label: 'Patients',
      description: 'Records, contacts and birth dates.',
      icon: Users,
    },
    {
      to: '/appointments',
      testId: 'nav-appointments',
      label: 'Appointments',
      description: 'Book, confirm, reschedule in UTC.',
      icon: CalendarDays,
    },
    ...(canManage
      ? [
          {
            to: '/audit' as const,
            testId: 'nav-audit',
            label: 'Audit log',
            description: 'Append-only trail of every change.',
            icon: ScrollText,
          },
        ]
      : []),
  ];

  return (
    <AppShell me={me} active="overview">
      <PageHeader
        eyebrow={me.organization.name}
        title={`Welcome back, ${me.user.name.split(' ')[0]}`}
        description="Your clinic at a glance — jump into records, bookings, reports or the audit trail."
      />

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {shortcuts.map((shortcut, index) => (
          <Link
            key={shortcut.to}
            to={shortcut.to}
            data-testid={shortcut.testId}
            className="group rounded-xl border border-border/80 bg-card p-5 shadow-card transition-all duration-200 hover:-translate-y-1 hover:border-ring/30 hover:shadow-pop animate-rise"
            style={{ animationDelay: `${index * 60}ms` }}
          >
            <div className="flex items-start justify-between">
              <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                <shortcut.icon className="size-5" />
              </span>
              <ArrowUpRight className="size-4 text-muted-foreground/50 transition-all duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-primary" />
            </div>
            <p className="mt-4 font-display text-base font-semibold">{shortcut.label}</p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {shortcut.description}
            </p>
          </Link>
        ))}
      </div>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <Card className="animate-rise" style={{ animationDelay: '120ms' }}>
          <CardHeader>
            <CardTitle data-testid="org-name">{me.organization.name}</CardTitle>
            <CardDescription>
              {org
                ? `${org.members.length} ${org.members.length === 1 ? 'member' : 'members'} · `
                : ''}
              Role-based access — owners and admins manage records and invitations.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {org && (
              <ul className="divide-y divide-border/70" data-testid="org-members">
                {org.members.map((member) => (
                  <li key={member.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                    <Avatar name={member.name} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{member.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                    </div>
                    <Badge
                      variant={ROLE_VARIANT[member.role] ?? 'secondary'}
                      className="capitalize"
                    >
                      {member.role}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            {canManage && org && <InviteForm />}
          </CardContent>
        </Card>

        <Card className="animate-rise" style={{ animationDelay: '180ms' }}>
          <CardHeader>
            <CardTitle>Your account</CardTitle>
            <CardDescription>Signed in to this workspace.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4">
            <div className="flex items-center gap-3">
              <Avatar name={me.user.name} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{me.user.name}</p>
                <p className="truncate text-xs text-muted-foreground" data-testid="workspace-user">
                  Signed in as {me.user.name} ({me.user.email})
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              className="w-full"
              data-testid="sign-out"
              onClick={() => {
                void authClient.signOut().then(() => navigate({ to: '/login' }));
              }}
            >
              <LogOut className="size-4" /> Sign out
            </Button>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function InviteForm() {
  const [email, setEmail] = useState('');
  const [inviteError, setInviteError] = useState<string | undefined>();
  const [invited, setInvited] = useState(false);
  const [pending, setPending] = useState(false);

  async function onInvite(e: React.FormEvent) {
    e.preventDefault();
    const parsed = createInvitationSchema.safeParse({ email, role: 'member' });
    if (!parsed.success) {
      setInviteError('Enter a valid email');
      return;
    }
    setPending(true);
    const res = await fetch('/api/organizations/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.data),
    });
    setPending(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as { message?: string } | undefined;
      setInviteError(body?.message ?? 'Could not send the invitation');
      return;
    }
    setInviteError(undefined);
    setInvited(true);
    setEmail('');
  }

  return (
    <form
      onSubmit={(e) => {
        void onInvite(e);
      }}
      className="mt-5 grid gap-2 border-t border-border/70 pt-5"
    >
      <Label htmlFor="invite-email">Invite a teammate</Label>
      <div className="flex gap-2">
        <Input
          id="invite-email"
          type="email"
          placeholder="teammate@clinic.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setInvited(false);
          }}
        />
        <Button type="submit" disabled={pending} className="shrink-0">
          <Send className="size-4" /> Invite
        </Button>
      </div>
      {inviteError && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{inviteError}</AlertDescription>
        </Alert>
      )}
      {invited && (
        <Alert variant="success">
          <CircleCheck />
          <AlertDescription>Invitation sent.</AlertDescription>
        </Alert>
      )}
    </form>
  );
}
