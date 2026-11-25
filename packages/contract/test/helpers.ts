// Black-box conformance harness (Go-T04). The suite speaks HTTP only: it is
// parameterised by CONTRACT_BASE_URL and validates every response body against
// the shared Zod schemas. It never touches a database, a queue, or any
// backend-internal seam — the same cases must pass against the NestJS
// reference and the Go replica.
import { expect } from 'bun:test';
import { errorResponseSchema, type ErrorResponse } from '@careops/shared';
import type { z } from 'zod';

/** Which backend under test: `reference` (NestJS) or `go` (the replica). */
export const TARGET = (process.env.CONTRACT_TARGET ?? 'reference') as 'reference' | 'go';
/** Where the backend under test serves HTTP. */
export const BASE_URL = process.env.CONTRACT_BASE_URL ?? 'http://localhost:3001';

/**
 * Parity ledger (spec #59): behaviours the Go service has not implemented
 * yet, as area -> the ticket that will implement it. Against the `go`
 * target, ledgered areas run and their failures are expected — while any
 * ledgered area that PASSES is a hard failure, so the ledger can only
 * shrink honestly (remove the entry when its ticket lands). The reference
 * implements everything, so it runs every case plainly.
 */
export const LEDGER: Record<string, string> = {};

export const skipIfLedgered = (area: string): boolean => TARGET === 'go' && area in LEDGER;

/**
 * Run a case body under the ledger semantics. Unledgered areas (or the
 * reference target) just run; a ledgered area against `go` swallows its
 * failure — that is what the entry asserts — and fails loudly if it passes.
 */
export async function ledgerProbe(area: string, fn: () => Promise<void>): Promise<void> {
  if (TARGET !== 'go' || !(area in LEDGER)) {
    return fn();
  }
  try {
    await fn();
  } catch {
    return; // expected: the area is still ledgered for Go
  }
  throw new Error(
    `parity ledger stale: "${area}" passes against go — remove its LEDGER entry (${LEDGER[area]})`,
  );
}

const PASSWORD = 'correct-horse-battery-staple';
/** Browsers always send Origin; BetterAuth enforces it on state changes. */
const ORIGIN = 'http://localhost:3000';

let userCounter = 0;
export function uniqueEmail(slug: string): string {
  userCounter += 1;
  return `conf-${Date.now().toString(36)}-${userCounter}-${slug}@test.careops`;
}

/** A cookie jar over fetch — the black-box stand-in for a browser session. */
export class Session {
  private readonly cookies = new Map<string, string>();

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }

  async get(path: string): Promise<Response> {
    const res = await fetch(`${BASE_URL}${path}`, { headers: { cookie: this.cookieHeader() } });
    this.absorb(res);
    return res;
  }

  async post(path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        cookie: this.cookieHeader(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.absorb(res);
    return res;
  }

  async patch(path: string, body: unknown): Promise<Response> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        cookie: this.cookieHeader(),
      },
      body: JSON.stringify(body),
    });
    this.absorb(res);
    return res;
  }

  async delete(path: string): Promise<Response> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'DELETE',
      headers: { origin: ORIGIN, cookie: this.cookieHeader() },
    });
    this.absorb(res);
    return res;
  }

  /** The signed-up user's identity (fixed per session). */
  readonly email: string;
  readonly name: string;

  private constructor(email: string, name: string) {
    this.email = email;
    this.name = name;
  }

  /** A bare session with no cookies — the unauthenticated caller. */
  static anonymous(): Session {
    return new Session('anonymous@test.invalid', 'Anonymous');
  }

  /** Sign up a fresh user (auto-creating their Organization) and return the session. */
  static async signUp(name: string): Promise<Session> {
    const email = uniqueEmail(name.toLowerCase().replaceAll(/\s+/g, '-'));
    const session = new Session(email, name);
    const res = await session.post('/api/auth/sign-up/email', {
      name,
      email,
      password: PASSWORD,
      callbackURL: 'http://localhost:3000/workspace',
    });
    if (res.status !== 200) {
      throw new Error(`sign-up failed (${res.status}): ${await res.text()}`);
    }
    return session;
  }

  signIn = (email: string, password: string) =>
    this.post('/api/auth/sign-in/email', { email, password });
  signOut = () => this.post('/api/auth/sign-out');
  me = () => this.get('/api/workspace/me');
}

export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  return schema.parse(body);
}

/** Assert a failure response carries the shared taxonomy with the expected status. */
export async function expectTaxonomy(res: Response, status: number): Promise<ErrorResponse> {
  expect(res.status).toBe(status);
  const parsed = errorResponseSchema.parse(await res.json());
  expect(parsed.statusCode).toBe(status);
  return parsed;
}

export const sharedPassword = PASSWORD;
