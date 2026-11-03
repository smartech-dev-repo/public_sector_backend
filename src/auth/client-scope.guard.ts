import { applyDecorators, CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { assertClientInScope } from '../common/client-scope.util';
import { JwtPayload } from './jwt-payload.interface';

const CLIENT_SCOPE_PARAM = 'clientScopeParam';

/** 404s unless the client named by this route param is in the admin's record scope. */
@Injectable()
export class ClientScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const param = this.reflector.getAllAndOverride<string>(CLIENT_SCOPE_PARAM, [context.getHandler(), context.getClass()]);
    const request = context.switchToHttp().getRequest<{ params: Record<string, string>; user?: JwtPayload }>();
    // Fails closed: without a signed-in admin there is no scope to check against.
    if (!request.user) throw new UnauthorizedException();
    const clientId = param ? request.params[param] : undefined;
    if (clientId) await assertClientInScope(this.prisma, request.user, clientId);
    return true;
  }
}

/**
 * Limits a route to clients this admin may see. On a class, put it above
 * @UseGuards(JwtAuthGuard, …) so it runs after them.
 */
export const ClientInScope = (param = 'clientId') =>
  applyDecorators(SetMetadata(CLIENT_SCOPE_PARAM, param), UseGuards(ClientScopeGuard));
