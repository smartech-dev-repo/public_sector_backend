import { IsString, MinLength } from 'class-validator';

export class UpdatePermissionDto {
  @IsString()
  @MinLength(1)
  description: string;
}
