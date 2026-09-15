import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { AdminAuditLogModule } from './admin-audit-log/admin-audit-log.module';
import { AdminSessionModule } from './admin-session/admin-session.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    AdminModule,
    AdminAuditLogModule,
    AdminSessionModule,
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
