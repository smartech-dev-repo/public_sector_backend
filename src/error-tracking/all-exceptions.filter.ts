import { ArgumentsHost, Catch, ForbiddenException, Inject, Logger, PayloadTooLargeException } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { Request } from 'express';
import { ERROR_TRACKING_PROVIDER, ErrorTrackingProvider } from './error-tracking-provider.interface';
import { AuditLogService } from '../audit/audit-log.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { getRequestMetadata } from '../common/request-metadata.util';
import { AuditActorType } from '../generated/prisma/client';
import { UploadRejectedException, UploadRejectionDetails } from '../upload-validation/upload-rejected.exception';

const PRINCIPAL_ACTOR_TYPES: Record<string, AuditActorType> = {
  admin: AuditActorType.ADMIN,
  agent: AuditActorType.AGENT,
  client: AuditActorType.CLIENT,
};

@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('Upload');

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

    const upload = this.uploadRejection(exception, request);
    if (upload) this.recordUploadRejection(upload, request);

    super.catch(exception, host);
  }

  /** A file refused by ValidateUpload, or by multer's size limit on a multipart request. */
  private uploadRejection(exception: unknown, request: Request | undefined): UploadRejectionDetails | null {
    if (exception instanceof UploadRejectedException) return exception.details;
    if (exception instanceof PayloadTooLargeException && request?.is?.('multipart/form-data')) {
      return { reason: 'too-large', field: 'unknown', policy: 'multer-limit', claimedType: 'unknown', detectedType: 'unknown', size: Number(request.headers['content-length']) || 0 };
    }
    return null;
  }

  /** One distinct log line and one audit event per refused file. Never the file's content. */
  private recordUploadRejection(details: UploadRejectionDetails, request: Request & { user?: JwtPayload }): void {
    const route = request.route?.path ?? request.path;
    this.logger.warn(
      `[upload][rejected:${details.reason}] ${request.method} ${route} field=${details.field} policy=${details.policy} ` +
        `user=${request.user ? `${request.user.type}:${request.user.sub}` : 'anonymous'} claimed=${details.claimedType || '-'} ` +
        `detected=${details.detectedType} size=${details.size}`,
    );
    void this.auditLogService.recordSafely({
      actorType: (request.user ? PRINCIPAL_ACTOR_TYPES[request.user.type] : undefined) ?? AuditActorType.SYSTEM,
      actorId: request.user?.sub,
      action: 'upload.rejected',
      metadata: { method: request.method, route, ...details },
      ...getRequestMetadata(request),
    });
  }
}
