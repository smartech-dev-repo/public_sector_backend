import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { auditRequestContext } from './audit-request-context';

interface RequestOrigin {
  ip?: string;
  headers: Record<string, unknown>;
}

export function runWithRequestOrigin<T>(request: RequestOrigin, handle: () => Observable<T>): Observable<T> {
  const userAgent = request.headers['user-agent'];
  // Reuses an outer interceptor's context, so both see the same namedEventRecorded flag.
  const origin = auditRequestContext.getStore() ?? {
    ip: request.ip,
    userAgent: typeof userAgent === 'string' ? userAgent : undefined,
  };
  return new Observable<T>((subscriber) => auditRequestContext.run(origin, () => handle().subscribe(subscriber)));
}

/** Makes the request's origin available to audit events without writing a baseline row, for routes that record their own. */
@Injectable()
export class AuditContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return runWithRequestOrigin(context.switchToHttp().getRequest<RequestOrigin>(), () => next.handle());
  }
}
