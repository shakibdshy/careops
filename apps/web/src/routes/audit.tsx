import { useEffect, useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { auditEntriesPageSchema, workspaceMeSchema, type WorkspaceMe } from '@careops/shared';
import { apiGet } from '../lib/api';

export const Route = createFileRoute('/audit')({ component: AuditPage });

function AuditPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<WorkspaceMe>();

  useEffect(() => {
    apiGet('/api/workspace/me', workspaceMeSchema)
      .then(setMe)
      .catch(() => navigate({ to: '/login', search: { redirect: '/audit' } }));
  }, [navigate]);

  const auditQuery = useInfiniteQuery({
    queryKey: ['audit-entries'],
    queryFn: ({ pageParam }) =>
      apiGet(
        `/api/audit-entries${pageParam ? `?cursor=${pageParam}` : ''}`,
        auditEntriesPageSchema,
      ),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  if (!me) {
    return <div className="p-8">Loading…</div>;
  }

  const canBrowse = me.organization.role === 'owner' || me.organization.role === 'admin';
  if (!canBrowse) {
    return (
      <div className="p-8">
        <p className="text-red-600">Audit entries are visible to owners and admins only.</p>
        <Link to="/patients" className="underline">
          ← Patients
        </Link>
      </div>
    );
  }

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Audit Entries — {me.organization.name}</h1>
      <p className="mt-1 text-gray-600">Append-only. Newest first.</p>
      {auditQuery.isLoading && <p className="mt-6">Loading…</p>}
      {auditQuery.isError && (
        <p className="mt-6 text-red-600">{String(auditQuery.error.message)}</p>
      )}
      {auditQuery.data && (
        <ul className="mt-6 divide-y" data-testid="audit-list">
          {auditQuery.data.pages.flatMap((page) =>
            page.items.map((entry) => (
              <li key={entry.id} className="py-3" data-testid="audit-row">
                <span className="font-medium uppercase">{entry.action}</span>{' '}
                <span>
                  {entry.entity}{' '}
                  <span className="text-gray-500">{entry.entityId.slice(0, 8)}…</span>
                </span>{' '}
                by {entry.actorEmail}{' '}
                <span className="text-gray-500">{new Date(entry.at).toLocaleString()}</span>
                <div className="mt-1 text-sm">
                  <span className="text-red-700">− {JSON.stringify(entry.before)}</span>
                  <br />
                  <span className="text-green-800">+ {JSON.stringify(entry.after)}</span>
                </div>
              </li>
            )),
          )}
        </ul>
      )}
      {auditQuery.hasNextPage && (
        <button
          onClick={() => {
            void auditQuery.fetchNextPage();
          }}
          className="mt-4 rounded border p-2"
          data-testid="audit-load-more"
        >
          Load more
        </button>
      )}
    </div>
  );
}
