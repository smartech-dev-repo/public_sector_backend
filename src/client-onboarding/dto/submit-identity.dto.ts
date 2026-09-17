import { IsString, Matches } from 'class-validator';

export class SubmitIdentityDto {
  @IsString()
  @Matches(/^\d{11}$/, { message: 'bvn must be an 11-digit number' })
  bvn: string;

  @IsString()
  @Matches(/^\d{11}$/, { message: 'nin must be an 11-digit number' })
  nin: string;
}
