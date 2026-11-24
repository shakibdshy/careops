// Health conformance case (Go-T04). Only status and service identity are
// asserted here — dependency keys are implementation-specific (the reference
// reports mongo/redis, the replica reports postgres), and each backend's own
// health checks plus the deploy smoke cover those.
import { describe, expect, it } from 'bun:test';
import { ledgerProbe, BASE_URL } from './helpers.js';

describe('health (conformance)', () => {
  const AREA = 'health';

  it('reports ok with the shared service identity', async () => {
    await ledgerProbe(AREA, async () => {
      const res = await fetch(`${BASE_URL}/api/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status?: string; service?: string };
      expect(body.status).toBe('ok');
      expect(body.service).toBe('careops-api');
    });
  });
});
