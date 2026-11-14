import { useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { eq } from '@tanstack/db';
import { useDbClient, useLiveQuery } from '@tanstack/react-db';
import { updatePatientSchema, type WorkspaceMe } from '@careops/shared';
import {
  ArrowLeft,
  CalendarDays,
  CircleAlert,
  FileText,
  IdCard,
  Mail,
  Phone,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { AppShell } from '#/components/app-shell';
import { PageLoading } from '#/components/page-loading';
import { ZodForm } from '#/components/zod-form';
import { Alert, AlertDescription } from '#/components/ui/alert';
import { Avatar } from '#/components/ui/avatar';
import { Badge } from '#/components/ui/badge';
import { Button } from '#/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card';
import { EmptyState } from '#/components/ui/empty-state';
import { formatDateDisplay, todayIso } from '#/lib/dates';
import { patientsCollectionOptions } from '#/lib/patients-collection';
import { useWorkspace } from '#/lib/use-workspace';

export const Route = createFileRoute('/patients_/$patientId')({
  component: PatientDetailPage,
});

function PatientDetailPage() {
  const { patientId } = Route.useParams();
  const me = useWorkspace(`/patients/${patientId}`);
  if (!me) {
    return <PageLoading />;
  }
  // Mounted only after the client-side auth check, so live queries never
  // subscribe during SSR.
  return <PatientDetail me={me} patientId={patientId} />;
}

function PatientDetail({ me, patientId }: { me: WorkspaceMe; patientId: string }) {
  const navigate = useNavigate();
  const db = useDbClient();
  const patients = db.collection(patientsCollectionOptions);
  const { data: patient, isLoading } = useLiveQuery({
    query: (q) =>
      q
        .from({ patients })
        .where(({ patients: row }) => eq(row.id, patientId))
        .findOne(),
  });
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();

  const canEdit = me.organization.role === 'owner' || me.organization.role === 'admin';

  async function onDelete() {
    if (!window.confirm('Delete this patient? The audit trail retains the record.')) {
      return;
    }
    setDeleting(true);
    setDeleteError(undefined);
    try {
      const tx = patients.delete(patientId);
      await tx.when('settled');
      await navigate({ to: '/patients' });
    } catch (error) {
      setDeleting(false);
      setDeleteError(error instanceof Error ? error.message : 'Could not delete the patient');
    }
  }

  if (isLoading || deleting) {
    return (
      <AppShell me={me} active="patients">
        <PageLoading label={deleting ? 'Deleting record…' : 'Loading record…'} />
      </AppShell>
    );
  }
  if (!patient) {
    return (
      <AppShell me={me} active="patients">
        <BackLink />
        <Card className="mt-6">
          <EmptyState
            icon={CircleAlert}
            title="Patient not found"
            hint="The record may have been deleted, or the link is out of date."
          />
        </Card>
      </AppShell>
    );
  }

  const fullName = `${patient.firstName} ${patient.lastName}`;

  return (
    <AppShell me={me} active="patients">
      <BackLink />

      <header className="mt-5 flex flex-wrap items-center gap-4 animate-rise">
        <Avatar name={fullName} size="xl" className="shadow-card" />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Patient record
          </p>
          <h1
            className="mt-0.5 truncate font-display text-3xl font-bold tracking-tight"
            data-testid="patient-name"
          >
            {patient.firstName} {patient.lastName}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="gap-1.5">
              <CalendarDays className="size-3.5" />
              Born {formatDateDisplay(patient.dateOfBirth)}
            </Badge>
            <span className="font-mono text-[11px] text-muted-foreground/80">id {patient.id}</span>
          </div>
        </div>
      </header>

      <div
        className={`mt-6 grid items-start gap-6 ${
          canEdit ? 'xl:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]' : ''
        }`}
      >
        <Card className="animate-rise" style={{ animationDelay: '60ms' }}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <IdCard className="size-4" />
              </span>
              Details
            </CardTitle>
            <CardDescription>
              {canEdit
                ? 'Changes apply immediately and are written to the audit trail.'
                : 'Read-only — your role cannot edit patient records.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canEdit ? (
              <ZodForm
                schema={updatePatientSchema}
                defaultValues={{
                  firstName: patient.firstName,
                  lastName: patient.lastName,
                  dateOfBirth: patient.dateOfBirth.slice(0, 10),
                  phone: patient.phone,
                  contactEmail: patient.contactEmail,
                  notes: patient.notes,
                }}
                fields={[
                  { name: 'firstName', label: 'First name', testId: 'edit-first-name' },
                  { name: 'lastName', label: 'Last name', testId: 'edit-last-name' },
                  {
                    name: 'dateOfBirth',
                    label: 'Date of birth',
                    type: 'date',
                    max: todayIso(),
                    testId: 'edit-date-of-birth',
                  },
                  { name: 'phone', label: 'Phone', optional: true, testId: 'edit-phone' },
                  {
                    name: 'contactEmail',
                    label: 'Contact email',
                    type: 'email',
                    optional: true,
                    testId: 'edit-contact-email',
                  },
                  {
                    name: 'notes',
                    label: 'Notes',
                    type: 'textarea',
                    optional: true,
                    testId: 'edit-notes',
                  },
                ]}
                submitLabel="Save"
                submitTestId="save-patient"
                onSubmit={async (values) => {
                  // Optimistic: the live row (and header) update before the API
                  // answers; a 4xx rolls the transaction back and throws the
                  // server reason into ZodForm's field errors.
                  const tx = patients.update(patientId, (draft) => {
                    Object.assign(draft, values);
                  });
                  await tx.when('settled');
                }}
              />
            ) : (
              <dl className="grid gap-1 text-sm">
                <DetailRow label="First name" value={patient.firstName} />
                <DetailRow label="Last name" value={patient.lastName} />
                <DetailRow
                  label="Date of birth"
                  value={formatDateDisplay(patient.dateOfBirth)}
                  mono
                />
                <DetailRow icon={Phone} label="Phone" value={patient.phone} />
                <DetailRow icon={Mail} label="Contact email" value={patient.contactEmail} />
                <DetailRow icon={FileText} label="Notes" value={patient.notes} />
              </dl>
            )}
          </CardContent>
        </Card>

        {canEdit && (
          <Card className="animate-rise border-destructive/25" style={{ animationDelay: '120ms' }}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <span className="flex size-8 items-center justify-center rounded-lg bg-destructive/10">
                  <ShieldAlert className="size-4" />
                </span>
                Danger zone
              </CardTitle>
              <CardDescription>
                Deleting removes the record from the list. The audit trail retains it.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {deleteError && (
                <Alert variant="destructive" data-testid="delete-error">
                  <CircleAlert />
                  <AlertDescription>{deleteError}</AlertDescription>
                </Alert>
              )}
              <div>
                <Button
                  type="button"
                  variant="destructive"
                  data-testid="delete-patient"
                  onClick={() => {
                    void onDelete();
                  }}
                >
                  <Trash2 className="size-4" /> Delete patient
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}

function BackLink() {
  return (
    <Link
      to="/patients"
      className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-4" /> All patients
    </Link>
  );
}

function DetailRow({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon?: typeof Phone;
  label: string;
  value: string | undefined;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[9rem_1fr] items-baseline gap-2 rounded-lg px-2 py-2 odd:bg-muted/40">
      <dt className="flex items-center gap-1.5 text-muted-foreground">
        {Icon && <Icon className="size-3.5 shrink-0" />}
        {label}
      </dt>
      <dd className={mono ? 'tabular-nums' : undefined}>{value || '—'}</dd>
    </div>
  );
}
