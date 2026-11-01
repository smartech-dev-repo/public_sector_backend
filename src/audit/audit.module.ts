import { Module } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';
import { AuditInterceptor } from './audit.interceptor';
import { AuditContextInterceptor } from './audit-context.interceptor';
import { PrincipalResolverService } from '../common/principal-resolver.service';

@Module({
  providers: [AuditLogService, AuditInterceptor, AuditContextInterceptor, PrincipalResolverService],
  exports: [AuditLogService, AuditInterceptor, AuditContextInterceptor, PrincipalResolverService],
})
export class AuditModule {}
