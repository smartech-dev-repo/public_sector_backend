import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TokenService } from './token.service';
import { JwtStrategy } from './jwt.strategy';
import { AdminAuthController } from './admin/admin-auth.controller';
import { AdminAuthService } from './admin/admin-auth.service';

@Module({
  imports: [PassportModule, JwtModule.register({})],
  controllers: [AdminAuthController],
  providers: [TokenService, JwtStrategy, AdminAuthService],
  exports: [TokenService],
})
export class AuthModule {}
