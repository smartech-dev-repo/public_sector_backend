import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ClientLoansService } from './client-loans.service';

@Controller('client/loans')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class ClientLoansController {
  constructor(private readonly clientLoansService: ClientLoansService) {}

  @Get()
  getDashboard(@Req() req: { user: JwtPayload }) {
    return this.clientLoansService.getDashboard(req.user.sub);
  }
}
