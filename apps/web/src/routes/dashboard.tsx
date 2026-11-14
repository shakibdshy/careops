import { useMemo, type ReactNode } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Chart } from '@tanstack/react-charts';
import { barX, defineChart, lineY } from '@tanstack/charts';
import { scaleBand } from '@tanstack/charts/scales/band';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { scaleUtc } from '@tanstack/charts/scales/time';
import {
  dailyVolumeSchema,
  organizationCurrentSchema,
  patientsPageSchema,
  providerUtilizationReportSchema,
  statusBreakdownSchema,
  todayScheduleSchema,
  type OrganizationMember,
  type Patient,
  type WorkspaceMe,
} from '@careops/shared';
import {
  BarChart3,
  CalendarDays,
  CalendarX2,
  CircleAlert,
  Gauge,
  LayoutDashboard,
  TrendingUp,
  UserX,
  Users,
} from 'lucide-react';
import { AppShell } from '#/components/app-shell';
import { PageHeader } from '#/components/page-header';
import { PageLoading } from '#/components/page-loading';
import { Alert, AlertDescription } from '#/components/ui/alert';
import { Badge } from '#/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card';
import { Skeleton } from '#/components/ui/skeleton';
import { StatCard } from '#/components/ui/stat-card';
import { apiGet } from '#/lib/api';
import { STATUS_META } from '#/lib/appointment-status';
import { useWorkspace } from '#/lib/use-workspace';
import { cn } from '#/lib/utils';

export const Route = createFileRoute('/dashboard')({ component: DashboardPage });

const EMPTY_MEMBERS: OrganizationMember[] = [];
const EMPTY_PATIENTS: Patient[] = [];

const REPORT_DAYS = 30;

/**
 * Chart colors resolve from the design tokens at paint time, so a single
 * definition adapts to light/dark (the OS-driven `dark:` variant) without
 * re-rendering. `currentColor`-style keywords pass straight through to SVG.
 */
