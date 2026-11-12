import { createFileRoute, Link } from '@tanstack/react-router';
import { useDbClient, useLiveInfiniteQuery } from '@tanstack/react-db';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import {
  createPatientSchema,
  patientSchema,
  type Patient,
  type WorkspaceMe,
} from '@careops/shared';
import { ArrowLeft, UserRoundPlus, Users } from 'lucide-react';
import { ZodForm } from '#/components/zod-form';
import { Alert, AlertDescription } from '#/components/ui/alert';
import { Badge } from '#/components/ui/badge';
import { Button } from '#/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card';
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
import { PATIENTS_PAGE_SIZE, patientsCollectionOptions } from '#/lib/patients-collection';
import { useWorkspace } from '#/lib/use-workspace';

export const Route = createFileRoute('/patients')({ component: PatientsPage });

const features = tableFeatures({});
const column = createColumnHelper<typeof features, Patient>();
const columns = column.columns([
  column.accessor('firstName', {
    header: 'Patient',
    cell: (info) => (
      <Link
        to="/patients/$patientId"
        params={{ patientId: info.row.original.id }}
        className="font-medium text-primary underline-offset-4 hover:underline"
      >
        {info.row.original.firstName} {info.row.original.lastName}
      </Link>
    ),
  }),
  column.accessor('dateOfBirth', {
    header: 'Date of birth',
    cell: (info) => (
      <span className="tabular-nums text-muted-foreground">{info.getValue().slice(0, 10)}</span>
    ),
  }),
  column.accessor('phone', {
    header: 'Phone',
    cell: (info) => info.getValue() ?? <span className="text-muted-foreground">—</span>,
  }),
  column.accessor('contactEmail', {
    header: 'Contact email',
    cell: (info) => info.getValue() ?? <span className="text-muted-foreground">—</span>,
  }),
]);

const EMPTY_PATIENTS: Patient[] = [];

function PatientsPage() {
  const me = useWorkspace('/patients');
  if (!me) {
    return <div className="p-8 text-muted-foreground">Loading…</div>;
  }
  // Mounted only after the client-side auth check, so live queries never
  // subscribe during SSR.
  return <PatientsWorkspace me={me} />;
}

function PatientsWorkspace({ me }: { me: WorkspaceMe }) {
  const db = useDbClient();
  const patients = db.collection(patientsCollectionOptions);
  const live = useLiveInfiniteQuery(
    (q) => q.from({ patients }).orderBy(({ patients: patient }) => patient.id, 'asc'),
    { pageSize: PATIENTS_PAGE_SIZE },
  );
  const table = useTable({ features, columns, data: live.data ?? EMPTY_PATIENTS });
  const canCreate = me.organization.role === 'owner' || me.organization.role === 'admin';

  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link
            to="/workspace"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" /> Workspace
          </Link>
          <p className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {me.organization.name}
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Patients</h1>
        </div>
        <Badge variant="secondary" className="gap-1.5 px-3 py-1">
          <Users className="size-3.5" />
          {live.data.length} {live.data.length === 1 ? 'record' : 'records'}
        </Badge>
      </header>

      <div
        className={`mt-6 grid items-start gap-6 ${
          canCreate ? 'lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]' : ''
        }`}
      >
        {canCreate && (
          <Card className="animate-in fade-in slide-in-from-bottom-2 duration-300">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <UserRoundPlus className="size-4 text-primary" /> New patient
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
                    testId: 'patient-date-of-birth',
                    autoComplete: 'bday',
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

        <Card className="animate-in fade-in slide-in-from-bottom-2 overflow-hidden duration-300">
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
                  <TableRow
                    key={row.id}
                    data-testid="patient-row"
                    className="transition-colors hover:bg-accent/40"
                  >
                    {row.getAllCells().map((cell) => (
                      <TableCell key={cell.id}>
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              {!live.isLoading && table.getRowModel().rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-24 text-center">
                    <span className="text-muted-foreground">
                      No patients yet{canCreate ? ' — add the first one.' : '.'}
                    </span>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {live.isLoadingError && (
            <div className="p-4">
              <Alert variant="destructive">
                <AlertDescription>Could not load patients. Refresh to try again.</AlertDescription>
              </Alert>
            </div>
          )}
          <div className="flex items-center justify-between border-t px-4 py-3">
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
      </div>
    </div>
  );
}
