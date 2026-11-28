import { ArgumentsHost, ForbiddenException, Logger, PayloadTooLargeException } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ErrorTrackingProvider } from './error-tracking-provider.interface';
import { AuditLogService } from '../audit/audit-log.service';
import { UploadRejectedException } from '../upload-validation/upload-rejected.exception';

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

  describe('refused uploads', () => {
    const hostFor = (request: object) => ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ArgumentsHost;
    const rejected = () =>
      new UploadRejectedException('Only JPEG or PNG files are accepted.', {
        reason: 'type-mismatch', field: 'selfie', policy: 'photo', claimedType: 'image/jpeg', detectedType: 'pdf', size: 1234,
      });
    let warn: jest.SpyInstance;

    beforeEach(() => {
      jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => jest.restoreAllMocks());

    it('logs one distinct line and records upload.rejected for a signed-in user', () => {
      const request = { method: 'POST', headers: {}, ip: '10.0.0.9', path: '/client-onboarding/face-match', route: { path: '/client-onboarding/face-match' }, user: { sub: 'client-1', type: 'client' } };

      filter.catch(rejected(), hostFor(request));

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe(
        '[upload][rejected:type-mismatch] POST /client-onboarding/face-match field=selfie policy=photo user=client:client-1 claimed=image/jpeg detected=pdf size=1234',
      );
      expect(auditLogService.recordSafely).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'CLIENT',
          actorId: 'client-1',
          action: 'upload.rejected',
          ip: '10.0.0.9',
          metadata: expect.objectContaining({ reason: 'type-mismatch', field: 'selfie', claimedType: 'image/jpeg', detectedType: 'pdf', size: 1234 }),
        }),
      );
    });

    it('records an anonymous applicant as SYSTEM, keeping the IP', () => {
      filter.catch(rejected(), hostFor({ method: 'POST', headers: {}, ip: '203.0.113.5', path: '/agent-recruitment/submit', route: { path: '/agent-recruitment/submit' } }));

      expect(warn.mock.calls[0][0]).toContain('user=anonymous');
      expect(auditLogService.recordSafely).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'SYSTEM', actorId: undefined, ip: '203.0.113.5' }));
    });

    it("records multer's size limit on a multipart upload", () => {
      const request = { method: 'POST', headers: { 'content-length': '7000000' }, ip: '10.0.0.9', path: '/admin/me/profile-image', route: { path: '/admin/me/profile-image' }, user: { sub: 'admin-1', type: 'admin' }, is: (type: string) => type === 'multipart/form-data' };

      filter.catch(new PayloadTooLargeException('File too large'), hostFor(request));

      expect(auditLogService.recordSafely).toHaveBeenCalledWith(expect.objectContaining({ action: 'upload.rejected', metadata: expect.objectContaining({ reason: 'too-large', size: 7000000 }) }));
    });

    it('leaves a non-upload 413 alone', () => {
      filter.catch(new PayloadTooLargeException(), hostFor({ method: 'POST', headers: {}, path: '/x', is: () => false }));

      expect(warn).not.toHaveBeenCalled();
      expect(auditLogService.recordSafely).not.toHaveBeenCalled();
    });
  });
});
