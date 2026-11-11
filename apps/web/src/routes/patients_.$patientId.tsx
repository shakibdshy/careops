import { useEffect, useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { patientSchema, workspaceMeSchema, type Patient, type WorkspaceMe } from '@careops/shared';
import { apiDelete, apiGet, apiPost, fieldErrorsOf } from '../lib/api';

export const Route = createFileRoute('/patients_/$patientId')({
  component: PatientDetailPage,
});

type DetailState =
  | { kind: 'loading' }
  | { kind: 'ready'; patient: Patient }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

function PatientDetailPage() {
  const { patientId } = Route.useParams();
  const navigate = useNavigate();
  const [me, setMe] = useState<WorkspaceMe>();
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Array<{ field: string; message: string }>>([]);

  useEffect(() => {
    apiGet('/api/workspace/me', workspaceMeSchema)
      .then(setMe)
      .catch(() => navigate({ to: '/login', search: { redirect: `/patients/${patientId}` } }));
  }, [navigate, patientId]);

  useEffect(() => {
    if (!me) return;
    apiGet(`/api/patients/${patientId}`, patientSchema)
      .then((patient) => {
        setState({ kind: 'ready', patient });
        setFirstName(patient.firstName);
        setLastName(patient.lastName);
        setDateOfBirth(patient.dateOfBirth.slice(0, 10));
        setPhone(patient.phone ?? '');
        setNotes(patient.notes ?? '');
      })
      .catch(() => setState({ kind: 'missing' }));
  }, [me, patientId]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setFormError(undefined);
    setFieldErrors([]);
    try {
      const updated = await apiPost(`/api/patients/${patientId}`, patientSchema, {
        firstName,
        lastName,
        dateOfBirth,
        ...(phone ? { phone } : {}),
        ...(notes ? { notes } : {}),
      });
      setState({ kind: 'ready', patient: updated });
      setFormError(undefined);
    } catch (error) {
      setFormError((error as Error).message);
      setFieldErrors(fieldErrorsOf(error));
    }
  }

  async function onDelete() {
    if (!window.confirm('Delete this patient? The audit trail retains the record.')) {
      return;
    }
    try {
      await apiDelete(`/api/patients/${patientId}`);
      await navigate({ to: '/patients' });
    } catch (error) {
      setFormError((error as Error).message);
    }
  }

  if (!me) {
    return <div className="p-8">Loading…</div>;
  }

  const canEdit = me.organization.role === 'owner' || me.organization.role === 'admin';

  return (
    <div className="p-8">
      <Link to="/patients" className="underline">
        ← Patients
      </Link>
      <h1 className="mt-4 text-2xl font-bold">Patient</h1>
      {state.kind === 'loading' && <p className="mt-4">Loading…</p>}
      {state.kind === 'missing' && <p className="mt-4 text-red-600">Patient not found.</p>}
      {state.kind === 'ready' && (
        <>
          <p className="mt-2 text-gray-600">Record id: {state.patient.id}</p>
          {canEdit ? (
            <form
              onSubmit={(e) => {
                void onSave(e);
              }}
              className="mt-6 flex max-w-md flex-col gap-3"
            >
              <input
                placeholder="First name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="rounded border p-2"
                data-testid="edit-first-name"
              />
              <input
                placeholder="Last name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="rounded border p-2"
                data-testid="edit-last-name"
              />
              <input
                type="date"
                value={dateOfBirth}
                onChange={(e) => setDateOfBirth(e.target.value)}
                className="rounded border p-2"
                data-testid="edit-date-of-birth"
              />
              <input
                placeholder="Phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="rounded border p-2"
                data-testid="edit-phone"
              />
              <textarea
                placeholder="Notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="rounded border p-2"
                data-testid="edit-notes"
              />
              {formError && <p className="text-red-600">{formError}</p>}
              {fieldErrors.length > 0 && (
                <ul className="text-red-600">
                  {fieldErrors.map((error) => (
                    <li key={error.field}>
                      {error.field}: {error.message}
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-3">
                <button
                  type="submit"
                  className="rounded bg-black p-2 text-white"
                  data-testid="save-patient"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void onDelete();
                  }}
                  className="rounded border border-red-600 p-2 text-red-600"
                  data-testid="delete-patient"
                >
                  Delete
                </button>
              </div>
            </form>
          ) : (
            <dl className="mt-4">
              <dt>First name</dt>
              <dd>{state.patient.firstName}</dd>
              <dt>Last name</dt>
              <dd>{state.patient.lastName}</dd>
              <dt>Date of birth</dt>
              <dd>{state.patient.dateOfBirth.slice(0, 10)}</dd>
              <dt>Phone</dt>
              <dd>{state.patient.phone ?? '—'}</dd>
              <dt>Notes</dt>
              <dd>{state.patient.notes ?? '—'}</dd>
            </dl>
          )}
        </>
      )}
    </div>
  );
}
