import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { eq } from '@tanstack/db';
import { useDbClient, useLiveInfiniteQuery } from '@tanstack/react-db';
import { useQuery } from '@tanstack/react-query';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import {
  ALLOWED_TRANSITIONS,
  RESCHEDULABLE_STATUSES,
  appointmentSchema,
  appointmentStatusSchema,
  createAppointmentSchema,
  organizationCurrentSchema,
  patientsPageSchema,
  rescheduleAppointmentSchema,
  type Appointment,
  type AppointmentStatus,
  type OrganizationMember,
  type Patient,
  type WorkspaceMe,
} from '@careops/shared';
import { CalendarClock, CalendarPlus, CircleAlert, ListFilter } from 'lucide-react';
import { AppShell } from '#/components/app-shell';
import { EntityPicker, type PickerOption } from '#/components/entity-picker';
import { PageHeader } from '#/components/page-header';
import { PageLoading } from '#/components/page-loading';
import { ZodForm } from '#/components/zod-form';
import { Alert, AlertDescription } from '#/components/ui/alert';
import { Avatar } from '#/components/ui/avatar';
import { Badge } from '#/components/ui/badge';
import { Button } from '#/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card';
import { Dialog } from '#/components/ui/dialog';
import { EmptyState } from '#/components/ui/empty-state';
import { Select } from '#/components/ui/select';
import { Skeleton } from '#/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table';
import { apiGet, apiPost } from '#/lib/api';
import { STATUS_META } from '#/lib/appointment-status';
import {
  APPOINTMENTS_PAGE_SIZE,
  appointmentsCollectionOptions,
} from '#/lib/appointments-collection';
import { formatDateTimeDisplay } from '#/lib/dates';
import { useWorkspace } from '#/lib/use-workspace';
import { cn } from '#/lib/utils';

export const Route = createFileRoute('/appointments')({ component: AppointmentsPage });

const features = tableFeatures({});
const column = createColumnHelper<typeof features, Appointment>();

const EMPTY_APPOINTMENTS: Appointment[] = [];
const EMPTY_MEMBERS: OrganizationMember[] = [];
const EMPTY_PATIENTS: Patient[] = [];

function AppointmentsPage() {
  const me = useWorkspace('/appointments');
  if (!me) {
    return <PageLoading />;
  }
  // Mounted only after the client-side auth check, so live queries never
  // subscribe during SSR.
  return <AppointmentsWorkspace me={me} />;
}

