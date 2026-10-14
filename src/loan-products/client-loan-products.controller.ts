import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { LoanProductsService } from './loan-products.service';
import { ListClientLoanProductsQueryDto } from './dto/list-client-loan-products-query.dto';

@Controller('client/loan-products')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class ClientLoanProductsController {
  constructor(private readonly loanProductsService: LoanProductsService) {}

  @Get()
  list(@Query() query: ListClientLoanProductsQueryDto, @Req() req: { user: JwtPayload }) {
    return this.loanProductsService.listActiveForClient(req.user.sub, { page: query.page, limit: query.limit });
  }
}
