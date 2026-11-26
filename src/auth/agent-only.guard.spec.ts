import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AgentOnlyGuard } from './agent-only.guard';

function contextWithUser(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('AgentOnlyGuard', () => {
  const guard = new AgentOnlyGuard();

  it('allows an agent-type principal', () => {
    expect(guard.canActivate(contextWithUser({ type: 'agent', sub: 'a1' }))).toBe(true);
  });

  it('rejects a non-agent principal', () => {
    expect(() => guard.canActivate(contextWithUser({ type: 'client', sub: 'c1' }))).toThrow(ForbiddenException);
  });

  it('rejects when there is no user on the request', () => {
    expect(() => guard.canActivate(contextWithUser(undefined))).toThrow(ForbiddenException);
  });
});
