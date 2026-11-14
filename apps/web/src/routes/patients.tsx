import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useDbClient, useLiveInfiniteQuery } from '@tanstack/react-db';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import {
  createPatientSchema,
  patientSchema,
  type Patient,
  type WorkspaceMe,
} from '@careops/shared';
import { CircleAlert, Search, UserRoundPlus, Users } from 'lucide-react';
import { AppShell } from '#/components/app-shell';
import { PageHeader } from '#/components/page-header';
import { PageLoading } from '#/components/page-loading';
import { ZodForm } from '#/components/zod-form';
import { Alert, AlertDescription } from '#/components/ui/alert';
import { Avatar } from '#/components/ui/avatar';
import { Badge } from '#/components/ui/badge';
import { Button } from '#/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card';
import { EmptyState } from '#/components/ui/empty-state';
import { Input } from '#/components/ui/input';
import { Skeleton } from '#/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table';
import { apiPost } from '#/lib/api';
import { formatDateDisplay, todayIso } from '#/lib/dates';
import { PATIENTS_PAGE_SIZE, patientsCollectionOptions } from '#/lib/patients-collection';
import { useWorkspace } from '#/lib/use-workspace';

export const Route = createFileRoute('/patients')({ component: PatientsPage });

const features = tableFeatures({});
const column = createColumnHelper<typeof features, Patient>();
const columns = column.columns([
  column.accessor('firstName', {
    header: 'Patient',
    cell: (info) => (
      <span className="flex items-center gap-3">
        <Avatar name={`${info.row.original.firstName} ${info.row.original.lastName}`} />
        <Link
          to="/patients/$patientId"
          params={{ patientId: info.row.original.id }}
          className="font-medium text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline"
        >
          {info.row.original.firstName} {info.row.original.lastName}
        </Link>
      </span>
    ),
  }),
  column.accessor('dateOfBirth', {
    header: 'Date of birth',
    cell: (info) => (
      <span className="tabular-nums text-muted-foreground">
        {formatDateDisplay(info.getValue())}
      </span>
    ),
  }),
  column.accessor('phone', {
    header: 'Phone',
    cell: (info) =>
      info.getValue() ? (
        <span className="tabular-nums">{info.getValue()}</span>
      ) : (
        <span className="text-muted-foreground/60">—</span>
      ),
  }),
  column.accessor('contactEmail', {
    header: 'Contact email',
    cell: (info) => info.getValue() ?? <span className="text-muted-foreground/60">—</span>,
  }),
]);

const EMPTY_PATIENTS: Patient[] = [];

function PatientsPage() {
  const me = useWorkspace('/patients');
  if (!me) {
    return <PageLoading />;
  }
  // Mounted only after the client-side auth check, so live queries never
  // subscribe during SSR.
  return <PatientsWorkspace me={me} />;
}

function PatientsWorkspace({ me }: { me: WorkspaceMe }) {
  const db = useDbClient();
  const patients = db.collection(patientsCollectionOptions);
  const [search, setSearch] = useState('');
  const live = useLiveInfiniteQuery(
    (q) => q.from({ patients }).orderBy(({ patients: patient }) => patient.id, 'asc'),
    { pageSize: PATIENTS_PAGE_SIZE },
  );

  const query = search.trim().toLowerCase();
  const rows = (live.data ?? EMPTY_PATIENTS).filter((patient) => {
    if (!query) return true;
    return [patient.firstName, patient.lastName, patient.contactEmail, patient.phone]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(query));
  });

  const table = useTable({ features, columns, data: rows });
  const canCreate = me.organization.role === 'owner' || me.organization.role === 'admin';

  return (
    <AppShell me={me} active="patients">
      <PageHeader
        eyebrow={me.organization.name}
        title="Patients"
        description="Every record is scoped to this organization and written to the audit trail."
        actions={
          <Badge variant="secondary" className="gap-1.5 px-3 py-1">
            <Users className="size-3.5" />
            {live.data.length} {live.data.length === 1 ? 'record' : 'records'}
          </Badge>
        }
      />

      <div
        className={`mt-6 grid items-start gap-6 ${
          canCreate ? 'xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]' : ''
        }`}
      >
        <Card className="overflow-hidden animate-rise">
          <div className="flex flex-wrap items-center gap-3 border-b border-border/70 p-4">
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70" />
              <Input
                type="search"
                placeholder="Search patients…"
                aria-label="Search patients"
                data-testid="patient-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 pl-9"
              />
            </div>
            {query && (
              <p className="text-xs text-muted-foreground">
                {rows.length} {rows.length === 1 ? 'match' : 'matches'}
              </p>
            )}
          </div>
          <Table data-testid="patients-list">
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
                  <TableRow key={row.id} data-testid="patient-row">
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
                      icon={Users}
                      title={query ? 'No matching patients' : 'No patients yet'}
                      hint={
                        query
                          ? 'Try a different name, email or phone.'
                          : canCreate
                            ? 'Add the first record with the form.'
                            : 'Records appear here once your team adds them.'
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
                <AlertDescription>Could not load patients. Refresh to try again.</AlertDescription>
              </Alert>
            </div>
          )}
          <div className="flex items-center justify-between border-t border-border/70 px-4 py-3">
            <p className="text-xs text-muted-foreground">
              {live.hasNextPage ? 'More records available' : 'End of list'}
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

        {canCreate && (
          <Card
            className="order-first animate-rise xl:order-none xl:sticky xl:top-20"
            style={{ animationDelay: '80ms' }}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <UserRoundPlus className="size-4" />
                </span>
                New patient
              </CardTitle>
              <CardDescription>
                Added to this organization only. Names and date of birth are required.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ZodForm
                schema={createPatientSchema}
                defaultValues={{
                  firstName: '',
                  lastName: '',
                  dateOfBirth: '',
                  phone: undefined,
                  contactEmail: undefined,
                  notes: undefined,
                }}
                fields={[
                  {
                    name: 'firstName',
                    label: 'First name',
                    testId: 'patient-first-name',
                    autoComplete: 'given-name',
                  },
                  {
                    name: 'lastName',
                    label: 'Last name',
                    testId: 'patient-last-name',
                    autoComplete: 'family-name',
                  },
                  {
                    name: 'dateOfBirth',
                    label: 'Date of birth',
                    type: 'date',
                    max: todayIso(),
                    testId: 'patient-date-of-birth',
                  },
                  {
                    name: 'phone',
                    label: 'Phone',
                    optional: true,
                    testId: 'patient-phone',
                    autoComplete: 'tel',
                  },
                  {
                    name: 'contactEmail',
                    label: 'Contact email',
                    type: 'email',
                    optional: true,
                    testId: 'patient-contact-email',
                    autoComplete: 'email',
                  },
                  {
                    name: 'notes',
                    label: 'Notes',
                    type: 'textarea',
                    optional: true,
                    testId: 'patient-notes',
                  },
                ]}
                submitLabel="Add patient"
                submitTestId="create-patient"
                resetOnSuccess
                onSubmit={async (values) => {
                  const created = await apiPost('/api/patients', patientSchema, values);
                  await patients.utils.writeUpsert(created);
                }}
              />
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
