import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { workspaceMeSchema, type WorkspaceMe } from '@careops/shared';
import { apiGet } from './api';

/** Current workspace membership; unauthenticated visitors go to login. */
export function useWorkspace(redirectTo: string): WorkspaceMe | undefined {
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['workspace', 'me'],
    queryFn: () => apiGet('/api/workspace/me', workspaceMeSchema),
  });

  useEffect(() => {
    if (query.isError) {
      void navigate({ to: '/login', search: { redirect: redirectTo } });
    }
  }, [query.isError, navigate, redirectTo]);

  return query.data;
}
