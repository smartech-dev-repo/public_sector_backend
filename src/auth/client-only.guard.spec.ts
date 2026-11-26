import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ClientOnlyGuard } from './client-only.guard';

function contextWithUser(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('ClientOnlyGuard', () => {
  const guard = new ClientOnlyGuard();

  it('allows a client-type principal', () => {
    expect(guard.canActivate(contextWithUser({ type: 'client', sub: 'c1' }))).toBe(true);
  });

  it('rejects a non-client principal', () => {
    expect(() => guard.canActivate(contextWithUser({ type: 'admin', sub: 'a1' }))).toThrow(ForbiddenException);
  });

  it('rejects when there is no user on the request', () => {
    expect(() => guard.canActivate(contextWithUser(undefined))).toThrow(ForbiddenException);
  });
});
