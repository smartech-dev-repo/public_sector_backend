import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';

function buildContext(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  it('allows access when the user has every required permission', () => {
    const reflector = { getAllAndOverride: () => ['agents:read'] } as unknown as Reflector;
    const guard = new PermissionsGuard(reflector);
    const context = buildContext({ type: 'admin', permissions: ['agents:read', 'agents:review'] });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('denies access when a required permission is missing', () => {
    const reflector = { getAllAndOverride: () => ['roles:manage'] } as unknown as Reflector;
    const guard = new PermissionsGuard(reflector);
    const context = buildContext({ type: 'admin', permissions: ['agents:read'] });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows access when the route declares no required permissions', () => {
    const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;
    const guard = new PermissionsGuard(reflector);
    const context = buildContext({ type: 'admin', permissions: [] });

    expect(guard.canActivate(context)).toBe(true);
  });
});
