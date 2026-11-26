import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { clientScope } from '../common/client-scope.util';
import { ApprovalsService } from '../approvals/approvals.service';
import { WalletService } from './wallet.service';
import { ListWalletsQueryDto } from './dto/list-wallets-query.dto';
import { ListAllWalletEntriesQueryDto } from './dto/list-wallet-entries-query.dto';
import { WALLET_CREDIT, WALLET_DEBIT } from './admin-wallet.controller';

/** Wallets across clients: who holds what, and every movement. Scoped to the admin's clients. */
@Controller('admin/wallets')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminWalletsController {
  constructor(
    private readonly walletService: WalletService,
    private readonly approvalsService: ApprovalsService,
  ) {}

  @Get()
  @RequirePermissions('wallets:read')
  async list(@Query() query: ListWalletsQueryDto, @Req() req: { user: JwtPayload }) {
    const scope = clientScope(req.user);
    const [wallets, summary] = await Promise.all([
      this.walletService.listWallets(
        { scope, search: query.search, balance: query.balance, sort: query.sort },
        { page: query.page, limit: query.limit },
      ),
      this.walletService.summary(scope, {
        from: query.periodFrom ? new Date(query.periodFrom) : undefined,
        to: query.periodTo ? new Date(query.periodTo) : undefined,
      }),
    ]);
    // Unscoped admins see every open request; scoped ones only those on wallets they can see.
    const pendingRequests = await this.approvalsService.countPendingActions(
      [WALLET_CREDIT, WALLET_DEBIT],
      scope ? await this.walletService.clientIdsInScope(scope) : undefined,
    );
    return { ...wallets, summary: { ...summary, pendingRequests } };
  }

  @Get('entries')
  @RequirePermissions('wallets:read')
  entries(@Query() query: ListAllWalletEntriesQueryDto, @Req() req: { user: JwtPayload }) {
    return this.walletService.listEntries(
      {
        scope: clientScope(req.user),
        search: query.search,
        direction: query.direction,
        actorType: query.actorType,
        source: query.source,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
}
