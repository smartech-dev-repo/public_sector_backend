import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { TokenService } from './token.service';

describe('TokenService', () => {
  let tokenService: TokenService;
  let jwtService: JwtService;
  let configService: ConfigService;

  beforeEach(() => {
    configService = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'JWT_TWO_FACTOR_PENDING_SECRET') return 'pending-secret';
        if (key === 'JWT_ACCESS_SECRET') return 'access-secret';
        throw new Error(`unexpected config key: ${key}`);
      }),
      get: jest.fn().mockReturnValue('15m'),
    } as unknown as ConfigService;
    jwtService = new JwtService({});
    tokenService = new TokenService(jwtService, configService);
  });

  describe('two-factor pending token', () => {
    it('signs a token that verifies back to the same sub', () => {
      const token = tokenService.signTwoFactorPendingToken('admin-1');
      const payload = tokenService.verifyTwoFactorPendingToken(token);
      expect(payload.sub).toBe('admin-1');
    });

    it('rejects a token signed with a different secret (e.g. a real access token)', () => {
      const accessToken = tokenService.signAccessToken({ sub: 'admin-1', type: 'admin' });
      expect(() => tokenService.verifyTwoFactorPendingToken(accessToken)).toThrow();
    });

    it('rejects an expired pending token', () => {
      const expiredToken = jwtService.sign({ sub: 'admin-1' }, { secret: 'pending-secret', expiresIn: '-10s' });
      expect(() => tokenService.verifyTwoFactorPendingToken(expiredToken)).toThrow();
    });
  });
});
