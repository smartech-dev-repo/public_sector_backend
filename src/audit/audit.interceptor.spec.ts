import { of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { AuditInterceptor } from './audit.interceptor';
import { AuditLogService } from './audit-log.service';
import { AuditActorType } from '../generated/prisma/client';

function buildContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function buildHandler(result: unknown, isError = false): CallHandler {
  return {
    handle: () => (isError ? throwError(() => result) : of(result)),
  };
}

describe('AuditInterceptor', () => {
  let auditLogService: { record: jest.Mock };
  let interceptor: AuditInterceptor;

  beforeEach(() => {
    auditLogService = { record: jest.fn().mockResolvedValue(undefined) };
    interceptor = new AuditInterceptor(auditLogService as unknown as AuditLogService);
  });

  it('passes GET requests through without logging', (done) => {
    const request = { method: 'GET', url: '/admin/me', headers: {} };
    interceptor.intercept(buildContext(request), buildHandler({ ok: true })).subscribe(() => {
      expect(auditLogService.record).not.toHaveBeenCalled();
      done();
    });
  });

  it('logs a baseline entry for a successful mutating request', (done) => {
    const request = {
      method: 'POST',
      url: '/admin/invites',
      user: { sub: 'admin-1', type: 'admin' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    interceptor.intercept(buildContext(request), buildHandler({ id: 'x' })).subscribe(() => {
      setImmediate(() => {
        expect(auditLogService.record).toHaveBeenCalledWith(
          expect.objectContaining({
            actorType: AuditActorType.ADMIN,
            actorId: 'admin-1',
            action: 'POST /admin/invites (200)',
            ip: '127.0.0.1',
            userAgent: 'jest',
          }),
        );
        done();
      });
    });
  });

  it('logs a baseline entry with the error status for a failed mutating request', (done) => {
    const request = { method: 'DELETE', url: '/admin/invites/1', headers: {} };
    interceptor
      .intercept(buildContext(request), buildHandler({ status: 403 }, true))
      .subscribe({
        error: () => {
          setImmediate(() => {
            expect(auditLogService.record).toHaveBeenCalledWith(
              expect.objectContaining({ action: 'DELETE /admin/invites/1 (403)' }),
            );
            done();
          });
        },
      });
  });
});
