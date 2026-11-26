import { Body, Controller, Get, HttpCode, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { AuditEvent } from '../audit/audit-event.decorator';
import { AuditEventInterceptor } from '../audit/audit-event.interceptor';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { LoanRequestService } from './loan-request.service';
import { ApplyWalletToLoanDto } from './dto/apply-wallet-to-loan.dto';

@Controller('client/client-loans')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
@UseInterceptors(AuditEventInterceptor)
export class ClientLoanController {
  constructor(private readonly loanRequestService: LoanRequestService) {}

  @Get('me')
  getMyLoan(@Req() req: { user: JwtPayload }) {
    return this.loanRequestService.getMyLoan(req.user.sub);
  }

  @Post('me/apply-wallet')
  @AuditEvent({ action: 'wallet.applied_to_loan', targetType: 'Client', targetId: 'self', body: ['amount'] })
  @HttpCode(200)
  applyWalletToLoan(@Body() dto: ApplyWalletToLoanDto, @Req() req: { user: JwtPayload }) {
    return this.loanRequestService.applyWalletToLoan(req.user.sub, dto.amount);
  }
}
