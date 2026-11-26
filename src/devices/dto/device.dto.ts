import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class RefusedDeviceReleaseRequestDto {
  /** The releaseToken from the 403 DEVICE_NOT_RECOGNISED sign-in refusal. */
  @IsString()
  @IsNotEmpty()
  releaseToken: string;

  /** e.g. "My old phone was stolen". */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class DeviceReleaseRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class PushTokenDto {
  /** The FCM registration token. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  pushToken: string;
}

/** Releasing a device always needs a reason; a proof file is optional (multipart field "proof"). */
export class ReleaseDeviceDto {
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason: string;
}

export class ListDevicesQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['AGENT', 'CLIENT'])
  principalType?: 'AGENT' | 'CLIENT';

  @IsOptional()
  @IsUUID()
  principalId?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'RELEASED'])
  status?: 'ACTIVE' | 'RELEASED';

  /** Name, phone, email or IPPIS number of the owner. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class ListReleaseRequestsQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'])
  status?: string;
}
