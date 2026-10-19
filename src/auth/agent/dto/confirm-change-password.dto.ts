import { IsString, Length } from 'class-validator';

export class ConfirmChangePasswordDto {
  @IsString()
  @Length(6, 8)
  code: string;
}
