import { IsISO8601, IsOptional } from 'class-validator';

export class DisbursementDateDto {
  @IsOptional()
  @IsISO8601()
  disbursedAt?: string;
}
