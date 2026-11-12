import request from 'supertest';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { setupE2eApp } from './mongo.js';

interface OpenApiDoc {
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
}

describe('OpenAPI document (e2e)', () => {
  let app: INestApplication<App>;
  let mongo: MongoMemoryReplSet;
  let doc: OpenApiDoc;

  beforeAll(async () => {
    ({ app, mongo } = await setupE2eApp('careops-docs-test'));

    const res = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    doc = res.body as OpenApiDoc;
  });

  afterAll(async () => {
    await app.close();
    await mongo.stop();
  });

  it('documents every domain path under the /api global prefix', () => {
    const paths = Object.keys(doc.paths);
    expect(paths).toContain('/api/patients');
    expect(paths).toContain('/api/patients/{patientId}');
    expect(paths).toContain('/api/appointments');
    expect(paths).toContain('/api/appointments/{appointmentId}');
    expect(paths).toContain('/api/audit-entries');
    expect(paths).toContain('/api/organizations/current');
    expect(paths).toContain('/api/workspace/me');
    expect(paths).toContain('/api/health');
    for (const path of paths) {
      expect(path.startsWith('/api/')).toBe(true);
    }
  });

  it('documents request bodies and paginated responses from the shared schemas', () => {
    const create = doc.paths['/api/patients']!.post as {
      requestBody: { content: Record<string, { schema: unknown }> };
    };
    expect(create.requestBody).toBeDefined();

    const list = doc.paths['/api/patients']!.get as {
      responses: Record<string, { content?: Record<string, { schema: unknown }> }>;
    };
    expect(list.responses['200']?.content).toBeDefined();

    const auditList = doc.paths['/api/audit-entries']!.get as {
      responses: Record<string, { content?: Record<string, { schema: unknown }> }>;
    };
    expect(auditList.responses['200']?.content).toBeDefined();
  });

  it('documents error responses with the shared taxonomy schema', () => {
    const create = doc.paths['/api/patients']!.post as {
      responses: Record<string, { content?: Record<string, { schema: unknown }> }>;
    };
    expect(create.responses['400']?.content).toBeDefined();
    expect(create.responses['403']?.content).toBeDefined();
  });

  it('excludes test-only routes (RBAC probe)', () => {
    expect(Object.keys(doc.paths)).not.toContain('/api/workspace/admin-probe');
  });
});
