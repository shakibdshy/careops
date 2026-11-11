import { useEffect, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { patientsPageSchema, workspaceMeSchema, type WorkspaceMe } from '@careops/shared';
import { apiGet, apiPost, fieldErrorsOf } from '../lib/api';

export const Route = createFileRoute('/patients')({ component: PatientsPage });

function useWorkspace(): WorkspaceMe | undefined {
  const navigate = useNavigate();
  const [me, setMe] = useState<WorkspaceMe>();

  useEffect(() => {
    apiGet('/api/workspace/me', workspaceMeSchema)
      .then(setMe)
      .catch(() => navigate({ to: '/login', search: { redirect: '/patients' } }));
  }, [navigate]);

  return me;
}

function PatientsPage() {
  const me = useWorkspace();
  const queryClient = useQueryClient();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [formError, setFormError] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Array<{ field: string; message: string }>>([]);

  const patientsQuery = useInfiniteQuery({
    queryKey: ['patients'],
    queryFn: ({ pageParam }) =>
      apiGet(`/api/patients${pageParam ? `?cursor=${pageParam}` : ''}`, patientsPageSchema),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const createMutation = useMutation({
    mutationFn: async () =>
      apiPost('/api/patients', patientsPageSchema.shape.items.element, {
        firstName,
        lastName,
        dateOfBirth,
      }),
    onSuccess: () => {
      setFirstName('');
      setLastName('');
      setDateOfBirth('');
      setFormError(undefined);
      setFieldErrors([]);
      void queryClient.invalidateQueries({ queryKey: ['patients'] });
    },
    onError: (error: Error) => {
      setFormError(error.message);
      setFieldErrors(fieldErrorsOf(error));
    },
  });

  if (!me) {
    return <div className="p-8">Loading…</div>;
  }

  const canCreate = me.organization.role === 'owner' || me.organization.role === 'admin';

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Patients — {me.organization.name}</h1>
      {canCreate && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void createMutation.mutateAsync().catch(() => undefined);
          }}
          className="mt-6 flex flex-wrap items-end gap-3"
        >
          <input
            placeholder="First name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className="rounded border p-2"
            data-testid="patient-first-name"
          />
          <input
            placeholder="Last name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className="rounded border p-2"
            data-testid="patient-last-name"
          />
          <input
            type="date"
            value={dateOfBirth}
            onChange={(e) => setDateOfBirth(e.target.value)}
            className="rounded border p-2"
            data-testid="patient-date-of-birth"
          />
          <button
            type="submit"
            disabled={createMutation.isPending}
            className="rounded bg-black p-2 text-white disabled:opacity-50"
            data-testid="create-patient"
          >
            Add patient
          </button>
        </form>
      )}
      {formError && <p className="mt-3 text-red-600">{formError}</p>}
      {fieldErrors.length > 0 && (
        <ul className="mt-2 text-red-600" data-testid="patient-field-errors">
          {fieldErrors.map((error) => (
            <li key={error.field}>
              {error.field}: {error.message}
            </li>
          ))}
        </ul>
      )}
      {patientsQuery.isLoading && <p className="mt-6">Loading patients…</p>}
      {patientsQuery.isError && (
        <p className="mt-6 text-red-600">{String(patientsQuery.error.message)}</p>
      )}
      {patientsQuery.data && (
        <ul className="mt-6 divide-y" data-testid="patients-list">
          {patientsQuery.data.pages.flatMap((page) =>
            page.items.map((patient) => (
              <li key={patient.id} className="py-2" data-testid="patient-row">
                <span className="font-medium">
                  {patient.firstName} {patient.lastName}
                </span>{' '}
                <span className="text-gray-600">born {patient.dateOfBirth.slice(0, 10)}</span>
              </li>
            )),
          )}
        </ul>
      )}
      {patientsQuery.hasNextPage && (
        <button
          onClick={() => {
            void patientsQuery.fetchNextPage();
          }}
          className="mt-4 rounded border p-2"
          data-testid="load-more"
        >
          Load more
        </button>
      )}
    </div>
  );
}
