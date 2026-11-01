import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards, UseInterceptors, OnModuleInit } from '@nestjs/common';
import { ApprovalsService } from '../approvals/approvals.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditActorType } from '../generated/prisma/client';
import { WalletService } from './wallet.service';
import { WalletTransactionDto } from './dto/wallet-transaction.dto';
import { ListWalletEntriesQueryDto } from './dto/list-wallet-entries-query.dto';

const WALLET_CREDIT = 'wallet.credit';
const WALLET_DEBIT = 'wallet.debit';

@Controller('admin/clients/:clientId/wallet')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminWalletController implements OnModuleInit {
  constructor(
    private readonly walletService: WalletService,
    private readonly auditLogService: AuditLogService,
    private readonly approvalsService: ApprovalsService,
  ) {}

  onModuleInit() {
    this.approvalsService.register(WALLET_CREDIT, (payload, approval, deciderId) =>
      this.runApproved('credit', payload, approval.targetId, deciderId, approval.requestedById),
    );
    this.approvalsService.register(WALLET_DEBIT, (payload, approval, deciderId) =>
      this.runApproved('debit', payload, approval.targetId, deciderId, approval.requestedById),
    );
  }

  @Get()
  @RequirePermissions('wallets:read')
  getWallet(@Param('clientId') clientId: string, @Query() query: ListWalletEntriesQueryDto) {
    return this.walletService.getWallet(
      clientId,
      {
        direction: query.direction,
        actorType: query.actorType,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }

  @Post('credit')
  @HttpCode(200)
  @RequirePermissions('wallets:manage')
  credit(@Param('clientId') clientId: string, @Body() dto: WalletTransactionDto, @Req() req: { user: JwtPayload }) {
    return this.submit(WALLET_CREDIT, 'Credit client wallet', clientId, dto, req.user.sub);
  }

  @Post('debit')
  @HttpCode(200)
  @RequirePermissions('wallets:manage')
  debit(@Param('clientId') clientId: string, @Body() dto: WalletTransactionDto, @Req() req: { user: JwtPayload }) {
    return this.submit(WALLET_DEBIT, 'Debit client wallet', clientId, dto, req.user.sub);
  }

  private async submit(action: string, title: string, clientId: string, dto: WalletTransactionDto, requestedById: string) {
    // Throws for an unknown client, so a maker can't send a request that could never run.
    await this.walletService.getBalance(clientId);
    return this.approvalsService.submit({
      action,
      requiredPermission: 'approvals:wallets',
      targetType: 'Client',
      targetId: clientId,
      summary: {
        title,
        details: [
          { label: 'Amount', value: `₦${Number(dto.amount).toLocaleString('en-NG')}` },
          { label: 'Description', value: dto.description },
        ],
        link: `/dashboard/clients/${clientId}`,
      },
      payload: { amount: dto.amount, description: dto.description },
      requestedById,
      allowParallel: true,
    });
  }

  private async runApproved(
    action: 'credit' | 'debit',
    payload: Record<string, unknown>,
    clientId: string,
    deciderId: string,
    requestedById: string,
  ) {
    const amount = Number(payload.amount);
    const description = String(payload.description);
    const balanceBefore = await this.walletService.getBalance(clientId);
    await this.walletService[action](clientId, amount, description, { actorType: AuditActorType.ADMIN, actorId: deciderId });
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: deciderId,
      action: `wallet.${action}`,
      targetType: 'Client',
      targetId: clientId,
      metadata: {
        amount,
        description,
        requestedById,
        changes: { balance: { from: balanceBefore, to: await this.walletService.getBalance(clientId) } },
      },
    });
  }
}
