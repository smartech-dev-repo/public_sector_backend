import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { JwtPayload } from './jwt-payload.interface';

@Injectable()
export class AgentOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: JwtPayload }>();
    if (request.user?.type !== 'agent') {
      throw new ForbiddenException('This endpoint is only available to Agent accounts');
    }
    return true;
  }
}
