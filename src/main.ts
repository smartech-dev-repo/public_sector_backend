import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { getPasswordHashRounds } from './common/password-hash.util';

export function resolveCorsOrigin(): boolean | string[] {
  const raw = process.env.CORS_ORIGINS?.trim();
  if (!raw) {
    return false;
  }
  if (raw === '*') {
    return true;
  }
  return raw.split(',').map((origin) => origin.trim()).filter(Boolean);
}

async function bootstrap() {
  // Fails fast at boot, before the app accepts any traffic, if
  // PASSWORD_HASH_ROUNDS has been misconfigured to a weak value in
  // production -- a silent runtime landmine otherwise, since a weak hash
  // created while misconfigured stays weak even after the config is fixed.
  getPasswordHashRounds();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({ origin: resolveCorsOrigin() });
  await app.listen(process.env.PORT ?? 3000);
}
if (require.main === module) {
  bootstrap();
}
