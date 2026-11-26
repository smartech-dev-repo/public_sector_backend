import { IsEnum, IsIn, IsISO8601, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { ClientStatus } from '../../generated/prisma/client';

export class ListClientsQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(ClientStatus)
  status?: ClientStatus;

  /** Client name, phone, email, IPPIS number or ID. */
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;

  @IsOptional()
  @IsIn(['SELF', 'AGENT', 'ADMIN'])
  onboardingSource?: 'SELF' | 'AGENT' | 'ADMIN';

  @IsOptional()
  @IsUUID()
  agentId?: string;

  /** The onboarding agent's name, email or phone. */
  @IsOptional()
  @IsString()
  agent?: string;
}
