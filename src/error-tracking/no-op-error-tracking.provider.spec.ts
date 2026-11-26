import { NoOpErrorTrackingProvider } from './no-op-error-tracking.provider';

describe('NoOpErrorTrackingProvider', () => {
  it('does not throw when capturing an exception', () => {
    const provider = new NoOpErrorTrackingProvider();
    expect(() => provider.captureException(new Error('test'), { foo: 'bar' })).not.toThrow();
  });
});
