import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { JwtPayload } from './jwt-payload.interface';

@Injectable()
export class AgentCanOnboardClientsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: JwtPayload }>();
    if (!request.user?.canOnboardClients) {
      throw new ForbiddenException('Not authorized to onboard clients');
    }
    return true;
  }
}
