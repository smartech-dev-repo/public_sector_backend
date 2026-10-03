import { ConfigService } from '@nestjs/config';
import * as sgMail from '@sendgrid/mail';
import { SendGridEmailProvider } from './sendgrid-email.provider';

jest.mock('@sendgrid/mail', () => ({
  setApiKey: jest.fn(),
  send: jest.fn(),
}));

function fakeConfig(values: Record<string, string>): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) {
        throw new Error(`Missing config: ${key}`);
      }
      return values[key];
    },
  } as unknown as ConfigService;
}

describe('SendGridEmailProvider', () => {
  const config = fakeConfig({
    SENDGRID_API_KEY: 'SG.test-key',
    EMAIL_FROM: 'no-reply@example.com',
    EMAIL_FROM_NAME: 'Public Sector Backend',
  });
  let provider: SendGridEmailProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new SendGridEmailProvider(config);
  });

  it('sets the API key lazily from config, only once across multiple sends', async () => {
    (sgMail.send as jest.Mock).mockResolvedValue(undefined);

    await provider.send({ to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>' });
    await provider.send({ to: 'b@example.com', subject: 'Hi again', html: '<p>Hi</p>' });

    expect(sgMail.setApiKey).toHaveBeenCalledTimes(1);
    expect(sgMail.setApiKey).toHaveBeenCalledWith('SG.test-key');
  });

  it("sends with the configured from identity mapped to SendGrid's email key, and the message fields", async () => {
    (sgMail.send as jest.Mock).mockResolvedValue(undefined);

    await provider.send({ to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' });

    expect(sgMail.send).toHaveBeenCalledWith({
      from: { name: 'Public Sector Backend', email: 'no-reply@example.com' },
      to: 'a@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
    });
  });

  it('propagates a send rejection', async () => {
    (sgMail.send as jest.Mock).mockRejectedValue(new Error('sendgrid down'));

    await expect(
      provider.send({ to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>' }),
    ).rejects.toThrow('sendgrid down');
  });
});
