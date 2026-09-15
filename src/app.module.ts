import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { AppController } from './app.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { AdminInviteModule } from './admin-invite/admin-invite.module';
import { AdminAuditLogModule } from './admin-audit-log/admin-audit-log.module';
import { AdminSessionModule } from './admin-session/admin-session.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
          },
          prefix: configService.get<string>('REDIS_KEY_PREFIX', 'bull'),
        };
      },
      inject: [ConfigService],
    }),
    PrismaModule,
    AuthModule,
    AdminModule,
    AdminInviteModule,
    AdminAuditLogModule,
    AdminSessionModule,
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
