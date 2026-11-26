import { IsArray, IsUUID } from 'class-validator';

export class SetRolePermissionsDto {
  @IsArray()
  @IsUUID('4', { each: true })
  permissionIds: string[];
}
