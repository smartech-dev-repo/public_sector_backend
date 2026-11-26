import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateFaceMatchSettingsDto {
  /** Compare onboarding photos with the BVN and NIN photos. */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** Score (0-100) each of the BVN and NIN photos must reach. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  minimumScore?: number;
}
