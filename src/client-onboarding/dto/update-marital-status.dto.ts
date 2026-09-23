import { IsString, MinLength } from 'class-validator';

export class UpdateMaritalStatusDto {
  @IsString()
  @MinLength(1)
  maritalStatus: string;
}
