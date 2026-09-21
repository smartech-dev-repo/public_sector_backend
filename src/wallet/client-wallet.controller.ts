import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { WalletService } from './wallet.service';

@Controller('client/wallet')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class ClientWalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  getWallet(@Req() req: { user: JwtPayload }) {
    return this.walletService.getWallet(req.user.sub);
  }
}
