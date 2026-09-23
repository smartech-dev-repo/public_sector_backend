import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IdentityLookupResult, IdentityVerificationProvider } from './identity-verification-provider.interface';

interface DojahBvnEntity {
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  phone_number1: string | null;
  image: string;
  gender: string | null;
  state_of_origin: string | null;
  lga_of_origin: string | null;
  state_of_residence: string | null;
  lga_of_residence: string | null;
  marital_status: string | null;
}

interface DojahNinEntity {
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  phone_number: string | null;
  photo: string;
  gender: string | null;
  residence_address_line_1: string | null;
  residence_town: string | null;
}

@Injectable()
export class DojahIdentityVerificationProvider implements IdentityVerificationProvider {
  readonly name = 'dojah';

  constructor(private readonly configService: ConfigService) {}

  private baseUrl(): string {
    return this.configService.get<string>('DOJAH_BASE_URL', 'https://sandbox.dojah.io');
  }

  // Credentials are read lazily (on first use), not in the constructor —
  // same reasoning as every other lazy-init provider in this codebase
  // (S3FileStorageProvider, GcsFileStorageProvider): this provider is
  // always constructed for DI purposes, but shouldn't break app startup
  // when it isn't the active provider (see identity-verification.module.ts).
  private headers(): Record<string, string> {
    return {
      AppId: this.configService.getOrThrow<string>('DOJAH_APP_ID'),
      Authorization: this.configService.getOrThrow<string>('DOJAH_SECRET_KEY'),
    };
  }

  async lookupBvn(bvn: string): Promise<IdentityLookupResult> {
    const response = await fetch(`${this.baseUrl()}/api/v1/kyc/bvn/advance?bvn=${encodeURIComponent(bvn)}`, {
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(`Dojah BVN lookup failed with status ${response.status}`);
    }
    const body = (await response.json()) as { entity: DojahBvnEntity };
    return {
      firstName: body.entity.first_name,
      lastName: body.entity.last_name,
      dateOfBirth: body.entity.date_of_birth,
      phoneNumber: body.entity.phone_number1,
      photoBase64: body.entity.image,
      gender: body.entity.gender ?? null,
      stateOfOrigin: body.entity.state_of_origin ?? null,
      lgaOfOrigin: body.entity.lga_of_origin ?? null,
      stateOfResidence: body.entity.state_of_residence ?? null,
      lgaOfResidence: body.entity.lga_of_residence ?? null,
      maritalStatus: body.entity.marital_status ?? null,
      address: null,
      city: null,
    };
  }

  async lookupNin(nin: string): Promise<IdentityLookupResult> {
    const response = await fetch(`${this.baseUrl()}/api/v1/kyc/nin/advance?nin=${encodeURIComponent(nin)}`, {
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(`Dojah NIN lookup failed with status ${response.status}`);
    }
    const body = (await response.json()) as { entity: DojahNinEntity };
    return {
      firstName: body.entity.first_name,
      lastName: body.entity.last_name,
      dateOfBirth: body.entity.date_of_birth,
      phoneNumber: body.entity.phone_number,
      photoBase64: body.entity.photo,
      gender: body.entity.gender ?? null,
      stateOfOrigin: null,
      lgaOfOrigin: null,
      stateOfResidence: null,
      lgaOfResidence: null,
      maritalStatus: null,
      address: body.entity.residence_address_line_1 ?? null,
      city: body.entity.residence_town ?? null,
    };
  }
}
