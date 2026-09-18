import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { RegisterAgentDto } from './dto/register-agent.dto';

const MAX_SUPPORTING_DOCUMENTS = 5;

@Injectable()
export class AgentEnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
  ) {}

  async register(
    dto: RegisterAgentDto,
    cv: Express.Multer.File,
    supportingDocuments: Express.Multer.File[],
  ) {
    const existing = await this.prisma.agent.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const agent = await this.prisma.agent.create({
      data: {
        email: dto.email,
        phone: dto.phone,
        fullName: dto.fullName,
        address: dto.address,
        cvKey: '',
      },
    });

    const cvKey = `agent-documents/${agent.id}/cv-${randomUUID()}${extname(cv.originalname)}`;
    await this.fileStorageProvider.putObject(cvKey, cv.buffer);

    const supportingDocumentKeys: string[] = [];
    for (const [index, file] of supportingDocuments.slice(0, MAX_SUPPORTING_DOCUMENTS).entries()) {
      const key = `agent-documents/${agent.id}/supporting-${index}-${randomUUID()}${extname(file.originalname)}`;
      await this.fileStorageProvider.putObject(key, file.buffer);
      supportingDocumentKeys.push(key);
    }

    return this.prisma.agent.update({
      where: { id: agent.id },
      data: { cvKey, supportingDocumentKeys },
    });
  }
}
