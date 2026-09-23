import { ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export class AssignPermissionsBulkDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  permissionIds: string[];
}
