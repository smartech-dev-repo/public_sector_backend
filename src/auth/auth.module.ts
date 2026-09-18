import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { OtpModule } from '../otp/otp.module';
import { SessionModule } from '../session/session.module';
import { AdminInviteModule } from '../admin-invite/admin-invite.module';
import { EmailModule } from '../email/email.module';
import { TokenService } from './token.service';
import { JwtStrategy } from './jwt.strategy';
import { AdminAuthController } from './admin/admin-auth.controller';
import { AdminAuthService } from './admin/admin-auth.service';
import { ClientAuthController } from './client/client-auth.controller';
import { ClientAuthService } from './client/client-auth.service';
import { AgentAuthController } from './agent/agent-auth.controller';
import { AgentAuthService } from './agent/agent-auth.service';
import { SessionAuthController } from './session/session-auth.controller';

@Module({
  imports: [PassportModule, JwtModule.register({}), OtpModule, SessionModule, AdminInviteModule, EmailModule],
  controllers: [AdminAuthController, ClientAuthController, AgentAuthController, SessionAuthController],
  providers: [
    TokenService,
    JwtStrategy,
    AdminAuthService,
    ClientAuthService,
    AgentAuthService,
  ],
  exports: [TokenService],
})
export class AuthModule {}
