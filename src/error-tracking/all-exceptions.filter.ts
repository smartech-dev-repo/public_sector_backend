import { ArgumentsHost, Catch, ForbiddenException, Inject } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { Request } from 'express';
import { ERROR_TRACKING_PROVIDER, ErrorTrackingProvider } from './error-tracking-provider.interface';
import { AuditLogService } from '../audit/audit-log.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { getRequestMetadata } from '../common/request-metadata.util';
import { AuditActorType } from '../generated/prisma/client';

const PRINCIPAL_ACTOR_TYPES: Record<string, AuditActorType> = {
  admin: AuditActorType.ADMIN,
  agent: AuditActorType.AGENT,
  client: AuditActorType.CLIENT,
};

@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  constructor(
    httpAdapterHost: HttpAdapterHost,
    @Inject(ERROR_TRACKING_PROVIDER) private readonly errorTrackingProvider: ErrorTrackingProvider,
    private readonly auditLogService: AuditLogService,
  ) {
    super(httpAdapterHost.httpAdapter);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const error = exception instanceof Error ? exception : new Error(String(exception));

    this.errorTrackingProvider.captureException(error, {
      path: request?.path ?? request?.url,
      method: request?.method,
    });

    // Permission checks run before any interceptor, so this is the one place that sees them.
    if (exception instanceof ForbiddenException && request?.user) {
      void this.auditLogService.recordSafely({
        actorType: PRINCIPAL_ACTOR_TYPES[request.user.type] ?? AuditActorType.SYSTEM,
        actorId: request.user.sub,
        action: 'access.denied',
        metadata: { method: request.method, route: request.route?.path ?? request.path, error: exception.message },
        ...getRequestMetadata(request),
      });
    }

    super.catch(exception, host);
  }
}
