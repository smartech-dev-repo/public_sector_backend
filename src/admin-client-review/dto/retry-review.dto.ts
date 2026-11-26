import { IsString, MinLength } from 'class-validator';

export class RetryReviewDto {
  @IsString()
  @MinLength(1)
  note: string;
}
