import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditActorType } from '../generated/prisma/client';
import { WalletService } from './wallet.service';
import { WalletTransactionDto } from './dto/wallet-transaction.dto';

@Controller('admin/clients/:clientId/wallet')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminWalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions('wallets:read')
  getWallet(@Param('clientId') clientId: string) {
    return this.walletService.getWallet(clientId);
  }

  @Post('credit')
  @HttpCode(200)
  @RequirePermissions('wallets:manage')
  async credit(
    @Param('clientId') clientId: string,
    @Body() dto: WalletTransactionDto,
    @Req() req: { user: JwtPayload },
  ) {
    const entry = await this.walletService.credit(clientId, dto.amount, dto.description, {
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
    });
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'wallet.credit',
      targetType: 'Client',
      targetId: clientId,
      metadata: { amount: dto.amount, description: dto.description },
    });
    return entry;
  }

  @Post('debit')
  @HttpCode(200)
  @RequirePermissions('wallets:manage')
  async debit(
    @Param('clientId') clientId: string,
    @Body() dto: WalletTransactionDto,
    @Req() req: { user: JwtPayload },
  ) {
    const entry = await this.walletService.debit(clientId, dto.amount, dto.description, {
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
    });
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'wallet.debit',
      targetType: 'Client',
      targetId: clientId,
      metadata: { amount: dto.amount, description: dto.description },
    });
    return entry;
  }
}
