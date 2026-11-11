import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { healthResponseSchema, type HealthResponse } from '@careops/shared';

export const Route = createFileRoute('/')({ component: Home });

type HealthState =
  | { kind: 'checking' }
  | { kind: 'ready'; response: HealthResponse }
  | { kind: 'error'; message: string };

function HealthBadge({ response }: { response: HealthResponse }) {
  const healthy = response.status === 'ok';
  const stores = `${response.mongo === 'up' ? 'mongo up' : 'mongo down'} · ${response.redis === 'up' ? 'redis up' : 'redis down'}`;
  return (
    <span className={healthy ? 'text-green-600' : 'text-amber-600'} data-testid="health-badge">
      API {healthy ? 'healthy' : 'degraded'}: {response.service} ({stores})
    </span>
  );
}

function Home() {
  const [health, setHealth] = useState<HealthState>({ kind: 'checking' });

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json() as unknown)
      .then((body) => {
        const parsed = healthResponseSchema.safeParse(body);
        if (parsed.success) {
          setHealth({ kind: 'ready', response: parsed.data });
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
        {health.kind === 'ready' && <HealthBadge response={health.response} />}
        {health.kind === 'error' && (
          <span className="text-red-600" data-testid="health-error">
            API error: {health.message}
          </span>
        )}
      </p>
    </div>
  );
}
