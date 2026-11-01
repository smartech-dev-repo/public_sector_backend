import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RejectRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  note: string;
}
