import { InternalServerErrorException } from '@nestjs/common';
import { EmailService } from './email.service';
import { EmailProvider } from './email-provider.interface';

function fakeProvider(name: string, send: jest.Mock): EmailProvider {
  return { name, send };
}

describe('EmailService', () => {
  const message = { to: 'admin@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };

  it('sends via the first provider that succeeds', async () => {
    const primarySend = jest.fn().mockResolvedValue(undefined);
    const secondarySend = jest.fn().mockResolvedValue(undefined);
    const service = new EmailService([
      fakeProvider('primary', primarySend),
      fakeProvider('secondary', secondarySend),
    ]);

    await service.send(message);

    expect(primarySend).toHaveBeenCalledWith(message);
    expect(secondarySend).not.toHaveBeenCalled();
  });

  it('falls back to the next provider when the first fails', async () => {
    const primarySend = jest.fn().mockRejectedValue(new Error('vendor down'));
    const secondarySend = jest.fn().mockResolvedValue(undefined);
    const service = new EmailService([
      fakeProvider('primary', primarySend),
      fakeProvider('secondary', secondarySend),
    ]);

    await service.send(message);

    expect(primarySend).toHaveBeenCalledTimes(1);
    expect(secondarySend).toHaveBeenCalledTimes(1);
  });

  it('throws once every provider has failed', async () => {
    const service = new EmailService([
      fakeProvider('primary', jest.fn().mockRejectedValue(new Error('A down'))),
      fakeProvider('secondary', jest.fn().mockRejectedValue(new Error('B down'))),
    ]);

    await expect(service.send(message)).rejects.toThrow(InternalServerErrorException);
  });
});
