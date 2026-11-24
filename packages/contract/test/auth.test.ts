// Auth conformance cases (Go-T04) — ported from the reference API's auth e2e
// suite. Same meanings, black-box seam: HTTP only, bodies validated against
// the shared schemas where a schema exists. Auth endpoints speak BetterAuth's
// native shapes (ADR-0004); every domain failure uses the shared taxonomy.
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { workspaceMeSchema } from '@careops/shared';
import {
  assertLedgerAllows,
  expectTaxonomy,
  parseBody,
  Session,
  sharedPassword,
} from './helpers.js';

const betterAuthErrorSchema = z.object({ code: z.string(), message: z.string() });

describe('auth (conformance)', () => {
  const AREA = 'auth';

  it('signs up a user and starts a session', async () => {
    assertLedgerAllows(AREA);
    const session = await Session.signUp('Auth Owner');
    const res = await session.me();
    expect(res.status).toBe(200);
    const me = parseBody(workspaceMeSchema, await res.json());
    expect(me.user.email).toBe(session.email);
  });

  it('serves the session over GET /api/workspace/me for the authenticated user', async () => {
    assertLedgerAllows(AREA);
    const session = await Session.signUp('Session Owner');
    const res = await session.me();
    expect(res.status).toBe(200);
    const me = parseBody(workspaceMeSchema, await res.json());
    expect(me.user.email).toBe(session.email);
  });

  it('sets an httpOnly session cookie at sign-in', async () => {
    assertLedgerAllows(AREA);
    const session = await Session.signUp('Cookie Owner');
    const res = await session.signIn(session.email, sharedPassword);
    expect(res.status).toBe(200);
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.length).toBeGreaterThan(0);
    expect(setCookies.join(';')).toMatch(/HttpOnly/i);
  });

  it('rejects unauthenticated access to protected routes with the shared taxonomy', async () => {
    assertLedgerAllows(AREA);
    const res = await Session.anonymous().me();
    const parsed = await expectTaxonomy(res, 401);
    expect(parsed.errors).toEqual([]);
  });

  it('rejects bad credentials at sign-in with the BetterAuth error contract', async () => {
    assertLedgerAllows(AREA);
    const session = await Session.signUp('Wrong Password');
    const res = await session.signIn(session.email, 'not-the-password');
    expect(res.status).toBe(401);
    const parsed = betterAuthErrorSchema.parse(await res.json());
    expect(parsed.code.length).toBeGreaterThan(0);
  });

  it('signs out and the session stops being valid', async () => {
    assertLedgerAllows(AREA);
    const session = await Session.signUp('Sign Out');
    expect((await session.signOut()).status).toBe(200);
    await expectTaxonomy(await session.me(), 401);
  });

  it('logs in again after sign-out', async () => {
    assertLedgerAllows(AREA);
    const session = await Session.signUp('Re-login');
    expect((await session.signOut()).status).toBe(200);
    const res = await session.signIn(session.email, sharedPassword);
    expect(res.status).toBe(200);
    const me = parseBody(workspaceMeSchema, await (await session.me()).json());
    expect(me.user.email).toBe(session.email);
  });
});
