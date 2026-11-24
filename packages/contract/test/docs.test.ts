// OpenAPI conformance cases (Go-T04) — ported from the reference API's docs
// e2e suite, plus one case the reference cannot check but the replica must:
// the served domain document equals the committed artifact (Go-T01), which is
// what makes the generated Go types trustworthy against a live backend.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { assertLedgerAllows, BASE_URL } from './helpers.js';

interface OpenApiDoc {
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
}

const DOMAIN_PATHS = [
  '/api/patients',
  '/api/patients/{patientId}',
  '/api/appointments',
  '/api/appointments/{appointmentId}',
  '/api/appointments/{appointmentId}/status',
  '/api/audit-entries',
  '/api/reports/daily-volume',
  '/api/reports/status-breakdown',
  '/api/reports/provider-utilization',
  '/api/reports/today',
  '/api/organizations/current',
  '/api/workspace/me',
  '/api/health',
];
const REPORT_PATHS = [
  '/api/reports/daily-volume',
  '/api/reports/status-breakdown',
  '/api/reports/provider-utilization',
  '/api/reports/today',
];

async function fetchDomainDoc(): Promise<OpenApiDoc> {
  const res = await fetch(`${BASE_URL}/api/docs-json`);
  expect(res.status).toBe(200);
  return (await res.json()) as OpenApiDoc;
}

describe('openapi document (conformance)', () => {
  const AREA = 'docs';

  it('documents every domain path under the /api global prefix', async () => {
    assertLedgerAllows(AREA);
    const doc = await fetchDomainDoc();
    const paths = Object.keys(doc.paths);
    for (const path of DOMAIN_PATHS) expect(paths).toContain(path);
    for (const path of paths) expect(path.startsWith('/api/')).toBe(true);
  });

  it('documents request bodies and paginated responses from the shared schemas', async () => {
    assertLedgerAllows(AREA);
    const doc = await fetchDomainDoc();
    const create = doc.paths['/api/patients']!.post as {
      requestBody: { content: Record<string, unknown> };
    };
    expect(create.requestBody).toBeDefined();
    for (const path of ['/api/patients', '/api/audit-entries']) {
      const list = doc.paths[path]!.get as {
        responses: Record<string, { content?: Record<string, unknown> }>;
      };
      expect(list.responses['200']?.content).toBeDefined();
    }
  });

  it('documents error responses with the shared taxonomy schema', async () => {
    assertLedgerAllows(AREA);
    const doc = await fetchDomainDoc();
    const create = doc.paths['/api/patients']!.post as {
      responses: Record<string, { content?: Record<string, unknown> }>;
    };
    expect(create.responses['400']?.content).toBeDefined();
    expect(create.responses['403']?.content).toBeDefined();
  });

  it('excludes test-only routes (the RBAC probe)', async () => {
    assertLedgerAllows(AREA);
    const doc = await fetchDomainDoc();
    expect(Object.keys(doc.paths)).not.toContain('/api/workspace/admin-probe');
  });

  it('documents typed report responses and the bounded window query', async () => {
    assertLedgerAllows(AREA);
    const doc = await fetchDomainDoc();
    for (const path of REPORT_PATHS) {
      const get = doc.paths[path]!.get as {
        responses: Record<string, { content?: Record<string, unknown> }>;
      };
      expect(get.responses['200']?.content).toBeDefined();
    }
    // The windowed reports document a 400 for a malformed days param; today
    // takes no query and is a plain range read.
    for (const path of REPORT_PATHS.slice(0, 3)) {
      const get = doc.paths[path]!.get as {
        responses: Record<string, { content?: Record<string, unknown> }>;
        parameters?: Array<{ name: string; in: string }>;
      };
      expect(get.responses['400']?.content).toBeDefined();
      expect(get.parameters?.some((param) => param.name === 'days' && param.in === 'query')).toBe(
        true,
      );
    }
  });

  it('serves the committed contract artifact, not a drifting variant', async () => {
    assertLedgerAllows(AREA);
    const committedPath = fileURLToPath(new URL('../openapi/api.json', import.meta.url));
    const committed = JSON.parse(readFileSync(committedPath, 'utf8')) as OpenApiDoc;
    const served = await fetchDomainDoc();
    expect(served).toEqual(committed);
  });
});
