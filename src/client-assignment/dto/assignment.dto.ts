import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * Change a client's assigned agent and/or admin. Leave a field out to keep it; send null to
 * remove the assignment. The reason is required and kept in the history.
 */
export class UpdateClientAssignmentDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  agentId?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  adminId?: string | null;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}

/** Move clients from one agent to another: all of them, or just clientIds. */
export class ReassignAgentClientsDto {
  @IsUUID()
  toAgentId: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  clientIds?: string[];

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}

/** The agent identifies the client by phone or IPPIS number. */
export class AgentLinkRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  ippisNumber?: string;
}

export class AgentLinkConfirmDto {
  @IsUUID()
  requestId: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{4,8}$/, {
    message: 'code must be the digits the client received',
  })
  code: string;
}

export class AssignableQueryDto {
  /** Name, email or phone. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
