export const ERROR_TRACKING_PROVIDER = Symbol('ERROR_TRACKING_PROVIDER');

export interface ErrorTrackingProvider {
  captureException(error: Error, context?: Record<string, unknown>): void;
}
