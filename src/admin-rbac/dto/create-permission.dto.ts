import { IsString, Matches, MinLength } from 'class-validator';

export class CreatePermissionDto {
  @IsString()
  @Matches(/^[a-z0-9]+(:[a-z0-9]+)+$/, {
    message: 'key must look like resource:action (e.g. reports:export), lowercase, colon-separated',
  })
  key: string;

  @IsString()
  @MinLength(1)
  description: string;
}
