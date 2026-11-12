/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
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
  transformIgnorePatterns: ['/node_modules/(?!.*@nestjs)'],
  testMatch: ['**/*.spec.ts'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'json-summary'],
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/bootstrap-api.ts'],
  // 80% gate on domain services (spec week-1, widened in T7 to reports).
  // Controllers are exercised by the e2e seam (not counted here).
  coverageThreshold: {
    './src/patients/patients.service.ts': { lines: 80, branches: 80 },
    './src/appointments/appointments.service.ts': { lines: 80, branches: 80 },
    './src/audit/audit.service.ts': { lines: 80, branches: 80 },
    './src/reports/reports.service.ts': { lines: 80, branches: 80 },
    './src/notifications/notification.processor.ts': { lines: 80, branches: 80 },
    './src/config/env.ts': { lines: 80, branches: 80 },
  },
};
