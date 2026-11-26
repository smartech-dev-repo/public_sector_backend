import { IsBoolean } from 'class-validator';

export class SetOnboardingAccessDto {
  @IsBoolean()
  canOnboardClients: boolean;
}
