import { useEffect, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { invitationSchema, type Invitation } from '@careops/shared';
import { CircleAlert, Loader2, MailCheck } from 'lucide-react';
import { AuthLayout } from '#/components/auth-layout';
import { Alert, AlertDescription } from '#/components/ui/alert';
import { Badge } from '#/components/ui/badge';
import { Button } from '#/components/ui/button';
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
  const [accepting, setAccepting] = useState(false);

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
    setAccepting(true);
    setAcceptError(undefined);
    const { error: acceptError } = await authClient.organization.acceptInvitation({
      invitationId,
    });
    setAccepting(false);
    if (acceptError) {
      setAcceptError(acceptError.message ?? 'Could not accept the invitation');
      return;
    }
    await navigate({ to: '/workspace' });
  }

  if (isPending || !session) {
    return (
      <AuthLayout
        title="Organization invitation"
        subtitle="Sign in first to accept this invitation."
      >
        <Button asChild className="w-full">
          <a href={`/login?redirect=${encodeURIComponent(`/invite/${invitationId}`)}`}>
            <MailCheck className="size-4" /> Sign in to continue
          </a>
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Organization invitation"
      subtitle="You've been invited to join a CareOps workspace."
    >
      <div className="grid gap-4">
        {state.kind === 'loading' && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading invitation…
          </p>
        )}
        {state.kind === 'error' && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}
        {state.kind === 'ready' && (
          <div
            data-testid="invite-details"
            className="rounded-xl border border-border bg-muted/40 p-4 text-sm leading-relaxed"
          >
            You have been invited to join as{' '}
            <Badge variant="secondary" className="mx-0.5 capitalize">
              {state.invitation.role}
            </Badge>{' '}
            (<span className="font-medium">{state.invitation.email}</span>).
          </div>
        )}
        {acceptError && (
          <Alert variant="destructive" data-testid="accept-error">
            <CircleAlert />
            <AlertDescription>{acceptError}</AlertDescription>
          </Alert>
        )}
        {state.kind === 'ready' && (
          <Button
            onClick={() => {
              void onAccept();
            }}
            disabled={accepting}
            className="w-full"
            data-testid="accept-invitation"
          >
            {accepting && <Loader2 className="animate-spin" />}
            {accepting ? 'Joining…' : 'Accept invitation'}
          </Button>
        )}
      </div>
    </AuthLayout>
  );
}
