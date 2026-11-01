import { IsOptional, IsUUID } from 'class-validator';

export class AssignApprovalDto {
  // null hands the request back to everyone holding the approval permission.
  @IsOptional()
  @IsUUID()
  assigneeId: string | null;
}
