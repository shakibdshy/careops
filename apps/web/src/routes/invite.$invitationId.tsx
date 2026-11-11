import { useEffect, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { invitationSchema, type Invitation } from '@careops/shared';
import { authClient } from '../lib/auth-client';

export const Route = createFileRoute('/invite/$invitationId')({ component: InvitePage });

type InviteState =
  | { kind: 'loading' }
  | { kind: 'ready'; invitation: Invitation }
  | { kind: 'error'; message: string };

function InvitePage() {
  const { invitationId } = Route.useParams();
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();
  const [state, setState] = useState<InviteState>({ kind: 'loading' });
  const [acceptError, setAcceptError] = useState<string | undefined>();

  useEffect(() => {
    if (!session) {
      return;
    }
    fetch(`/api/organizations/invitations/${invitationId}`)
      .then(async (res) => {
        if (!res.ok) {
          setState({ kind: 'error', message: 'Invitation not found' });
          return;
        }
        const body = (await res.json()) as unknown;
        const parsed = invitationSchema.safeParse(body);
        if (parsed.success) {
          setState({ kind: 'ready', invitation: parsed.data });
        } else {
          setState({ kind: 'error', message: 'Invalid invitation data' });
        }
      })
      .catch(() => setState({ kind: 'error', message: 'Could not load the invitation' }));
  }, [invitationId, session]);

  async function onAccept() {
    setAcceptError(undefined);
    const { error: acceptError } = await authClient.organization.acceptInvitation({
      invitationId,
    });
    if (acceptError) {
      setAcceptError(acceptError.message ?? 'Could not accept the invitation');
      return;
    }
    await navigate({ to: '/workspace' });
  }

  if (isPending || !session) {
    return (
      <div className="mx-auto mt-16 max-w-sm p-6">
        <p className="mt-4">
          Please{' '}
          <a
            href={`/login?redirect=${encodeURIComponent(`/invite/${invitationId}`)}`}
            className="underline"
          >
            sign in
          </a>{' '}
          first to accept an invitation.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-16 max-w-sm p-6">
      <h1 className="text-2xl font-bold">Organization invitation</h1>
      {state.kind === 'loading' && <p className="mt-4">Loading…</p>}
      {state.kind === 'error' && <p className="mt-4 text-red-600">{state.message}</p>}
      {state.kind === 'ready' && (
        <p className="mt-4" data-testid="invite-details">
          You have been invited to join as <strong>{state.invitation.role}</strong> (
          {state.invitation.email}).
        </p>
      )}
      {acceptError && (
        <p className="mt-4 text-red-600" data-testid="accept-error">
          {acceptError}
        </p>
      )}
      {state.kind === 'ready' && (
        <button
          onClick={() => {
            void onAccept();
          }}
          className="mt-6 rounded bg-black p-2 text-white"
          data-testid="accept-invitation"
        >
          Accept invitation
        </button>
      )}
    </div>
  );
}
