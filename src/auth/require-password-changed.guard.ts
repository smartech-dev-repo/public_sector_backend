import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { JwtPayload } from './jwt-payload.interface';

@Injectable()
export class RequirePasswordChangedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: JwtPayload }>();
    if (request.user?.mustChangePassword === true) {
      throw new ForbiddenException('Password must be changed before this action is allowed');
    }
    return true;
  }
}
