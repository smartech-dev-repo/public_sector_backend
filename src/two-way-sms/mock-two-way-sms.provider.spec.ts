import { MockTwoWaySmsProvider } from './mock-two-way-sms.provider';

describe('MockTwoWaySmsProvider', () => {
  it('resolves without throwing', async () => {
    const provider = new MockTwoWaySmsProvider();
    await expect(provider.send('+2348000000000', 'Reply YES to confirm')).resolves.toBeUndefined();
  });
});
