import { IsEmail } from 'class-validator';

export class RequestRecruitmentCodeDto {
  @IsEmail()
  email: string;
}
