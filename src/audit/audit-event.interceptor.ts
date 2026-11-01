import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { AuditLogService } from './audit-log.service';
import { AUDIT_EVENT_KEY, AuditEventOptions } from './audit-event.decorator';
import { runWithRequestOrigin } from './audit-context.interceptor';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditActorType, Prisma } from '../generated/prisma/client';

interface AuditedRequest {
  method: string;
  user?: JwtPayload;
  ip?: string;
  headers: Record<string, unknown>;
  params: Record<string, unknown>;
  body?: Record<string, unknown>;
}

const ACTOR_TYPES: Record<string, AuditActorType> = {
  admin: AuditActorType.ADMIN,
  agent: AuditActorType.AGENT,
  client: AuditActorType.CLIENT,
};

const pick = (source: unknown, keys: string[] = []): Record<string, unknown> => {
  const record = (source ?? {}) as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
};

@Injectable()
export class AuditEventInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditLogService: AuditLogService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuditedRequest>();
    const options = this.reflector.get<AuditEventOptions | undefined>(AUDIT_EVENT_KEY, context.getHandler());
    if (!options) {
      return next.handle();
    }

    return runWithRequestOrigin(request, () =>
      next.handle().pipe(
        tap({
          next: (result) => void this.recordOutcome(options, request, result),
          error: (error: { status?: number }) => {
            if (request.method !== 'GET') {
              void this.recordOutcome(options, request, undefined, error?.status ?? 500);
            }
          },
        }),
      ),
    );
  }

  private recordOutcome(options: AuditEventOptions, request: AuditedRequest, result: unknown, failedStatus?: number) {
    const metadata = {
      ...pick(request.params, options.params),
      ...pick(request.body, options.body),
      ...pick(result, options.result),
      ...(failedStatus ? { status: failedStatus } : {}),
    };
    return this.auditLogService.recordSafely({
      actorType: ACTOR_TYPES[request.user?.type ?? ''] ?? AuditActorType.SYSTEM,
      actorId: request.user?.sub,
      action: failedStatus ? `${options.action}.failed` : options.action,
      targetType: options.targetType,
      targetId: this.resolveTargetId(options, request, result),
      // Round-trips Decimals and Dates into plain JSON.
      metadata: JSON.parse(JSON.stringify(metadata)) as Prisma.InputJsonObject,
    });
  }

  private resolveTargetId(options: AuditEventOptions, request: AuditedRequest, result: unknown): string | undefined {
    const source = options.targetId;
    if (source === 'self') return request.user?.sub;
    if (source && 'param' in source) return request.params[source.param] as string | undefined;
    if (source && 'result' in source) return (result as Record<string, string> | undefined)?.[source.result];
    return undefined;
  }
}
