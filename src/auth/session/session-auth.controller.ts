import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { SessionService } from '../../session/session.service';
import { TokenService } from '../token.service';
import { AdminAuthService } from '../admin/admin-auth.service';
import { AgentAuthService } from '../agent/agent-auth.service';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { JwtPayload } from '../jwt-payload.interface';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { toJwtPrincipalType, toSessionPrincipalType } from '../../session/session-principal-type.mapper';
import { SessionPrincipalType } from '../../generated/prisma/client';
import { getRequestMetadata } from '../../common/request-metadata.util';

@Controller('auth')
export class SessionAuthController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly tokenService: TokenService,
    private readonly adminAuthService: AdminAuthService,
    private readonly agentAuthService: AgentAuthService,
  ) {}

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    const result = await this.sessionService.rotate(dto.refreshToken, getRequestMetadata(req));

    const permissions =
      result.principalType === SessionPrincipalType.ADMIN
        ? await this.adminAuthService.getPermissionsForAdmin(result.principalId)
        : undefined;

    const mustChangePassword =
      result.principalType === SessionPrincipalType.AGENT
        ? await this.agentAuthService.getMustChangePasswordForAgent(result.principalId)
        : undefined;

    const payload: JwtPayload = {
      sub: result.principalId,
      type: toJwtPrincipalType(result.principalType),
      permissions,
      mustChangePassword,
    };

    return {
      accessToken: this.tokenService.signAccessToken(payload),
      refreshToken: result.refreshToken,
    };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Body() dto: RefreshTokenDto) {
    await this.sessionService.revokeByToken(dto.refreshToken);
    return { loggedOut: true };
  }

  @Post('logout-all')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async logoutAll(@Req() req: { user: JwtPayload }) {
    await this.sessionService.revokeAllForPrincipal(
      toSessionPrincipalType(req.user.type),
      req.user.sub,
      'logout_all',
    );
    return { loggedOut: true };
  }

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  listSessions(@Req() req: { user: JwtPayload }) {
    return this.sessionService.listActiveSessions(
      toSessionPrincipalType(req.user.type),
      req.user.sub,
    );
  }

  @Delete('sessions/:id')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async revokeSession(@Req() req: { user: JwtPayload }, @Param('id') id: string) {
    await this.sessionService.revokeOwnSession(
      toSessionPrincipalType(req.user.type),
      req.user.sub,
      id,
    );
    return { revoked: true };
  }
}
