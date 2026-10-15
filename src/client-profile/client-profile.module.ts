import { Module } from '@nestjs/common';
import { ClientProfileController } from './client-profile.controller';
import { ClientProfileService } from './client-profile.service';

@Module({
  controllers: [ClientProfileController],
  providers: [ClientProfileService],
})
export class ClientProfileModule {}
