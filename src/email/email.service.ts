import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { EMAIL_PROVIDERS, EmailMessage, EmailProvider } from './email-provider.interface';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(@Inject(EMAIL_PROVIDERS) private readonly providers: EmailProvider[]) {}

  async send(message: EmailMessage): Promise<void> {
    const failures: string[] = [];

    for (const provider of this.providers) {
      try {
        await provider.send(message);
        return;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Email provider "${provider.name}" failed: ${errorMessage}`);
        failures.push(`${provider.name}: ${errorMessage}`);
      }
    }

    throw new InternalServerErrorException(`All email providers failed: ${failures.join('; ')}`);
  }
}
