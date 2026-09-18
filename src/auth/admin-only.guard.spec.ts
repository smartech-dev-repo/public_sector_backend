import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminOnlyGuard } from './admin-only.guard';

function contextWithUser(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('AdminOnlyGuard', () => {
  const guard = new AdminOnlyGuard();

  it('allows an admin-type principal', () => {
    expect(guard.canActivate(contextWithUser({ type: 'admin', sub: 'a1' }))).toBe(true);
  });

  it('rejects a non-admin principal', () => {
    expect(() => guard.canActivate(contextWithUser({ type: 'agent', sub: 'ag1' }))).toThrow(ForbiddenException);
  });

  it('rejects when there is no user on the request', () => {
    expect(() => guard.canActivate(contextWithUser(undefined))).toThrow(ForbiddenException);
  });
});
