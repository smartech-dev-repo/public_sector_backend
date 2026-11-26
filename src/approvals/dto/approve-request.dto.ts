import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ApproveRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
