import { ArgumentsHost, ForbiddenException } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ErrorTrackingProvider } from './error-tracking-provider.interface';
import { AuditLogService } from '../audit/audit-log.service';

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let errorTrackingProvider: { captureException: jest.Mock };
  let httpAdapterHost: { httpAdapter: unknown };
  let auditLogService: { recordSafely: jest.Mock };

  beforeEach(() => {
    errorTrackingProvider = { captureException: jest.fn() };
    auditLogService = { recordSafely: jest.fn().mockResolvedValue(undefined) };
    httpAdapterHost = { httpAdapter: {} };
    filter = new AllExceptionsFilter(
      httpAdapterHost as unknown as HttpAdapterHost,
      errorTrackingProvider as unknown as ErrorTrackingProvider,
      auditLogService as unknown as AuditLogService,
    );
  });

  it('records a signed-in user being refused by a permission check', () => {
    jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
    const request = {
      method: 'GET',
      headers: {},
      ip: '10.0.0.1',
      path: '/admin/audit-logs',
      route: { path: '/admin/audit-logs' },
      user: { sub: 'admin-1', type: 'admin' },
    };
    const host = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ArgumentsHost;

    filter.catch(new ForbiddenException('Insufficient permissions'), host);

    expect(auditLogService.recordSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'access.denied',
        actorType: 'ADMIN',
        actorId: 'admin-1',
        ip: '10.0.0.1',
        metadata: { method: 'GET', route: '/admin/audit-logs', error: 'Insufficient permissions' },
      }),
    );
  });

  it('records nothing for other errors or signed-out callers', () => {
    jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
    const host = { switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }) } as unknown as ArgumentsHost;

    filter.catch(new ForbiddenException(), host);
    filter.catch(new Error('boom'), host);

    expect(auditLogService.recordSafely).not.toHaveBeenCalled();
  });

  it('reports the exception with request context, then delegates to the default handler', () => {
    const baseSpy = jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
    const error = new Error('boom');
    const host = {
      switchToHttp: () => ({ getRequest: () => ({ path: '/test/path', method: 'GET' }) }),
    } as unknown as ArgumentsHost;

    filter.catch(error, host);

    expect(errorTrackingProvider.captureException).toHaveBeenCalledWith(error, {
      path: '/test/path',
      method: 'GET',
    });
    expect(baseSpy).toHaveBeenCalledWith(error, host);

    baseSpy.mockRestore();
  });

  it('wraps a non-Error exception value into an Error before reporting', () => {
    const baseSpy = jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
    const host = {
      switchToHttp: () => ({ getRequest: () => ({ url: '/fallback-path', method: 'POST' }) }),
    } as unknown as ArgumentsHost;

    filter.catch('a plain string throw', host);

    expect(errorTrackingProvider.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      { path: '/fallback-path', method: 'POST' },
    );
    baseSpy.mockRestore();
  });
});
