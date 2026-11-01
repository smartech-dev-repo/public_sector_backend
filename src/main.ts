import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
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

// How many reverse proxies sit in front of the API. Without this, req.ip is the
// proxy's address, so audit logs and per-IP login limits treat everyone as one
// caller. Too high a number lets a caller fake their IP, so it defaults to none.
export function resolveTrustProxyHops(): number {
  const raw = process.env.TRUST_PROXY_HOPS?.trim() || '0';
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error('TRUST_PROXY_HOPS must be a whole number of 0 or more');
  }
  return hops;
}

async function bootstrap() {
  // Fails fast at boot, before the app accepts any traffic, if
  // PASSWORD_HASH_ROUNDS has been misconfigured to a weak value in
  // production -- a silent runtime landmine otherwise, since a weak hash
  // created while misconfigured stays weak even after the config is fixed.
  getPasswordHashRounds();

  const trustProxyHops = resolveTrustProxyHops();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  if (trustProxyHops > 0) {
    app.set('trust proxy', trustProxyHops);
  }
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({ origin: resolveCorsOrigin() });
  await app.listen(process.env.PORT ?? 3000);
}
if (require.main === module) {
  bootstrap();
}
