import { Matches } from 'class-validator';
import { LinkIppisDto } from './link-ippis.dto';

export class StaffOnboardingLookupDto extends LinkIppisDto {
  @Matches(/^(\+?234|0)?\d{10}$/, { message: 'phone must be a valid Nigerian phone number' })
  phone: string;
}
