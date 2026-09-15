import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { AuditLogService } from './audit-log.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditActorType } from '../generated/prisma/client';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface AuditableRequest {
  method: string;
  url: string;
  user?: JwtPayload;
  ip?: string;
  headers: Record<string, unknown>;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly auditLogService: AuditLogService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuditableRequest>();

    if (!MUTATING_METHODS.has(request.method)) {
      return next.handle();
    }

    return next.handle().pipe(
      tap({
        next: () => this.logBestEffort(request, 200),
        error: (error: { status?: number }) => this.logBestEffort(request, error?.status ?? 500),
      }),
    );
  }

  private logBestEffort(request: AuditableRequest, status: number): void {
    const userAgent = request.headers['user-agent'];
    // Fire-and-forget: this is the automatic *baseline* safety net (see the
    // design doc, §2.3) — it must never slow down or break the actual
    // request. Business-meaningful audit entries are written explicitly by
    // the services that produce them (see AdminInviteController, Task 8).
    this.auditLogService
      .record({
        actorType: AuditActorType.ADMIN,
        actorId: request.user?.sub,
        action: `${request.method} ${request.url} (${status})`,
        ip: request.ip,
        userAgent: typeof userAgent === 'string' ? userAgent : undefined,
      })
      .catch(() => undefined);
  }
}
