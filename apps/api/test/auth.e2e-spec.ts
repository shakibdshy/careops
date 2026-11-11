import request from 'supertest';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { z } from 'zod';
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import type { App } from 'supertest/types.js';
import { errorResponseSchema } from '@careops/shared';
import { AppModule } from '../src/app.module.js';
import { bootstrapApi } from '../src/bootstrap-api.js';

const signUpResponseSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
});
const workspaceMeSchema = z.object({
  user: z.object({ email: z.string(), name: z.string() }),
});

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let mongo: MongoMemoryServer;
  let agent: ReturnType<typeof request.agent>;

  const testUser = {
    name: 'Test Owner',
    email: 'owner@example.test',
    password: 'correct-horse-battery-staple',
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongo.getUri('careops-auth-test');

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    bootstrapApi(app);
    app.setGlobalPrefix('api');
    await app.init();
    agent = request.agent(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
    await mongo.stop();
  });

  it('signs up a user and starts a session', async () => {
    const res = await agent
      .post('/api/auth/sign-up/email')
      .send({ ...testUser, callbackURL: 'http://localhost:3000/workspace' })
      .expect(200);
    const parsed = signUpResponseSchema.parse(res.body);
    expect(parsed.user.email).toBe(testUser.email);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('serves the session over GET /api/workspace/me for the authenticated user', async () => {
    const res = await agent.get('/api/workspace/me').expect(200);
    const parsed = workspaceMeSchema.parse(res.body);
    expect(parsed.user.email).toBe(testUser.email);
  });

  it('rejects unauthenticated access to protected routes with the shared taxonomy', async () => {
    const res = await request(app.getHttpServer()).get('/api/workspace/me');
    expect(res.status).toBe(401);
    expect(errorResponseSchema.parse(res.body)).toMatchObject({
      statusCode: 401,
      errors: [],
    });
  });

  it('rejects bad credentials at sign-in', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/sign-in/email')
      .send({ email: testUser.email, password: 'wrong-password' })
      .expect(401);
  });

  it('signs out and the session stops being valid', async () => {
    await agent.post('/api/auth/sign-out').expect(200);
    await agent.get('/api/workspace/me').expect(401);
  });

  it('logs in again after sign-out', async () => {
    await agent.post('/api/auth/sign-in/email').send(testUser).expect(200);
    const res = await agent.get('/api/workspace/me').expect(200);
    expect(workspaceMeSchema.parse(res.body).user.email).toBe(testUser.email);
  });
});
