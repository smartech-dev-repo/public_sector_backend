import { ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ErrorTrackingProvider } from './error-tracking-provider.interface';

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let errorTrackingProvider: { captureException: jest.Mock };
  let httpAdapterHost: { httpAdapter: unknown };

  beforeEach(() => {
    errorTrackingProvider = { captureException: jest.fn() };
    httpAdapterHost = { httpAdapter: {} };
    filter = new AllExceptionsFilter(
      httpAdapterHost as unknown as HttpAdapterHost,
      errorTrackingProvider as unknown as ErrorTrackingProvider,
    );
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
