import { collectionOptions, extractSimpleComparisons } from '@tanstack/db';
import { createCursorPager, queryCollectionOptions } from '@tanstack/query-db-collection';
import type { QueryClient } from '@tanstack/react-query';
import { patientSchema, patientsPageSchema, type Patient } from '@careops/shared';
import { apiDelete, apiGet, apiPatch } from './api';

export const PATIENTS_PAGE_SIZE = 20;

/**
 * Patients collection (ADR-0009): one SSR-safe descriptor, materialized per
 * DbClient. The list window is served by a cursor pager over the API's `_id`
 * ascending pages (ADR-0008); a detail live query's `id = ?` subset is fetched
 * directly. Mutations are optimistic: a throwing handler rolls the transaction
 * back and surfaces the server reason to the caller.
 */
export const patientsCollectionOptions = collectionOptions('patients', (client) => {
  const queryClient = client.requireDependency<QueryClient>('queryClient');

  const pager = createCursorPager<Patient>({
    queryClient,
    queryKey: ['patients', 'pages'],
    staleTime: 30_000,
    fetchPage: async (cursor, signal) => {
      const query = new URLSearchParams({ limit: String(PATIENTS_PAGE_SIZE) });
      if (cursor) query.set('cursor', cursor);
      const page = await apiGet(`/api/patients?${query.toString()}`, patientsPageSchema, {
        signal,
      });
      return { rows: page.items, nextCursor: page.nextCursor ?? null };
    },
  });

  return queryCollectionOptions({
    queryClient,
    queryKey: ['patients', 'rows'],
    schema: patientSchema,
    getKey: (patient) => patient.id,
    syncMode: 'on-demand',
    queryFn: async (ctx) => {
      const subset = ctx.meta?.loadSubsetOptions;
      const idFilter = extractSimpleComparisons(subset?.where).find(
        (comparison) => comparison.operator === 'eq' && comparison.field.join('.') === 'id',
      );
      if (idFilter) {
        const id = idFilter.value as string;
        try {
          return [await apiGet(`/api/patients/${id}`, patientSchema, { signal: ctx.signal })];
        } catch (error) {
          // A missing patient is an empty subset, not a sync failure.
          if ((error as { status?: number }).status === 404) return [];
          throw error;
        }
      }
      return pager.read(
        {
          offset: subset?.offset ?? 0,
          ...(subset?.limit !== undefined ? { limit: subset.limit } : {}),
        },
        ctx.signal,
      );
    },
    onUpdate: async ({ transaction, collection }) => {
      for (const mutation of transaction.mutations) {
        const confirmed = await apiPatch(
          `/api/patients/${mutation.key}`,
          patientSchema,
          mutation.changes,
        );
        // Confirm with server truth; without a write the optimistic state reverts.
        await collection.utils.writeUpsert(confirmed);
      }
    },
    onDelete: async ({ transaction, collection }) => {
      for (const mutation of transaction.mutations) {
        await apiDelete(`/api/patients/${mutation.key}`);
      }
      // Rebuild the pager's cached pages so the deleted row cannot resurrect.
      pager.reset();
      await collection.utils.refetch();
    },
  });
});
