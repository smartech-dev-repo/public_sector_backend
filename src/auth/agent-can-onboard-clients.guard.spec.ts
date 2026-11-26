import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AgentCanOnboardClientsGuard } from './agent-can-onboard-clients.guard';

function contextWithUser(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('AgentCanOnboardClientsGuard', () => {
  const guard = new AgentCanOnboardClientsGuard();

  it('allows when canOnboardClients is true', () => {
    expect(guard.canActivate(contextWithUser({ canOnboardClients: true }))).toBe(true);
  });

  it('rejects when canOnboardClients is false', () => {
    expect(() => guard.canActivate(contextWithUser({ canOnboardClients: false }))).toThrow(ForbiddenException);
  });

  it('rejects when there is no user on the request', () => {
    expect(() => guard.canActivate(contextWithUser(undefined))).toThrow(ForbiddenException);
  });
});
