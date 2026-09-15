import { IsEmail, IsUUID } from 'class-validator';

export class CreateInviteDto {
  @IsEmail()
  email: string;

  @IsUUID()
  roleId: string;
}
