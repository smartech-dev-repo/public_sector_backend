import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ClientProfileService } from './client-profile.service';

@Controller('client')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class ClientProfileController {
  constructor(private readonly clientProfileService: ClientProfileService) {}

  @Get('me')
  getProfile(@Req() req: { user: JwtPayload }) {
    return this.clientProfileService.getProfile(req.user.sub);
  }
}
