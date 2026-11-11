import { createAuthClient } from 'better-auth/react';

// Same-origin: the dev server proxies /api to the API, so cookies are
// first-party and no CORS is involved.
export const authClient = createAuthClient();
