import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateSectorDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;
}
