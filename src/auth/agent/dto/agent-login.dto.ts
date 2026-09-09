import { IsEmail, IsString, MinLength } from 'class-validator';

export class AgentLoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;
}
