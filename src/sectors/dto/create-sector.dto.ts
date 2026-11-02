import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateSectorDto {
  // Excel sheet names stop at 31 characters.
  @IsString()
  @IsNotEmpty()
  @MaxLength(31)
  code: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;
}
