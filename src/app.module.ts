import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller';
import { RequestIdInterceptor } from './observability/request-id.interceptor';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { AdminInviteModule } from './admin-invite/admin-invite.module';
import { AdminAuditLogModule } from './admin-audit-log/admin-audit-log.module';
import { AdminSessionModule } from './admin-session/admin-session.module';
import { FileStorageModule } from './file-storage/file-storage.module';
import { DocumentIngestionModule } from './document-ingestion/document-ingestion.module';
import { AdminRbacModule } from './admin-rbac/admin-rbac.module';
import { ClientOnboardingModule } from './client-onboarding/client-onboarding.module';
import { AdminClientReviewModule } from './admin-client-review/admin-client-review.module';
import { LoanRequestModule } from './loan-request/loan-request.module';
import { ClientLoansModule } from './client-loans/client-loans.module';
import { AgentEnrollmentModule } from './agent-enrollment/agent-enrollment.module';
import { AdminAgentReviewModule } from './admin-agent-review/admin-agent-review.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { AdminCatalogModule } from './admin-catalog/admin-catalog.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        pinoHttp: {
          level: configService.get<string>('LOG_LEVEL', 'info'),
          transport:
            configService.get<string>('NODE_ENV') !== 'production'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
      inject: [ConfigService],
    }),
    BullModule.forRootAsync({
      // Pass connection *options*, not a live ioredis instance -- BullMQ
      // then owns creating/closing its own connections, which is what
      // actually gets them cleaned up on app shutdown. Handing it a
      // pre-constructed Redis instance (the more obvious-looking approach)
      // leaves that instance dangling since nothing then owns closing it.
      useFactory: (configService: ConfigService) => {
        const url = new URL(configService.getOrThrow<string>('REDIS_URL'));
        return {
          connection: {
            host: url.hostname,
            port: Number(url.port) || 6379,
            username: url.username || undefined,
            password: url.password || undefined,
            maxRetriesPerRequest: null,
            // Without this, an unreachable/flaky network path leaves the
            // initial TCP connect hanging indefinitely (no error, no
            // timeout) rather than failing fast with a clear error.
            connectTimeout: 10000,
          },
          prefix: configService.get<string>('REDIS_KEY_PREFIX', 'bull'),
        };
      },
      inject: [ConfigService],
    }),
    ThrottlerModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        skipIf: () => configService.get<string>('RATE_LIMITING_ENABLED', 'true') !== 'true',
        throttlers: [
          {
            name: 'default',
            limit: Number(configService.get<string>('THROTTLE_DEFAULT_LIMIT', '100')),
            ttl: Number(configService.get<string>('THROTTLE_DEFAULT_TTL_SECONDS', '60')) * 1000,
          },
        ],
        storage: new ThrottlerStorageRedisService(configService.getOrThrow<string>('REDIS_URL')),
      }),
      inject: [ConfigService],
    }),
    PrismaModule,
    AuthModule,
    AdminModule,
    AdminInviteModule,
    AdminAuditLogModule,
    AdminSessionModule,
    FileStorageModule,
    DocumentIngestionModule,
    AdminRbacModule,
    ClientOnboardingModule,
    AdminClientReviewModule,
    LoanRequestModule,
    ClientLoansModule,
    AgentEnrollmentModule,
    AdminAgentReviewModule,
    ReconciliationModule,
    AdminCatalogModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
  ],
})
export class AppModule {}
