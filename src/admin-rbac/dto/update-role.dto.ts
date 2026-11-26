import { IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  // null unlinks the role from its department.
  @IsOptional()
  @IsUUID()
  departmentId?: string | null;
}
