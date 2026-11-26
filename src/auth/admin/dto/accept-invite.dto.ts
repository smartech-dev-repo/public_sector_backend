import { IsString, MinLength } from 'class-validator';

export class AcceptInviteDto {
  @IsString()
  token: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  @MinLength(1)
  firstName: string;

  @IsString()
  @MinLength(1)
  lastName: string;
}
