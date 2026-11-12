import { useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { eq } from '@tanstack/db';
import { useDbClient, useLiveQuery } from '@tanstack/react-db';
import { updatePatientSchema, type WorkspaceMe } from '@careops/shared';
import { ArrowLeft, CalendarDays, Trash2 } from 'lucide-react';
import { ZodForm } from '#/components/zod-form';
import { Alert, AlertDescription } from '#/components/ui/alert';
import { Badge } from '#/components/ui/badge';
import { Button } from '#/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card';
import { patientsCollectionOptions } from '#/lib/patients-collection';
import { useWorkspace } from '#/lib/use-workspace';

export const Route = createFileRoute('/patients_/$patientId')({
  component: PatientDetailPage,
});

function PatientDetailPage() {
  const { patientId } = Route.useParams();
  const me = useWorkspace(`/patients/${patientId}`);
  if (!me) {
    return <div className="p-8 text-muted-foreground">Loading…</div>;
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
    return <div className="p-8 text-muted-foreground">Loading…</div>;
  }
  if (!patient) {
    return (
      <div className="mx-auto max-w-3xl p-6 lg:p-8">
        <Link
          to="/patients"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Patients
        </Link>
        <p className="mt-6 text-destructive">Patient not found.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-6 lg:p-8">
      <Link
        to="/patients"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> Patients
      </Link>

      <header className="mt-4">
        <h1 className="text-3xl font-bold tracking-tight" data-testid="patient-name">
          {patient.firstName} {patient.lastName}
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="gap-1.5">
            <CalendarDays className="size-3.5" />
            Born {patient.dateOfBirth.slice(0, 10)}
          </Badge>
          <span className="text-xs text-muted-foreground">Record id: {patient.id}</span>
        </div>
      </header>

      <Card className="mt-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <CardHeader>
          <CardTitle className="text-base">Patient record</CardTitle>
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
            <dl className="grid gap-3 text-sm">
              <div className="grid grid-cols-[10rem_1fr] gap-2">
                <dt className="text-muted-foreground">First name</dt>
                <dd>{patient.firstName}</dd>
              </div>
              <div className="grid grid-cols-[10rem_1fr] gap-2">
                <dt className="text-muted-foreground">Last name</dt>
                <dd>{patient.lastName}</dd>
              </div>
              <div className="grid grid-cols-[10rem_1fr] gap-2">
                <dt className="text-muted-foreground">Date of birth</dt>
                <dd className="tabular-nums">{patient.dateOfBirth.slice(0, 10)}</dd>
              </div>
              <div className="grid grid-cols-[10rem_1fr] gap-2">
                <dt className="text-muted-foreground">Phone</dt>
                <dd>{patient.phone ?? '—'}</dd>
              </div>
              <div className="grid grid-cols-[10rem_1fr] gap-2">
                <dt className="text-muted-foreground">Contact email</dt>
                <dd>{patient.contactEmail ?? '—'}</dd>
              </div>
              <div className="grid grid-cols-[10rem_1fr] gap-2">
                <dt className="text-muted-foreground">Notes</dt>
                <dd>{patient.notes ?? '—'}</dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>

      {canEdit && (
        <Card className="mt-6 border-destructive/30">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Danger zone</CardTitle>
            <CardDescription>
              Deleting removes the record from the list. The audit trail retains it.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {deleteError && (
              <Alert variant="destructive" data-testid="delete-error">
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
  );
}
