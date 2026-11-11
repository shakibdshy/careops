import express, { type Express } from 'express';
import type { INestApplication } from '@nestjs/common';
import { toNodeHandler } from 'better-auth/node';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { getAuth } from './auth/auth.instance.js';

/**
 * Wiring shared by the dev server and the e2e harness so both exercise the
 * same stack: BetterAuth first (it needs the raw request stream — body
 * parsers must come after it), then JSON body parsers, then Nest routes.
 * All errors funnel through the shared taxonomy filter.
 */
export function bootstrapApi(app: INestApplication): INestApplication {
  const expressInstance = app.getHttpAdapter().getInstance() as Express;

  // Mounted at the better-auth basePath (official Express pattern). Only
  // /api/auth/* enters the handler; everything else flows to Nest.
  expressInstance.use('/api/auth', toNodeHandler(getAuth()));
  expressInstance.use(express.json({ limit: '1mb' }));
  expressInstance.use(express.urlencoded({ extended: true }));

  app.useGlobalFilters(new AllExceptionsFilter());
  return app;
}
