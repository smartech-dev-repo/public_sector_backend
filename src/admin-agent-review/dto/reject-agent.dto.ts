import { IsString, MinLength } from 'class-validator';

export class RejectAgentDto {
  @IsString()
  @MinLength(1)
  reason: string;
}
