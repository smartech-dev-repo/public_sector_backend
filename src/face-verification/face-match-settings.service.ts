import {
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FaceMatchSettings } from '../generated/prisma/client';
import {
  FACE_VERIFICATION_PROVIDER,
  FaceVerificationProvider,
} from './face-verification-provider.interface';

export interface UpdateFaceMatchSettingsInput {
  enabled?: boolean;
  minimumScore?: number;
}

@Injectable()
export class FaceMatchSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FACE_VERIFICATION_PROVIDER)
    private readonly provider: FaceVerificationProvider,
  ) {}

  async get(): Promise<FaceMatchSettings> {
    const existing = await this.prisma.faceMatchSettings.findFirst();
    if (existing) return existing;
    return this.prisma.faceMatchSettings.create({ data: {} });
  }

  /** Settings plus whether this server can actually run the comparison. */
  async getWithEngine() {
    const [settings, engine] = await Promise.all([
      this.get(),
      this.provider.status(),
    ]);
    return {
      enabled: settings.enabled,
      minimumScore: settings.minimumScore,
      updatedAt: settings.updatedAt,
      engine,
    };
  }

  async update(
    input: UpdateFaceMatchSettingsInput,
  ): Promise<FaceMatchSettings> {
    const current = await this.get();
    if (input.enabled === true && !current.enabled) {
      const engine = await this.provider.status();
      if (!engine.available) {
        throw new UnprocessableEntityException(
          `Face comparison can't be switched on: the comparison engine isn't working on this server (${engine.detail})`,
        );
      }
    }
    return this.prisma.faceMatchSettings.update({
      where: { id: current.id },
      data: { enabled: input.enabled, minimumScore: input.minimumScore },
    });
  }
}
