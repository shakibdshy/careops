// Resolve the MongoDB driver from the API package. bun keeps workspace deps
// nested (apps/api/node_modules), so a bare `import 'mongodb'` from tools/ does
// not resolve. Anchoring createRequire at apps/api/package.json finds the same
// driver version the app ships, under both bun and node.
import { createRequire } from 'node:module';

const apiRequire = createRequire(new URL('../../apps/api/package.json', import.meta.url));

export const { MongoClient, ObjectId } = apiRequire('mongodb');
