import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sgMail from '@sendgrid/mail';
import { EmailMessage, EmailProvider } from './email-provider.interface';
import { buildFrom } from './email-from.util';

@Injectable()
export class SendGridEmailProvider implements EmailProvider {
  readonly name = 'sendgrid';
  private initialized = false;

  constructor(private readonly configService: ConfigService) {}

  // Initialized lazily, on first send() -- see SmtpEmailProvider's comment
  // for why (EmailModule always constructs every concrete provider).
  private ensureInitialized(): void {
    if (!this.initialized) {
      sgMail.setApiKey(this.configService.getOrThrow<string>('SENDGRID_API_KEY'));
      this.initialized = true;
    }
  }

  async send(message: EmailMessage): Promise<void> {
    this.ensureInitialized();
    const from = buildFrom(this.configService);
    await sgMail.send({
      from: { name: from.name, email: from.address },
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  }
}
