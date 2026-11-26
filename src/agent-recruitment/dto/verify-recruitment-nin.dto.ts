import { IsString, Length } from 'class-validator';

export class VerifyRecruitmentNinDto {
  @IsString()
  @Length(11, 11)
  nin: string;
}
