import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { LoanRequestService } from './loan-request.service';
import { SmsWebhookDto } from './dto/sms-webhook.dto';

// Deliberately no @UseGuards here — a real SMS vendor calls this directly
// and there's no vendor-issued credential to authenticate against yet.
// Signature verification is a deferred follow-up once a real vendor is
// chosen (see docs/superpowers/specs/2026-09-17-loan-request-workflow-design.md §4).
@Controller('webhooks/sms')
export class SmsWebhookController {
  constructor(private readonly loanRequestService: LoanRequestService) {}

  @Post('inbound')
  @HttpCode(200)
  async inbound(@Body() dto: SmsWebhookDto) {
    await this.loanRequestService.confirmByPhone(dto.phone, dto.message);
    return { received: true };
  }
}
