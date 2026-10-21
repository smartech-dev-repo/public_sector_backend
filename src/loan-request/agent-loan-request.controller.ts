import { Body, Controller, HttpCode, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AgentOnlyGuard } from '../auth/agent-only.guard';
import { AgentCanOnboardClientsGuard } from '../auth/agent-can-onboard-clients.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { PrismaService } from '../prisma/prisma.service';
import { LoanRequestService } from './loan-request.service';
import { CreateLoanRequestDto } from './dto/create-loan-request.dto';
import { ConfirmLoanRequestCodeDto } from './dto/confirm-loan-request-code.dto';

@Controller('agent/clients/:clientId/loan-requests')
@UseGuards(JwtAuthGuard, AgentOnlyGuard, AgentCanOnboardClientsGuard)
export class AgentLoanRequestController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loanRequestService: LoanRequestService,
  ) {}

  private async assertOwnsClient(clientId: string, agentId: string): Promise<void> {
    const owned = await this.prisma.client.findFirst({
      where: { id: clientId, onboarding: { onboardedByAgentId: agentId } },
      select: { id: true },
    });
    if (!owned) {
      throw new NotFoundException('Client not found');
    }
  }

  @Post()
  async create(@Param('clientId') clientId: string, @Body() dto: CreateLoanRequestDto, @Req() req: { user: JwtPayload }) {
    await this.assertOwnsClient(clientId, req.user.sub);
    return this.loanRequestService.create(clientId, dto.amount, dto.tenorMonths);
  }

  @Post('topup')
  async createTopup(@Param('clientId') clientId: string, @Body() dto: CreateLoanRequestDto, @Req() req: { user: JwtPayload }) {
    await this.assertOwnsClient(clientId, req.user.sub);
    return this.loanRequestService.createTopup(clientId, dto.amount, dto.tenorMonths);
  }

  @Post(':id/resend')
  @HttpCode(200)
  async resend(@Param('clientId') clientId: string, @Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.assertOwnsClient(clientId, req.user.sub);
    return this.loanRequestService.resend(clientId, id);
  }

  @Post(':id/confirm-code')
  @HttpCode(200)
  async confirmCode(
    @Param('clientId') clientId: string,
    @Param('id') id: string,
    @Body() dto: ConfirmLoanRequestCodeDto,
    @Req() req: { user: JwtPayload },
  ) {
    await this.assertOwnsClient(clientId, req.user.sub);
    await this.loanRequestService.confirmByCode(clientId, id, dto.code);
    return { confirmed: true };
  }
}
