import { Logger } from '@nestjs/common';
import { ConsoleSmsProvider } from './console-sms.provider';

describe('ConsoleSmsProvider', () => {
  it('logs the channel, phone, and message, and resolves', async () => {
    const provider = new ConsoleSmsProvider();
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await expect(provider.send('+2348000000000', 'Hello', 'dnd')).resolves.toBeUndefined();

    expect(logSpy).toHaveBeenCalledWith('[dnd] SMS to +2348000000000: Hello');
    logSpy.mockRestore();
  });
});
