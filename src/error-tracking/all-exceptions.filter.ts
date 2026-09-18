import { ArgumentsHost, Catch, Inject } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { ERROR_TRACKING_PROVIDER, ErrorTrackingProvider } from './error-tracking-provider.interface';

@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  constructor(
    httpAdapterHost: HttpAdapterHost,
    @Inject(ERROR_TRACKING_PROVIDER) private readonly errorTrackingProvider: ErrorTrackingProvider,
  ) {
    super(httpAdapterHost.httpAdapter);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<{ path?: string; url?: string; method?: string }>();
    const error = exception instanceof Error ? exception : new Error(String(exception));

    this.errorTrackingProvider.captureException(error, {
      path: request?.path ?? request?.url,
      method: request?.method,
    });

    super.catch(exception, host);
  }
}
