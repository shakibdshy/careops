import { collectionOptions, extractSimpleComparisons } from '@tanstack/db';
import {
  createCursorPager,
  queryCollectionOptions,
  type CursorPager,
} from '@tanstack/query-db-collection';
import type { QueryClient } from '@tanstack/react-query';
import {
  appointmentSchema,
  appointmentsPageSchema,
  type Appointment,
  type AppointmentStatus,
} from '@careops/shared';
import { apiGet, apiPatch, apiPost } from './api';

export const APPOINTMENTS_PAGE_SIZE = 20;

interface AppointmentFilter {
  status?: AppointmentStatus | undefined;
  memberId?: string | undefined;
}

/**
 * Appointments collection (ADR-0009): one SSR-safe descriptor, materialized per
 * DbClient. The list window is served by cursor pagers over the API's newest-first
 * `_id` descending pages (ADR-0008); each status/Provider filter combination gets
 * its own pager so the server does the filtering and paging. A detail live query's
 * `id = ?` subset is fetched directly. Mutations are optimistic: a status change is
 * a lifecycle transition, anything else is a Reschedule; a throwing handler rolls
 * the transaction back and surfaces the server reason (409 Conflict) to the caller.
 */
export const appointmentsCollectionOptions = collectionOptions('appointments', (client) => {
  const queryClient = client.requireDependency<QueryClient>('queryClient');
  const pagers = new Map<string, CursorPager<Appointment>>();

  function pagerFor(filter: AppointmentFilter): CursorPager<Appointment> {
    const key = `${filter.status ?? ''}|${filter.memberId ?? ''}`;
    const existing = pagers.get(key);
    if (existing) return existing;
    const pager = createCursorPager<Appointment>({
      queryClient,
      queryKey: ['appointments', 'pages', key],
      staleTime: 30_000,
      fetchPage: async (cursor, signal) => {
        const query = new URLSearchParams({ limit: String(APPOINTMENTS_PAGE_SIZE) });
        if (filter.status) query.set('status', filter.status);
        if (filter.memberId) query.set('memberId', filter.memberId);
        if (cursor) query.set('cursor', cursor);
        const page = await apiGet(`/api/appointments?${query.toString()}`, appointmentsPageSchema, {
          signal,
        });
        return { rows: page.items, nextCursor: page.nextCursor ?? null };
      },
    });
    pagers.set(key, pager);
    return pager;
  }

  return queryCollectionOptions({
    queryClient,
    queryKey: ['appointments', 'rows'],
    schema: appointmentSchema,
    getKey: (appointment) => appointment.id,
    syncMode: 'on-demand',
    queryFn: async (ctx) => {
      const subset = ctx.meta?.loadSubsetOptions;
      const comparisons = extractSimpleComparisons(subset?.where);
      const idFilter = comparisons.find(
        (comparison) => comparison.operator === 'eq' && comparison.field.join('.') === 'id',
      );
      if (idFilter) {
        const id = idFilter.value as string;
        try {
          return [
            await apiGet(`/api/appointments/${id}`, appointmentSchema, { signal: ctx.signal }),
          ];
        } catch (error) {
          // A missing appointment is an empty subset, not a sync failure.
          if ((error as { status?: number }).status === 404) return [];
          throw error;
        }
      }
      const statusFilter = comparisons.find(
        (comparison) => comparison.operator === 'eq' && comparison.field.join('.') === 'status',
      );
      const memberFilter = comparisons.find(
        (comparison) => comparison.operator === 'eq' && comparison.field.join('.') === 'memberId',
      );
      const pager = pagerFor({
        status: statusFilter?.value as AppointmentStatus | undefined,
        memberId: memberFilter?.value as string | undefined,
      });
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
        const changes = mutation.changes;
        // A status change is a lifecycle transition; any other field is a Reschedule.
        const confirmed =
          'status' in changes
            ? await apiPost(`/api/appointments/${mutation.key}/status`, appointmentSchema, {
                status: changes.status,
              })
            : await apiPatch(`/api/appointments/${mutation.key}`, appointmentSchema, changes);
        // Confirm with server truth; without a write the optimistic state reverts.
        await collection.utils.writeUpsert(confirmed);
      }
    },
  });
});
