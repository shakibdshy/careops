// Health conformance case (Go-T04, extended by Go-T10). Status, the shared
// service identity, and the backend implementation are asserted here —
// dependency keys are implementation-specific (the reference reports
// mongo/redis, the replica reports postgres), and each backend's own health
// checks plus the deploy smoke cover those.
import { describe, expect, it } from 'bun:test';
import { ledgerProbe, BASE_URL } from './helpers.js';

describe('health (conformance)', () => {
  const AREA = 'health';

  it('reports ok with the shared service identity and its implementation', async () => {
    await ledgerProbe(AREA, async () => {
      const res = await fetch(`${BASE_URL}/api/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status?: string;
        service?: string;
        implementation?: string;
      };
      expect(body.status).toBe('ok');
      expect(body.service).toBe('careops-api');
      expect(body.implementation).toBeTruthy();
    });
  });
});
