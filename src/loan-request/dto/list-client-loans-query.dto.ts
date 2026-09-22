import { IsNotEmpty, IsString } from 'class-validator';

export class ListClientLoansQueryDto {
  @IsString()
  @IsNotEmpty()
  clientId: string;
}
