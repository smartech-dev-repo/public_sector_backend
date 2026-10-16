import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenService } from './token.service';

interface ApplicationRequest {
  headers: Record<string, string | undefined>;
  applicationId?: string;
}

@Injectable()
export class AgentApplicationTokenGuard implements CanActivate {
  constructor(private readonly tokenService: TokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ApplicationRequest>();
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
    if (!token) {
      throw new UnauthorizedException('Missing application token');
    }

    try {
      const payload = this.tokenService.verifyAgentApplicationToken(token);
      request.applicationId = payload.sub;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired application token');
    }
  }
}
