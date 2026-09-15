import { Injectable, Logger } from '@nestjs/common';
import { EmailMessage, EmailProvider } from './email-provider.interface';

@Injectable()
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';
  private readonly logger = new Logger(ConsoleEmailProvider.name);

  async send(message: EmailMessage): Promise<void> {
    this.logger.log(`Email to ${message.to} — ${message.subject}\n${message.text ?? message.html}`);
  }
}
