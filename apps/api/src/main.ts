import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { bootstrapApi } from './bootstrap-api.js';
import { loadConfig } from './config/env.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  bootstrapApi(app);
  app.setGlobalPrefix('api');
  const { port } = loadConfig();
  await app.listen(port);
}
await bootstrap();
