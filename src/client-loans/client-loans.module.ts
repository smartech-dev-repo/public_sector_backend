import { Module } from '@nestjs/common';
import { ClientLoansController } from './client-loans.controller';
import { ClientLoansService } from './client-loans.service';

@Module({
  controllers: [ClientLoansController],
  providers: [ClientLoansService],
})
export class ClientLoansModule {}
