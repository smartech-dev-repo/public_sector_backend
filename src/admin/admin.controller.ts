import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';

@Controller('admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminController {
  @Get('me')
  me(@Req() req: { user: JwtPayload }) {
    return { id: req.user.sub, type: req.user.type, permissions: req.user.permissions };
  }

  @Get('roles/ping')
  @RequirePermissions('roles:manage')
  rolesPing() {
    return { ok: true };
  }
}
