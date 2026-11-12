import { useEffect, useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import {
  createInvitationSchema,
  organizationCurrentSchema,
  type OrganizationCurrent,
} from '@careops/shared';
import { authClient } from '../lib/auth-client';

export const Route = createFileRoute('/workspace')({ component: Workspace });

function OrgSection() {
  const [org, setOrg] = useState<OrganizationCurrent | undefined>();
  const [email, setEmail] = useState('');
  const [inviteError, setInviteError] = useState<string | undefined>();
  const [invited, setInvited] = useState(false);

  useEffect(() => {
    fetch('/api/organizations/current')
      .then(async (res) => {
        if (!res.ok) return;
        const parsed = organizationCurrentSchema.safeParse((await res.json()) as unknown);
        if (parsed.success) setOrg(parsed.data);
      })
      .catch(() => undefined);
  }, []);

  async function onInvite(e: React.FormEvent) {
    e.preventDefault();
    const parsed = createInvitationSchema.safeParse({ email, role: 'member' });
    if (!parsed.success) {
      setInviteError('Enter a valid email');
      return;
    }
    const res = await fetch('/api/organizations/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.data),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as { message?: string } | undefined;
      setInviteError(body?.message ?? 'Could not send the invitation');
      return;
    }
    setInviteError(undefined);
    setInvited(true);
    setEmail('');
  }

  if (!org) {
    return null;
  }

  return (
    <div className="mt-10">
      <h2 className="text-xl font-semibold" data-testid="org-name">
        {org.name}
      </h2>
      <ul className="mt-3 divide-y" data-testid="org-members">
        {org.members.map((member) => (
          <li key={member.id} className="py-2">
            {member.name} ({member.email}) — <span className="text-gray-600">{member.role}</span>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          void onInvite(e);
        }}
        className="mt-6 flex gap-2"
      >
        <input
          type="email"
          placeholder="Invite by email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-64 rounded border p-2"
        />
        <button type="submit" className="rounded border p-2">
          Invite
        </button>
      </form>
      {inviteError && <p className="mt-2 text-red-600">{inviteError}</p>}
      {invited && <p className="mt-2 text-green-700">Invitation sent.</p>}
    </div>
  );
}

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
      <p className="mt-6">
        <Link to="/patients" className="underline" data-testid="nav-patients">
          Patients
        </Link>{' '}
        ·{' '}
        <Link to="/appointments" className="underline" data-testid="nav-appointments">
          Appointments
        </Link>{' '}
        ·{' '}
        <Link to="/audit" className="underline" data-testid="nav-audit">
          Audit Entries
        </Link>
      </p>
      <OrgSection />
    </div>
  );
}
