import { IsString, MinLength } from 'class-validator';

export class LinkIppisDto {
  @IsString()
  @MinLength(1)
  ippisNumber: string;
}
