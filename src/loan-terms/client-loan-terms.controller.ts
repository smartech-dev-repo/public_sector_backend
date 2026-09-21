import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { LoanTermOptionService } from './loan-terms.service';

@Controller('client/loan-terms')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class ClientLoanTermsController {
  constructor(private readonly loanTermOptionService: LoanTermOptionService) {}

  @Get()
  list(@Req() req: { user: JwtPayload }) {
    return this.loanTermOptionService.listActiveForClient(req.user.sub);
  }
}
