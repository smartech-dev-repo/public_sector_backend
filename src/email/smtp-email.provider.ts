import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';
import { EmailMessage, EmailProvider } from './email-provider.interface';
import { buildFrom } from './email-from.util';

@Injectable()
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  private transporter?: Transporter;

  constructor(private readonly configService: ConfigService) {}

  // Built lazily, on first send() -- see this file's module comment in
  // EmailModule: every concrete provider is always constructed so the
  // factory can pick one at runtime, so reading SMTP_* eagerly here would
  // break boot whenever SMTP isn't the selected provider.
  private getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = createTransport({
        host: this.configService.getOrThrow<string>('SMTP_HOST'),
        port: Number(this.configService.getOrThrow<string>('SMTP_PORT')),
        secure: this.configService.get('SMTP_SECURE') === 'true',
        auth: {
          user: this.configService.getOrThrow<string>('SMTP_USER'),
          pass: this.configService.getOrThrow<string>('SMTP_PASSWORD'),
        },
      });
    }
    return this.transporter;
  }

  async send(message: EmailMessage): Promise<void> {
    await this.getTransporter().sendMail({
      from: buildFrom(this.configService),
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  }
}
