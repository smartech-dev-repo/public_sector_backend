import { IsPhoneNumber, IsString, Length, MinLength } from 'class-validator';

export class SubmitRecruitmentApplicationDto {
  @IsString()
  @MinLength(1)
  fullName: string;

  @IsPhoneNumber()
  phone: string;

  @IsString()
  @MinLength(1)
  gender: string;

  @IsString()
  @MinLength(1)
  address: string;

  @IsString()
  @MinLength(1)
  city: string;

  @IsString()
  @MinLength(1)
  state: string;

  @IsString()
  @MinLength(1)
  localGovernment: string;

  @IsString()
  @Length(11, 11)
  nin: string;

  @IsString()
  @MinLength(1)
  coverLetter: string;
}
