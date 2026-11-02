import { IsNigerianPhone } from '../../common/is-nigerian-phone.decorator';
import { LinkIppisDto } from './link-ippis.dto';

export class StaffOnboardingLookupDto extends LinkIppisDto {
  @IsNigerianPhone()
  phone: string;
}
