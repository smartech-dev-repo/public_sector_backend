import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AgentApplicationTokenGuard } from './agent-application-token.guard';
import { TokenService } from './token.service';

function contextWithAuthHeader(authorization: string | undefined) {
  const request: { headers: Record<string, string | undefined>; applicationId?: string } = {
    headers: { authorization },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('AgentApplicationTokenGuard', () => {
  let tokenService: { verifyAgentApplicationToken: jest.Mock };
  let guard: AgentApplicationTokenGuard;

  beforeEach(() => {
    tokenService = { verifyAgentApplicationToken: jest.fn() };
    guard = new AgentApplicationTokenGuard(tokenService as unknown as TokenService);
  });

  it('allows a valid token and attaches applicationId to the request', () => {
    tokenService.verifyAgentApplicationToken.mockReturnValue({ sub: 'application-1' });
    const { context, request } = contextWithAuthHeader('Bearer good-token');

    expect(guard.canActivate(context)).toBe(true);
    expect(request.applicationId).toBe('application-1');
  });

  it('rejects when no Authorization header is present', () => {
    const { context } = contextWithAuthHeader(undefined);
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects when the token fails verification', () => {
    tokenService.verifyAgentApplicationToken.mockImplementation(() => {
      throw new Error('expired');
    });
    const { context } = contextWithAuthHeader('Bearer bad-token');
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});
