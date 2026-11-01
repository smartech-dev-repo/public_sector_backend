import { of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditEventInterceptor } from './audit-event.interceptor';
import { AuditEventOptions } from './audit-event.decorator';
import { AuditLogService } from './audit-log.service';

const context = (request: Record<string, unknown>) =>
  ({
    getHandler: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ headers: {}, params: {}, ...request }) }),
  }) as unknown as ExecutionContext;

const respond = (value: unknown): CallHandler => ({ handle: () => of(value) });

describe('AuditEventInterceptor', () => {
  let auditLogService: { recordSafely: jest.Mock };

  const build = (options?: AuditEventOptions) =>
    new AuditEventInterceptor(
      { get: () => options } as unknown as Reflector,
      auditLogService as unknown as AuditLogService,
    );

  beforeEach(() => {
    auditLogService = { recordSafely: jest.fn().mockResolvedValue(undefined) };
  });

  it('does nothing on a route without @AuditEvent', (done) => {
    build().intercept(context({ method: 'POST' }), respond({})).subscribe(() => {
      expect(auditLogService.recordSafely).not.toHaveBeenCalled();
      done();
    });
  });

  it('stores only allow-listed fields, so a BVN in the body or response never reaches the log', (done) => {
    const request = {
      method: 'POST',
      user: { sub: 'agent-1', type: 'agent' },
      params: { clientId: 'client-1' },
      body: { bvn: '22222222222', nin: '11111111111' },
    };
    const options: AuditEventOptions = {
      action: 'client.onboarding.identity_submitted',
      targetType: 'Client',
      targetId: { param: 'clientId' },
      result: ['step'],
    };
    build(options)
      .intercept(context(request), respond({ step: 'IDENTITY_VERIFIED', bvn: '22222222222' }))
      .subscribe(() => {
        expect(auditLogService.recordSafely).toHaveBeenCalledWith({
          actorType: 'AGENT',
          actorId: 'agent-1',
          action: 'client.onboarding.identity_submitted',
          targetType: 'Client',
          targetId: 'client-1',
          metadata: { step: 'IDENTITY_VERIFIED' },
        });
        expect(JSON.stringify(auditLogService.recordSafely.mock.calls)).not.toContain('22222222222');
        done();
      });
  });

  it('records a refused change as <action>.failed with the status', (done) => {
    const handler: CallHandler = { handle: () => throwError(() => ({ status: 422 })) };
    build({ action: 'loan-request.created' })
      .intercept(context({ method: 'POST', user: { sub: 'c1', type: 'client' } }), handler)
      .subscribe({
        error: () => {
          expect(auditLogService.recordSafely).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'loan-request.created.failed', actorType: 'CLIENT', metadata: { status: 422 } }),
          );
          done();
        },
      });
  });

  it('ignores a failed read', (done) => {
    const handler: CallHandler = { handle: () => throwError(() => ({ status: 404 })) };
    build({ action: 'client.profile.viewed' })
      .intercept(context({ method: 'GET' }), handler)
      .subscribe({
        error: () => {
          expect(auditLogService.recordSafely).not.toHaveBeenCalled();
          done();
        },
      });
  });
});
