import { ConflictException } from '@nestjs/common';
import { AgentEnrollmentService } from './agent-enrollment.service';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';

describe('AgentEnrollmentService', () => {
  let service: AgentEnrollmentService;
  let prisma: { agent: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock } };
  let fileStorageProvider: { putObject: jest.Mock };

  beforeEach(() => {
    prisma = {
      agent: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    fileStorageProvider = { putObject: jest.fn().mockResolvedValue(undefined) };
    service = new AgentEnrollmentService(
      prisma as unknown as PrismaService,
      fileStorageProvider as unknown as FileStorageProvider,
    );
  });

  const dto = {
    fullName: 'Jane Agent',
    email: 'jane.agent@example.com',
    phone: '+2348012345678',
    address: '1 Example Street, Lagos',
  };
  const cv = { originalname: 'cv.pdf', buffer: Buffer.from('cv-content') } as Express.Multer.File;

  it('rejects registration when the email is already taken', async () => {
    prisma.agent.findUnique.mockResolvedValue({ id: 'existing-agent' });

    await expect(service.register(dto, cv, [])).rejects.toThrow(ConflictException);
    expect(prisma.agent.create).not.toHaveBeenCalled();
  });

  it('creates the agent, stores the cv, and stores each supporting document under a namespaced key', async () => {
    prisma.agent.findUnique.mockResolvedValue(null);
    prisma.agent.create.mockResolvedValue({ id: 'agent-1' });
    prisma.agent.update.mockResolvedValue({ id: 'agent-1', cvKey: 'stored', supportingDocumentKeys: ['stored'] });

    const supportingDocuments = [
      { originalname: 'id-card.png', buffer: Buffer.from('id-card') } as Express.Multer.File,
    ];

    await service.register(dto, cv, supportingDocuments);

    expect(prisma.agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: dto.email,
          phone: dto.phone,
          fullName: dto.fullName,
          address: dto.address,
        }),
      }),
    );
    expect(fileStorageProvider.putObject).toHaveBeenCalledTimes(2);
    expect(fileStorageProvider.putObject.mock.calls[0][0]).toContain('agent-documents/agent-1/cv-');
    expect(fileStorageProvider.putObject.mock.calls[0][0]).toContain('.pdf');
    expect(fileStorageProvider.putObject.mock.calls[1][0]).toContain('agent-documents/agent-1/supporting-0-');
    expect(fileStorageProvider.putObject.mock.calls[1][0]).toContain('.png');

    const updateCall = prisma.agent.update.mock.calls[0][0];
    expect(updateCall.where).toEqual({ id: 'agent-1' });
    expect(updateCall.data.cvKey).toContain('agent-documents/agent-1/cv-');
    expect(updateCall.data.supportingDocumentKeys).toHaveLength(1);
  });

  it('registers successfully with no supporting documents', async () => {
    prisma.agent.findUnique.mockResolvedValue(null);
    prisma.agent.create.mockResolvedValue({ id: 'agent-2' });
    prisma.agent.update.mockResolvedValue({ id: 'agent-2' });

    await service.register(dto, cv, []);

    expect(fileStorageProvider.putObject).toHaveBeenCalledTimes(1);
    const updateCall = prisma.agent.update.mock.calls[0][0];
    expect(updateCall.data.supportingDocumentKeys).toEqual([]);
  });
});
