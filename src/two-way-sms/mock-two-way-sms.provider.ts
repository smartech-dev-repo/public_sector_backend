import { Injectable, Logger } from '@nestjs/common';
import { TwoWaySmsProvider } from './two-way-sms-provider.interface';

@Injectable()
export class MockTwoWaySmsProvider implements TwoWaySmsProvider {
  private readonly logger = new Logger(MockTwoWaySmsProvider.name);

  async send(phone: string, message: string): Promise<void> {
    this.logger.log(`[mock SMS] to ${phone}: ${message}`);
  }
}
