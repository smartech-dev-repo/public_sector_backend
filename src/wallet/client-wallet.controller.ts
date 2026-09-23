import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { WalletService } from './wallet.service';
import { ListWalletEntriesQueryDto } from './dto/list-wallet-entries-query.dto';

@Controller('client/wallet')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class ClientWalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  getWallet(@Query() query: ListWalletEntriesQueryDto, @Req() req: { user: JwtPayload }) {
    return this.walletService.getWallet(
      req.user.sub,
      {
        direction: query.direction,
        actorType: query.actorType,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
}
