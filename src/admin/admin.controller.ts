import { Controller, Get, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';

@Controller('admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminController {
  @Get('me')
  me(@Req() req: { user: JwtPayload }) {
    return { id: req.user.sub, type: req.user.type, permissions: req.user.permissions };
  }
}
