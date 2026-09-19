import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from './jwt-payload.interface';

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  signAccessToken(payload: JwtPayload): string {
    return this.jwtService.sign(payload, {
      secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.configService.get<string>('JWT_ACCESS_TTL', '15m'),
    });
  }

  signTwoFactorPendingToken(sub: string): string {
    return this.jwtService.sign(
      { sub },
      {
        secret: this.configService.getOrThrow<string>('JWT_TWO_FACTOR_PENDING_SECRET'),
        expiresIn: '5m',
      },
    );
  }

  verifyTwoFactorPendingToken(token: string): { sub: string } {
    return this.jwtService.verify(token, {
      secret: this.configService.getOrThrow<string>('JWT_TWO_FACTOR_PENDING_SECRET'),
    });
  }
}
