import { Module } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';
import { AuditInterceptor } from './audit.interceptor';
import { PrincipalResolverService } from '../common/principal-resolver.service';

@Module({
  providers: [AuditLogService, AuditInterceptor, PrincipalResolverService],
  exports: [AuditLogService, AuditInterceptor, PrincipalResolverService],
})
export class AuditModule {}