const CHART_THEME = {
  foreground: 'var(--muted-foreground)',
  muted: 'var(--muted-foreground)',
  grid: 'var(--border)',
  background: 'transparent',
  palette: [
    'var(--chart-1)',
    'var(--chart-2)',
    'var(--chart-3)',
    'var(--chart-4)',
    'var(--chart-5)',
  ],
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(11, 16);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function DashboardPage() {
  const me = useWorkspace('/dashboard');
  if (!me) {
    return <PageLoading />;
  }
  // Mounted only after the client-side auth check, so report reads and chart
  // definitions never run during SSR.
  return <DashboardWorkspace me={me} />;
}

function DashboardWorkspace({ me }: { me: WorkspaceMe }) {
  const volumeQuery = useQuery({
    queryKey: ['reports', 'daily-volume', REPORT_DAYS],
    queryFn: () => apiGet(`/api/reports/daily-volume?days=${REPORT_DAYS}`, dailyVolumeSchema),
  });
  const breakdownQuery = useQuery({
    queryKey: ['reports', 'status-breakdown', REPORT_DAYS],
    queryFn: () =>
      apiGet(`/api/reports/status-breakdown?days=${REPORT_DAYS}`, statusBreakdownSchema),
  });
  const utilizationQuery = useQuery({
    queryKey: ['reports', 'provider-utilization', REPORT_DAYS],
    queryFn: () =>
      apiGet(
        `/api/reports/provider-utilization?days=${REPORT_DAYS}`,
        providerUtilizationReportSchema,
      ),
  });
  const todayQuery = useQuery({
    queryKey: ['reports', 'today'],
    queryFn: () => apiGet('/api/reports/today', todayScheduleSchema),
  });
  const providersQuery = useQuery({
    queryKey: ['organizations', 'current'],
    queryFn: () => apiGet('/api/organizations/current', organizationCurrentSchema),
  });
  const patientsQuery = useQuery({
    queryKey: ['patients', 'picker'],
    queryFn: () => apiGet('/api/patients?limit=100', patientsPageSchema),
  });

  const members = providersQuery.data?.members ?? EMPTY_MEMBERS;
  const patients = patientsQuery.data?.items ?? EMPTY_PATIENTS;
  const membersById = new Map(members.map((member) => [member.id, member]));
  const patientsById = new Map(patients.map((patient) => [patient.id, patient]));
  const patientName = (id: string) => {
    const patient = patientsById.get(id);
    return patient ? `${patient.firstName} ${patient.lastName}` : `Patient ${id.slice(0, 8)}`;
  };
  const providerName = (id: string) => membersById.get(id)?.name ?? `Provider ${id.slice(0, 8)}`;

  const volumeDefinition = useMemo(() => {
    const points = volumeQuery.data?.points ?? [];
    return defineChart({
      marks: [
        lineY(points, {
          x: (point) => new Date(point.date),
          y: 'count',
          stroke: 'var(--chart-1)',
          strokeWidth: 2,
          points: true,
        }),
      ],
      scales: {
        x: { scale: scaleUtc },
        y: { scale: scaleLinear, nice: true, grid: true },
      },
      theme: CHART_THEME,
    });
  }, [volumeQuery.data]);

  const statusDefinition = useMemo(() => {
    const data = (breakdownQuery.data?.counts ?? []).map((row) => ({
      label: STATUS_META[row.status].label,
      count: row.count,
      chart: STATUS_META[row.status].chart,
    }));
    return defineChart({
      marks: [
        barX(data, {
          x: 'count',
          y: 'label',
          fill: (datum) => datum.chart,
          inset: 2,
          maxThickness: 26,
        }),
      ],
      scales: {
        x: { scale: scaleLinear, nice: true, grid: true },
        y: { scale: scaleBand },
      },
      theme: CHART_THEME,
    });
  }, [breakdownQuery.data]);

  const utilizationDefinition = useMemo(() => {
    const data = (utilizationQuery.data?.providers ?? []).map((provider) => ({
      label: provider.providerName,
      percent: Math.round(provider.utilization * 100),
    }));
    return defineChart({
      marks: [
        barX(data, {
          x: 'percent',
          y: 'label',
          fill: 'var(--chart-2)',
          inset: 2,
          maxThickness: 26,
        }),
      ],
      scales: {
        x: { scale: scaleLinear, nice: true, grid: true },
        y: { scale: scaleBand },
      },
      theme: CHART_THEME,
    });
  }, [utilizationQuery.data]);

  const todayItems = todayQuery.data?.items ?? [];
  const breakdown = breakdownQuery.data;

  return (
    <AppShell me={me} active="dashboard">
      <PageHeader
        eyebrow={me.organization.name}
        title="Dashboard"
        description="Operational pulse for the trailing 30 days, refreshed from the live API."
        actions={
          <Badge variant="secondary" className="gap-1.5 px-3 py-1">
            <LayoutDashboard className="size-3.5" />
            Trailing {REPORT_DAYS} days
          </Badge>
        }
      />

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          className="animate-rise"
          label="Today"
          value={todayQuery.data ? String(todayItems.length) : '—'}
          hint={todayItems.length === 1 ? 'appointment on the books' : 'appointments on the books'}
          icon={CalendarDays}
          tone="primary"
        />
        <StatCard
          className="animate-rise"
          style={{ animationDelay: '50ms' }}
          label={`Bookings · ${REPORT_DAYS}d`}
          value={breakdown ? String(breakdown.total) : '—'}
          hint="across all statuses"
          icon={TrendingUp}
          tone="info"
        />
        <StatCard
          className="animate-rise"
          style={{ animationDelay: '100ms' }}
          label="Cancellation rate"
          value={breakdown ? percent(breakdown.cancellationRate) : '—'}
          hint="share of window bookings"
          icon={CalendarX2}
          tone="warning"
        />
        <StatCard
          className="animate-rise"
          style={{ animationDelay: '150ms' }}
          label="No-show rate"
          value={breakdown ? percent(breakdown.noShowRate) : '—'}
          hint="share of window bookings"
          icon={UserX}
          tone="destructive"
        />
      </div>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-3">
        <Card className="animate-rise lg:col-span-2" data-testid="chart-volume">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-chart-1/10 text-chart-1">
                <TrendingUp className="size-4" />
              </span>
              Appointment volume
            </CardTitle>
            <CardDescription>Bookings per UTC day over the trailing 30 days.</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartFrame
              isLoading={volumeQuery.isLoading}
              isError={volumeQuery.isError}
              isEmpty={false}
              height={280}
            >
              <Chart
                definition={volumeDefinition}
                ariaLabel="Daily appointment volume over the trailing 30 days"
                height={280}
              />
            </ChartFrame>
          </CardContent>
        </Card>

        <Card className="animate-rise" data-testid="today-schedule">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <CalendarDays className="size-4" />
              </span>
              Today&apos;s schedule
            </CardTitle>
            <CardDescription>
              {todayQuery.data ? `${todayQuery.data.date} · UTC` : 'Today · UTC'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {todayQuery.isLoading && <Skeleton className="h-40 w-full rounded-lg" />}
            {todayQuery.isError && (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertDescription>Could not load today&apos;s schedule.</AlertDescription>
              </Alert>
            )}
            {todayQuery.data && todayItems.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No appointments today.
              </p>
            )}
            {todayQuery.data && todayItems.length > 0 && (
              <ul className="max-h-[360px] divide-y divide-border/60 overflow-y-auto pr-1">
                {todayItems.map((item) => (
                  <li
                    key={item.id}
                    data-testid="today-row"
                    className="flex items-start gap-3 py-2.5"
                  >
                    <span className="mt-0.5 w-12 shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-center font-mono text-xs tabular-nums text-muted-foreground">
                      {formatTime(item.start)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <Link
                        to="/patients/$patientId"
                        params={{ patientId: item.patientId }}
                        className="block break-words text-sm font-medium text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline"
                      >
                        {patientName(item.patientId)}
                      </Link>
                      <span className="block break-words text-xs text-muted-foreground">
                        {providerName(item.memberId)}
                      </span>
                    </span>
                    <Badge
                      variant="outline"
                      className={cn('shrink-0 whitespace-nowrap', STATUS_META[item.status].badge)}
                    >
                      {STATUS_META[item.status].label}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="animate-rise" data-testid="chart-status">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-chart-3/10 text-chart-3">
                <BarChart3 className="size-4" />
              </span>
              Status breakdown
            </CardTitle>
            <CardDescription>All seven states over the trailing 30 days.</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartFrame
              isLoading={breakdownQuery.isLoading}
              isError={breakdownQuery.isError}
              isEmpty={false}
              height={240}
            >
              <Chart
                definition={statusDefinition}
                ariaLabel="Appointment counts by status over the trailing 30 days"
                height={240}
              />
            </ChartFrame>
            {breakdownQuery.data && (
              <div className="mt-4 grid grid-cols-3 gap-2 border-t border-border/70 pt-4 text-center">
                <Stat label="Total" value={String(breakdownQuery.data.total)} />
                <Stat label="Cancelled" value={percent(breakdownQuery.data.cancellationRate)} />
                <Stat label="No-show" value={percent(breakdownQuery.data.noShowRate)} />
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="animate-rise lg:col-span-2" data-testid="chart-utilization">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-chart-2/10 text-chart-2">
                <Gauge className="size-4" />
              </span>
              Provider utilization
            </CardTitle>
            <CardDescription>
              Booked minutes against the documented 8h/day capacity (480 min); 100% = one
              fully-booked day.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChartFrame
              isLoading={utilizationQuery.isLoading}
              isError={utilizationQuery.isError}
              isEmpty={(utilizationQuery.data?.providers.length ?? 0) === 0}
              height={240}
            >
              <Chart
                definition={utilizationDefinition}
                ariaLabel="Provider utilization over the trailing 30 days"
                height={240}
              />
            </ChartFrame>
            {members.length > 0 && (
              <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Users className="size-3.5" />
                {members.length} {members.length === 1 ? 'provider' : 'providers'} in this
                organization
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function ChartFrame({
  isLoading,
  isError,
  isEmpty,
  height,
  children,
}: {
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  height: number;
  children: ReactNode;
}) {
  if (isLoading) {
    return <Skeleton className="w-full rounded-lg" style={{ height }} />;
  }
  if (isError) {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertDescription>Could not load this report. Refresh to try again.</AlertDescription>
      </Alert>
    );
  }
  if (isEmpty) {
    return (
      <div
        className="flex w-full items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground"
        style={{ height }}
      >
        No data in this window.
      </div>
    );
  }
  return <>{children}</>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-display text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
