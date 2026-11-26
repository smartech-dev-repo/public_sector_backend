import { Injectable, Logger } from '@nestjs/common';
import { ErrorTrackingProvider } from './error-tracking-provider.interface';

@Injectable()
export class NoOpErrorTrackingProvider implements ErrorTrackingProvider {
  private readonly logger = new Logger(NoOpErrorTrackingProvider.name);

  captureException(error: Error, context?: Record<string, unknown>): void {
    this.logger.warn(`[error-tracking] would report: ${error.message}`, context);
  }
}
