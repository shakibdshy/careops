// Defaults for the e2e harness; real values (CI service containers, local
// compose) override via the environment. MONGODB_URI is intentionally left
// unset here — the memory server URI is injected per test file.
process.env.NODE_ENV ??= 'test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-only-for-the-e2e-harness-1234567890';
