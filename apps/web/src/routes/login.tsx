import { useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { authClient } from '../lib/auth-client';

export const Route = createFileRoute('/login')({
  component: Login,
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.redirect === 'string' ? { redirect: search.redirect } : {}),
  }),
});

function Login() {
  const navigate = useNavigate();
  const { redirect } = Route.useSearch();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(undefined);
    const { error: signInError } = await authClient.signIn.email({ email, password });
    setPending(false);
    if (signInError) {
      setError(signInError.message ?? 'Sign in failed');
      return;
    }
    await navigate({ to: redirect ?? '/workspace' });
  }

  return (
    <div className="mx-auto mt-16 max-w-sm p-6">
      <h1 className="text-2xl font-bold">Sign in to CareOps</h1>
      <form
        onSubmit={(e) => {
          void onSubmit(e);
        }}
        className="mt-6 flex flex-col gap-4"
      >
        <input
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded border p-2"
        />
        <input
          type="password"
          required
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded border p-2"
        />
        {error && (
          <p className="text-red-600" data-testid="login-error">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-black p-2 text-white disabled:opacity-50"
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="mt-4 text-sm text-gray-600">
        No account?{' '}
        <Link to="/signup" className="underline">
          Sign up
        </Link>
      </p>
    </div>
  );
}
