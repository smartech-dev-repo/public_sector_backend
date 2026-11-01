import { IsEnum, IsUUID } from 'class-validator';
import { SessionPrincipalType } from '../../generated/prisma/client';

export class RevokeUserSessionsDto {
  @IsEnum(SessionPrincipalType)
  userType: SessionPrincipalType;

  @IsUUID()
  userId: string;
}