function AppointmentsWorkspace({ me }: { me: WorkspaceMe }) {
  const db = useDbClient();
  const appointments = db.collection(appointmentsCollectionOptions);
  const [statusFilter, setStatusFilter] = useState<AppointmentStatus | ''>('');
  const [memberFilter, setMemberFilter] = useState('');
  const [rescheduleTarget, setRescheduleTarget] = useState<Appointment | null>(null);
  // Transition errors live here, keyed by appointment id: an optimistic rollback
  // re-renders the row, so per-row local state would lose the server reason.
  const [transitionErrors, setTransitionErrors] = useState<Record<string, string>>({});

  function setTransitionError(id: string, message: string | undefined) {
    setTransitionErrors((prev) => {
      const next = { ...prev };
      if (message === undefined) delete next[id];
      else next[id] = message;
      return next;
    });
  }

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
  const providerOptions: PickerOption[] = members.map((member) => ({
    id: member.id,
    label: member.name,
    sublabel: member.email,
  }));
  const patientOptions: PickerOption[] = patients.map((patient) => ({
    id: patient.id,
    label: `${patient.firstName} ${patient.lastName}`,
    sublabel: patient.contactEmail,
  }));
  const patientsById = new Map(patients.map((patient) => [patient.id, patient]));
  const membersById = new Map(members.map((member) => [member.id, member]));

  const patientName = (id: string) => {
    const patient = patientsById.get(id);
    return patient ? `${patient.firstName} ${patient.lastName}` : `Patient ${id.slice(0, 8)}`;
  };
  const providerName = (id: string) => membersById.get(id)?.name ?? `Provider ${id.slice(0, 8)}`;

  const live = useLiveInfiniteQuery(
    (q) => {
      let query = q.from({ appointments });
      if (statusFilter) {
        query = query.where(({ appointments: row }) => eq(row.status, statusFilter));
      }
      if (memberFilter) {
        query = query.where(({ appointments: row }) => eq(row.memberId, memberFilter));
      }
      return query.orderBy(({ appointments: row }) => row.id, 'desc');
    },
    { pageSize: APPOINTMENTS_PAGE_SIZE },
  );

  const canManage = me.organization.role === 'owner' || me.organization.role === 'admin';

  const columns = column.columns([
    column.accessor('patientId', {
      header: 'Patient',
      cell: (info) => (
        <span className="flex items-center gap-2.5">
          <Avatar name={patientName(info.row.original.patientId)} size="sm" />
          <Link
            to="/patients/$patientId"
            params={{ patientId: info.row.original.patientId }}
            className="font-medium text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline"
          >
            {patientName(info.row.original.patientId)}
          </Link>
        </span>
      ),
    }),
    column.accessor('memberId', {
      header: 'Provider',
      cell: (info) => providerName(info.row.original.memberId),
    }),
    column.accessor('start', {
      header: 'Start (UTC)',
      cell: (info) => {
        const [datePart, timePart] = formatDateTimeDisplay(info.getValue()).split(' · ');
        return (
          <span className="block font-mono text-xs tabular-nums text-muted-foreground">
            <span className="block whitespace-nowrap">{datePart}</span>
            <span className="block whitespace-nowrap text-muted-foreground/75">{timePart}</span>
          </span>
        );
      },
    }),
    column.accessor('durationMinutes', {
      header: 'Duration',
      cell: (info) => <span className="tabular-nums">{info.getValue()} min</span>,
    }),
    column.accessor('status', {
      header: 'Status',
      cell: (info) => (
        <Badge
          variant="outline"
          className={cn('capitalize whitespace-nowrap', STATUS_META[info.getValue()].badge)}
          data-testid={`status-${info.row.original.id}`}
        >
          {STATUS_META[info.getValue()].label}
        </Badge>
      ),
    }),
    column.display({
      id: 'actions',
      header: 'Actions',
      cell: (info) => (
        <StatusActions
          appointment={info.row.original}
          canManage={canManage}
          error={transitionErrors[info.row.original.id]}
          onError={(message) => setTransitionError(info.row.original.id, message)}
          onReschedule={setRescheduleTarget}
        />
      ),
    }),
  ]);

  const table = useTable({
    features,
    columns,
    data: live.data ?? EMPTY_APPOINTMENTS,
    getRowId: (row) => row.id,
  });

  return (
    <AppShell me={me} active="appointments">
      <PageHeader
        eyebrow={me.organization.name}
        title="Appointments"
        description="Book Providers in UTC, track every status change, and reschedule without double-booking."
        actions={
          <Badge variant="secondary" className="gap-1.5 px-3 py-1">
            <CalendarClock className="size-3.5" />
            {live.data.length} {live.data.length === 1 ? 'booking' : 'bookings'}
          </Badge>
        }
      />

      <div
        className={cn(
          'mt-6 grid items-start gap-6',
          canManage && 'xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]',
        )}
      >
        {canManage && (
          <Card className="animate-rise xl:sticky xl:top-20">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <CalendarPlus className="size-4" />
                </span>
                Book appointment
              </CardTitle>
              <CardDescription>
                Books a Provider for one Patient at a UTC start. Overlapping slots are rejected.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ZodForm
                schema={createAppointmentSchema}
                defaultValues={{
                  patientId: '',
                  memberId: '',
                  start: '',
                  durationMinutes: 30,
                  notes: undefined,
                }}
                fields={[
                  {
                    name: 'patientId',
                    label: 'Patient',
                    testId: 'booking-patient',
                    render: (control) => (
                      <EntityPicker
                        control={control}
                        options={patientOptions}
                        placeholder="Search patients…"
                        emptyMessage="No patients found"
                        testId="booking-patient"
                      />
                    ),
                  },
                  {
                    name: 'memberId',
                    label: 'Provider',
                    testId: 'booking-provider',
                    render: (control) => (
                      <EntityPicker
                        control={control}
                        options={providerOptions}
                        placeholder="Search providers…"
                        emptyMessage="No providers found"
                        testId="booking-provider"
                      />
                    ),
                  },
                  {
                    name: 'start',
                    label: 'Start (UTC)',
                    type: 'datetime',
                    testId: 'booking-start',
                  },
                  {
                    name: 'durationMinutes',
                    label: 'Duration',
                    type: 'number',
                    step: 5,
                    suffix: 'min',
                    testId: 'booking-duration',
                  },
                  {
                    name: 'notes',
                    label: 'Notes',
                    type: 'textarea',
                    optional: true,
                    testId: 'booking-notes',
                  },
                ]}
                submitLabel="Book appointment"
                submitTestId="book-appointment"
                resetOnSuccess
                onSubmit={async (values) => {
                  const created = await apiPost('/api/appointments', appointmentSchema, values);
                  await appointments.utils.writeUpsert(created);
                }}
              />
            </CardContent>
          </Card>
        )}

        <Card className="overflow-hidden animate-rise" style={{ animationDelay: '80ms' }}>
          <div className="flex flex-wrap items-center gap-3 border-b border-border/70 p-4">
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              <ListFilter className="size-3.5" /> Filter
            </span>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Status</span>
              <Select
                className="w-40"
                data-testid="filter-status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as AppointmentStatus | '')}
              >
                <option value="">All statuses</option>
                {appointmentStatusSchema.options.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_META[status].label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Provider</span>
              <Select
                className="w-44"
                data-testid="filter-provider"
                value={memberFilter}
                onChange={(e) => setMemberFilter(e.target.value)}
              >
                <option value="">All providers</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <Table data-testid="appointments-list">
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} className="bg-muted/50 hover:bg-muted/50">
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id}>
                      {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {live.isLoading &&
                Array.from({ length: 4 }, (_, index) => (
                  <TableRow key={`skeleton-${index}`}>
                    {columns.map((_, cellIndex) => (
                      <TableCell key={cellIndex}>
                        <Skeleton className="h-4 w-full max-w-40" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              {!live.isLoading &&
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id} data-testid="appointment-row">
                    {row.getAllCells().map((cell) => (
                      <TableCell key={cell.id}>
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              {!live.isLoading && table.getRowModel().rows.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns.length}>
                    <EmptyState
                      icon={CalendarClock}
                      title="No appointments match"
                      hint={
                        canManage
                          ? 'Book the first one with the form.'
                          : 'Bookings appear here once your team adds them.'
                      }
                    />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {live.isLoadingError && (
            <div className="p-4">
              <Alert variant="destructive">
                <CircleAlert />
                <AlertDescription>
                  Could not load appointments. Refresh to try again.
                </AlertDescription>
              </Alert>
            </div>
          )}
          <div className="flex items-center justify-between border-t border-border/70 px-4 py-3">
            <p className="text-xs text-muted-foreground">
              {live.hasNextPage ? 'More bookings available' : 'End of list'}
            </p>
            {live.hasNextPage && (
              <Button
                variant="outline"
                size="sm"
                disabled={live.isFetchingNextPage}
                data-testid="load-more"
                onClick={() => {
                  void live.fetchNextPage();
                }}
              >
                {live.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            )}
          </div>
        </Card>
      </div>

      {rescheduleTarget && (
        <RescheduleDialog
          appointment={rescheduleTarget}
          providerOptions={providerOptions}
          onClose={() => setRescheduleTarget(null)}
        />
      )}
    </AppShell>
  );
}

function StatusActions({
  appointment,
  canManage,
  error,
  onError,
  onReschedule,
}: {
  appointment: Appointment;
  canManage: boolean;
  error: string | undefined;
  onError: (message: string | undefined) => void;
  onReschedule: (appointment: Appointment) => void;
}) {
  const db = useDbClient();
  const appointments = db.collection(appointmentsCollectionOptions);
  const [pending, setPending] = useState<AppointmentStatus | undefined>();

  const targets = ALLOWED_TRANSITIONS[appointment.status];
  const reschedulable = RESCHEDULABLE_STATUSES.includes(appointment.status);

  async function transition(target: AppointmentStatus) {
    onError(undefined);
    setPending(target);
    try {
      // Optimistic: the row's status flips before the API answers; a 409 rolls
      // the transaction back and surfaces the server reason below the actions.
      const tx = appointments.update(appointment.id, (draft) => {
        draft.status = target;
      });
      await tx.when('settled');
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Transition failed');
    } finally {
      setPending(undefined);
    }
  }

  if (!canManage) {
    return <span className="text-xs text-muted-foreground">Read-only</span>;
  }

  return (
    <div className="grid gap-1.5">
      <div className="flex min-w-[9rem] flex-wrap gap-1">
        {targets.map((target) => (
          <Button
            key={target}
            size="xs"
            variant="outline"
            disabled={pending !== undefined}
            data-testid={`transition-${appointment.id}-${target}`}
            onClick={() => {
              void transition(target);
            }}
          >
            {pending === target ? '…' : STATUS_META[target].action}
          </Button>
        ))}
        {reschedulable && (
          <Button
            size="xs"
            variant="ghost"
            disabled={pending !== undefined}
            data-testid={`reschedule-${appointment.id}`}
            onClick={() => onReschedule(appointment)}
          >
            Reschedule
          </Button>
        )}
        {targets.length === 0 && !reschedulable && (
          <span className="text-xs text-muted-foreground">Terminal</span>
        )}
      </div>
      {error && (
        <p data-testid={`transition-error-${appointment.id}`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function RescheduleDialog({
  appointment,
  providerOptions,
  onClose,
}: {
  appointment: Appointment;
  providerOptions: PickerOption[];
  onClose: () => void;
}) {
  const db = useDbClient();
  const appointments = db.collection(appointmentsCollectionOptions);

  return (
    <Dialog
      onClose={onClose}
      label="Reschedule appointment"
      testId="reschedule-dialog"
      overlayTestId="reschedule-overlay"
    >
      <div className="border-b border-border/70 p-5 pb-4">
        <h2 className="font-display text-lg font-semibold">Reschedule appointment</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Change the start, duration, or Provider. The Conflict check re-runs on save.
        </p>
      </div>
      <div className="p-5">
        <ZodForm
          schema={rescheduleAppointmentSchema}
          defaultValues={{
            start: appointment.start,
            durationMinutes: appointment.durationMinutes,
            memberId: appointment.memberId,
          }}
          fields={[
            {
              name: 'start',
              label: 'Start (UTC)',
              type: 'datetime',
              testId: 'reschedule-start',
            },
            {
              name: 'durationMinutes',
              label: 'Duration',
              type: 'number',
              step: 5,
              suffix: 'min',
              testId: 'reschedule-duration',
            },
            {
              name: 'memberId',
              label: 'Provider',
              testId: 'reschedule-provider',
              render: (control) => (
                <EntityPicker
                  control={control}
                  options={providerOptions}
                  placeholder="Search providers…"
                  emptyMessage="No providers found"
                  testId="reschedule-provider"
                />
              ),
            },
          ]}
          submitLabel="Save reschedule"
          submitTestId="save-reschedule"
          onSubmit={async (values) => {
            const tx = appointments.update(appointment.id, (draft) => {
              if (values.start !== undefined) draft.start = values.start;
              if (values.durationMinutes !== undefined)
                draft.durationMinutes = values.durationMinutes;
              if (values.memberId !== undefined) draft.memberId = values.memberId;
            });
            await tx.when('settled');
            onClose();
          }}
        />
        <Button
          variant="ghost"
          className="mt-2 w-full"
          onClick={onClose}
          data-testid="cancel-reschedule"
        >
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}
