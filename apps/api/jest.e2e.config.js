/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testTimeout: 120000,
  transform: {
    '^.+\\.[jt]sx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
          target: 'es2022',
        },
      },
    ],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // Transform everything, ESM-only packages included: jest's require of the
  // untransformed mongodb driver mangles its client handshake metadata
  // ("Missing required sub-document 'driver'") and server selection retries forever.
  transformIgnorePatterns: [],
  testMatch: ['**/*.e2e-spec.ts'],
};
