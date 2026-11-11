import { useEffect } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { authClient } from '../lib/auth-client';

export const Route = createFileRoute('/workspace')({ component: Workspace });

function Workspace() {
  const navigate = useNavigate();
  const { data: session, isPending, error } = authClient.useSession();

  useEffect(() => {
    if (!isPending && !session) {
      void navigate({ to: '/login', search: { redirect: '/workspace' } });
    }
  }, [isPending, session, navigate]);

  if (isPending) {
    return <div className="p-8">Loading…</div>;
  }
  if (error || !session) {
    return null;
  }

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Workspace</h1>
      <p className="mt-2" data-testid="workspace-user">
        Signed in as {session.user.name} ({session.user.email})
      </p>
      <button
        onClick={() => {
          void authClient.signOut();
        }}
        className="mt-6 rounded border p-2"
        data-testid="sign-out"
      >
        Sign out
      </button>
    </div>
  );
}
