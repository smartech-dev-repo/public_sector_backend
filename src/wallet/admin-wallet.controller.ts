import { ClientInScope } from '../auth/client-scope.guard';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  OnModuleInit,
  Param,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApprovalsService } from '../approvals/approvals.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditActorType, WalletEntrySource } from '../generated/prisma/client';
import { WalletService } from './wallet.service';
import { WalletTransactionDto } from './dto/wallet-transaction.dto';
import { ListWalletEntriesQueryDto } from './dto/list-wallet-entries-query.dto';

export const WALLET_CREDIT = 'wallet.credit';
export const WALLET_DEBIT = 'wallet.debit';

@Controller('admin/clients/:clientId/wallet')
@ClientInScope('clientId')
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
      this.runApproved('credit', payload, approval.targetId, deciderId, approval.requestedById, approval.id),
    );
    this.approvalsService.register(WALLET_DEBIT, (payload, approval, deciderId) =>
      this.runApproved('debit', payload, approval.targetId, deciderId, approval.requestedById, approval.id),
    );
  }

  @Get()
  @RequirePermissions('wallets:read')
  async getWallet(@Param('clientId') clientId: string, @Query() query: ListWalletEntriesQueryDto) {
    const wallet = await this.walletService.getWallet(
      clientId,
      {
        direction: query.direction,
        actorType: query.actorType,
        source: query.source,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
    const pending = await this.approvalsService.pendingDetails(clientId, [WALLET_CREDIT, WALLET_DEBIT]);
    const pendingDebits = pending.filter((p) => p.action === WALLET_DEBIT).reduce((sum, p) => sum + p.amount, 0);
    const pendingCredits = pending.filter((p) => p.action === WALLET_CREDIT).reduce((sum, p) => sum + p.amount, 0);
    return {
      ...wallet,
      pendingRequests: pending.length,
      pending: pending.map((p) => ({ ...p, direction: p.action === WALLET_DEBIT ? 'DEBIT' : 'CREDIT' })),
      // What the balance becomes if every open request is approved.
      projectedBalance: Math.round((wallet.balance + pendingCredits - pendingDebits) * 100) / 100,
    };
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
    const balance = await this.walletService.getBalance(clientId);
    if (action === WALLET_DEBIT && dto.amount > balance + 0.005) {
      throw new UnprocessableEntityException(
        `Insufficient wallet balance: the wallet holds ₦${balance.toLocaleString('en-NG')}`,
      );
    }
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
    approvalId: string,
  ) {
    const amount = Number(payload.amount);
    const description = String(payload.description);
    const balanceBefore = await this.walletService.getBalance(clientId);
    await this.walletService[action](
      clientId,
      amount,
      description,
      { actorType: AuditActorType.ADMIN, actorId: deciderId },
      { source: WalletEntrySource.MANUAL, reference: approvalId },
    );
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
