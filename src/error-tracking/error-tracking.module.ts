import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { NoOpErrorTrackingProvider } from './no-op-error-tracking.provider';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ERROR_TRACKING_PROVIDER } from './error-tracking-provider.interface';

@Module({
  providers: [
    NoOpErrorTrackingProvider,
    { provide: ERROR_TRACKING_PROVIDER, useExisting: NoOpErrorTrackingProvider },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [ERROR_TRACKING_PROVIDER],
})
export class ErrorTrackingModule {}
