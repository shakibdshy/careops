import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { healthResponseSchema } from '@careops/shared';

export const Route = createFileRoute('/')({ component: Home });

type HealthState =
  | { kind: 'checking' }
  | { kind: 'ok'; status: string; service: string }
  | { kind: 'error'; message: string };

function Home() {
  const [health, setHealth] = useState<HealthState>({ kind: 'checking' });

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json() as unknown)
      .then((body) => {
        const parsed = healthResponseSchema.safeParse(body);
        if (parsed.success) {
          setHealth({ kind: 'ok', status: parsed.data.status, service: parsed.data.service });
        } else {
          setHealth({ kind: 'error', message: 'API response failed contract validation' });
        }
      })
      .catch(() => setHealth({ kind: 'error', message: 'API unreachable' }));
  }, []);

  return (
    <div className="p-8">
      <h1 className="text-4xl font-bold">CareOps</h1>
      <p className="mt-4 text-lg">
        {health.kind === 'checking' && <span className="text-gray-500">Checking API…</span>}
        {health.kind === 'ok' && (
          <span className="text-green-600" data-testid="health-ok">
            API healthy: {health.service} reports {health.status}
          </span>
        )}
        {health.kind === 'error' && (
          <span className="text-red-600" data-testid="health-error">
            API error: {health.message}
          </span>
        )}
      </p>
    </div>
  );
}
