import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import { SmtpEmailProvider } from './smtp-email.provider';

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(),
}));

function fakeConfig(values: Record<string, string>): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) {
        throw new Error(`Missing config: ${key}`);
      }
      return values[key];
    },
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe('SmtpEmailProvider', () => {
  const config = fakeConfig({
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
    SMTP_USER: 'user@example.com',
    SMTP_PASSWORD: 'secret',
    EMAIL_FROM: 'no-reply@example.com',
    EMAIL_FROM_NAME: 'Public Sector Backend',
  });
  let provider: SmtpEmailProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new SmtpEmailProvider(config);
  });

  it('builds the transporter lazily from config, only once across multiple sends', async () => {
    const sendMail = jest.fn().mockResolvedValue(undefined);
    (createTransport as jest.Mock).mockReturnValue({ sendMail });

    await provider.send({ to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>' });
    await provider.send({ to: 'b@example.com', subject: 'Hi again', html: '<p>Hi</p>' });

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'user@example.com', pass: 'secret' },
    });
  });

  it('sends with the configured from identity and the message fields', async () => {
    const sendMail = jest.fn().mockResolvedValue(undefined);
    (createTransport as jest.Mock).mockReturnValue({ sendMail });

    await provider.send({ to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' });

    expect(sendMail).toHaveBeenCalledWith({
      from: { name: 'Public Sector Backend', address: 'no-reply@example.com' },
      to: 'a@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
    });
  });

  it('propagates a sendMail rejection', async () => {
    const sendMail = jest.fn().mockRejectedValue(new Error('smtp down'));
    (createTransport as jest.Mock).mockReturnValue({ sendMail });

    await expect(
      provider.send({ to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>' }),
    ).rejects.toThrow('smtp down');
  });
});
