import { IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateAdminProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  lastName?: string;
}
