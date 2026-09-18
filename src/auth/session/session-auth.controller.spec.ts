import { SessionAuthController } from './session-auth.controller';
import { SessionService } from '../../session/session.service';
import { TokenService } from '../token.service';
import { AdminAuthService } from '../admin/admin-auth.service';
import { AgentAuthService } from '../agent/agent-auth.service';
import { SessionPrincipalType } from '../../generated/prisma/client';
import { Request } from 'express';

describe('SessionAuthController', () => {
  let controller: SessionAuthController;
  let sessionService: { rotate: jest.Mock };
  let tokenService: { signAccessToken: jest.Mock };
  let adminAuthService: { getPermissionsForAdmin: jest.Mock };
  let agentAuthService: { getMustChangePasswordForAgent: jest.Mock };

  beforeEach(() => {
    sessionService = { rotate: jest.fn() };
    tokenService = { signAccessToken: jest.fn().mockReturnValue('new-access-token') };
    adminAuthService = { getPermissionsForAdmin: jest.fn().mockResolvedValue(['roles:manage']) };
    agentAuthService = { getMustChangePasswordForAgent: jest.fn().mockResolvedValue(true) };

    controller = new SessionAuthController(
      sessionService as unknown as SessionService,
      tokenService as unknown as TokenService,
      adminAuthService as unknown as AdminAuthService,
      agentAuthService as unknown as AgentAuthService,
    );
  });

  it('re-derives permissions fresh for an admin refresh, leaving mustChangePassword unset', async () => {
    sessionService.rotate.mockResolvedValue({
      principalType: SessionPrincipalType.ADMIN,
      principalId: 'admin-1',
      refreshToken: 'new-refresh',
    });

    await controller.refresh({ refreshToken: 'old-refresh' }, { headers: {} } as Request);

    expect(adminAuthService.getPermissionsForAdmin).toHaveBeenCalledWith('admin-1');
    expect(agentAuthService.getMustChangePasswordForAgent).not.toHaveBeenCalled();
    expect(tokenService.signAccessToken).toHaveBeenCalledWith({
      sub: 'admin-1',
      type: 'admin',
      permissions: ['roles:manage'],
      mustChangePassword: undefined,
    });
  });

  it('re-derives mustChangePassword fresh for an agent refresh, leaving permissions unset', async () => {
    sessionService.rotate.mockResolvedValue({
      principalType: SessionPrincipalType.AGENT,
      principalId: 'agent-1',
      refreshToken: 'new-refresh',
    });

    await controller.refresh({ refreshToken: 'old-refresh' }, { headers: {} } as Request);

    expect(agentAuthService.getMustChangePasswordForAgent).toHaveBeenCalledWith('agent-1');
    expect(adminAuthService.getPermissionsForAdmin).not.toHaveBeenCalled();
    expect(tokenService.signAccessToken).toHaveBeenCalledWith({
      sub: 'agent-1',
      type: 'agent',
      permissions: undefined,
      mustChangePassword: true,
    });
  });

  it('leaves both permissions and mustChangePassword unset for a client refresh', async () => {
    sessionService.rotate.mockResolvedValue({
      principalType: SessionPrincipalType.CLIENT,
      principalId: 'client-1',
      refreshToken: 'new-refresh',
    });

    await controller.refresh({ refreshToken: 'old-refresh' }, { headers: {} } as Request);

    expect(adminAuthService.getPermissionsForAdmin).not.toHaveBeenCalled();
    expect(agentAuthService.getMustChangePasswordForAgent).not.toHaveBeenCalled();
    expect(tokenService.signAccessToken).toHaveBeenCalledWith({
      sub: 'client-1',
      type: 'client',
      permissions: undefined,
      mustChangePassword: undefined,
    });
  });
});
