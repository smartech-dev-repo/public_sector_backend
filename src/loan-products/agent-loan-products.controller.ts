import { Controller, Get, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AgentOnlyGuard } from '../auth/agent-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { PrismaService } from '../prisma/prisma.service';
import { LoanProductsService } from './loan-products.service';
import { ListClientLoanProductsQueryDto } from './dto/list-client-loan-products-query.dto';

@Controller('agent/clients/:clientId/loan-products')
@UseGuards(JwtAuthGuard, AgentOnlyGuard)
export class AgentLoanProductsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loanProductsService: LoanProductsService,
  ) {}

  @Get()
  async list(
    @Param('clientId') clientId: string,
    @Query() query: ListClientLoanProductsQueryDto,
    @Req() req: { user: JwtPayload },
  ) {
    const owned = await this.prisma.client.findFirst({
      where: { id: clientId, onboarding: { onboardedByAgentId: req.user.sub } },
      select: { id: true },
    });
    if (!owned) {
      throw new NotFoundException('Client not found');
    }

    return this.loanProductsService.listEligibleForClient(
      clientId,
      { amount: query.amount },
      { page: query.page, limit: query.limit },
    );
  }
}
