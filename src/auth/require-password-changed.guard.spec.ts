import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { RequirePasswordChangedGuard } from './require-password-changed.guard';

function contextWithUser(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('RequirePasswordChangedGuard', () => {
  const guard = new RequirePasswordChangedGuard();

  it('allows a principal whose mustChangePassword is false', () => {
    expect(guard.canActivate(contextWithUser({ type: 'agent', sub: 'a1', mustChangePassword: false }))).toBe(true);
  });

  it('allows a principal with no mustChangePassword claim at all', () => {
    expect(guard.canActivate(contextWithUser({ type: 'admin', sub: 'ad1' }))).toBe(true);
  });

  it('rejects a principal whose mustChangePassword is true', () => {
    expect(() =>
      guard.canActivate(contextWithUser({ type: 'agent', sub: 'a1', mustChangePassword: true })),
    ).toThrow(ForbiddenException);
  });
});
