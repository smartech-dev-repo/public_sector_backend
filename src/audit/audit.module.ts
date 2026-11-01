import { Module } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';
import { AuditInterceptor } from './audit.interceptor';
import { AuditContextInterceptor } from './audit-context.interceptor';
import { AuditEventInterceptor } from './audit-event.interceptor';
import { AuditAlertService } from './audit-alert.service';
import { EmailModule } from '../email/email.module';
import { PrincipalResolverService } from '../common/principal-resolver.service';

@Module({
  imports: [EmailModule],
  providers: [AuditLogService, AuditAlertService, AuditInterceptor, AuditContextInterceptor, AuditEventInterceptor, PrincipalResolverService],
  exports: [AuditLogService, AuditInterceptor, AuditContextInterceptor, AuditEventInterceptor, PrincipalResolverService],
})
export class AuditModule {}
