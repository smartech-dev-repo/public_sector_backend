import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { LoanTermOptionService } from './loan-terms.service';
import { ListClientLoanTermsQueryDto } from './dto/list-client-loan-terms-query.dto';

@Controller('client/loan-terms')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class ClientLoanTermsController {
  constructor(private readonly loanTermOptionService: LoanTermOptionService) {}

  @Get()
  list(@Query() query: ListClientLoanTermsQueryDto, @Req() req: { user: JwtPayload }) {
    return this.loanTermOptionService.listActiveForClient(req.user.sub, { page: query.page, limit: query.limit });
  }
}
