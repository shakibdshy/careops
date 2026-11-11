import express, { type Express } from 'express';
import type { INestApplication } from '@nestjs/common';
import type { NestApplication } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { toNodeHandler } from 'better-auth/node';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { getAuth } from './auth/auth.instance.js';

/**
 * Wiring shared by the dev server and the e2e harness so both exercise the
 * same stack: BetterAuth first (it needs the raw request stream — body
 * parsers must come after it), then JSON body parsers, then Nest routes.
 * All errors funnel through the shared taxonomy filter. The OpenAPI document
 * is generated AFTER the global prefix is applied (otherwise paths lack
 * /api) and cleaned up by nestjs-zod so the Zod DTO schemas render.
 */
export function bootstrapApi(app: INestApplication): INestApplication {
  const expressInstance = app.getHttpAdapter().getInstance() as Express;

  // Mounted at the better-auth basePath (official Express pattern). Only
  // /api/auth/* enters the handler; everything else flows to Nest.
  expressInstance.use('/api/auth', toNodeHandler(getAuth()));
  expressInstance.use(express.json({ limit: '1mb' }));
  expressInstance.use(express.urlencoded({ extended: true }));

  // Must precede SwaggerModule.createDocument — the prefix is part of the
  // documented paths.
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());

  const documentConfig = new DocumentBuilder()
    .setTitle('CareOps API')
    .setDescription(
      [
        'Multi-tenant care operations API.',
        '',
        '**Auth** — BetterAuth endpoints live under `/api/auth` and are interactive via the BetterAuth reference: GET `/api/reference` (Scalar UI). To call protected endpoints, sign in via `POST /api/auth/sign-in/email` and keep the session cookie — Try it out sends cookies same-origin.',
        '',
        '**Errors** — every failure uses the shared taxonomy `{ statusCode, message, errors[] }`.',
        '',
        '**Tenancy** — all domain data is scoped to the caller’s active Organization.',
      ].join('\n'),
    )
    .setVersion('0.1.0')
    // Relative server: requests resolve against the origin serving the UI,
    // which works both direct (:3001) and through the web proxy (:3000).
    .addServer('/', 'Current host — all paths include the /api prefix')
    .build();
  SwaggerModule.setup(
    'api/docs',
    app,
    cleanupOpenApiDoc(SwaggerModule.createDocument(app as NestApplication, documentConfig)),
    { customSiteTitle: 'CareOps API — Swagger' },
  );

  return app;
}
