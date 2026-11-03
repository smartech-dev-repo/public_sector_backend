import { Body, Controller, HttpCode, NotFoundException, Param, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { AuditEvent } from '../audit/audit-event.decorator';
import { AuditEventInterceptor } from '../audit/audit-event.interceptor';
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
@UseInterceptors(AuditEventInterceptor)
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
  @AuditEvent({ action: 'loan-request.created', targetType: 'LoanRequest', targetId: { result: 'id' }, result: ['amount', 'tenorMonths', 'status', 'type'] })
  async create(@Param('clientId') clientId: string, @Body() dto: CreateLoanRequestDto, @Req() req: { user: JwtPayload }) {
    await this.assertOwnsClient(clientId, req.user.sub);
    return this.loanRequestService.create(clientId, dto.amount, dto.tenorMonths, req.user.sub);
  }

  @Post('topup')
  @AuditEvent({ action: 'loan-request.topup_created', targetType: 'LoanRequest', targetId: { result: 'id' }, result: ['amount', 'tenorMonths', 'status', 'type'] })
  async createTopup(@Param('clientId') clientId: string, @Body() dto: CreateLoanRequestDto, @Req() req: { user: JwtPayload }) {
    await this.assertOwnsClient(clientId, req.user.sub);
    return this.loanRequestService.createTopup(clientId, dto.amount, dto.tenorMonths, req.user.sub);
  }

  @Post(':id/resend')
  @AuditEvent({ action: 'loan-request.code_resent', targetType: 'LoanRequest', targetId: { param: 'id' } })
  @HttpCode(200)
  async resend(@Param('clientId') clientId: string, @Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.assertOwnsClient(clientId, req.user.sub);
    return this.loanRequestService.resend(clientId, id);
  }

  @Post(':id/confirm-code')
  @AuditEvent({ action: 'loan-request.code_confirmed', targetType: 'LoanRequest', targetId: { param: 'id' } })
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
