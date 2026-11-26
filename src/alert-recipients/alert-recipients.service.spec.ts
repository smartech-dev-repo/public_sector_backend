import { ConflictException, NotFoundException } from '@nestjs/common';
import { AlertRecipientsService } from './alert-recipients.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AlertRecipientsService', () => {
  let prisma: { alertRecipient: { findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock } };
  let service: AlertRecipientsService;

  beforeEach(() => {
    prisma = {
      alertRecipient: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    };
    service = new AlertRecipientsService(prisma as unknown as PrismaService);
  });

  it('stores emails trimmed and lower-case', async () => {
    await service.create({ email: '  Sec@Example.COM ' });
    expect(prisma.alertRecipient.create).toHaveBeenCalledWith({ data: { email: 'sec@example.com' } });
  });

  it('turns a duplicate email into a clear conflict', async () => {
    prisma.alertRecipient.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    await expect(service.create({ email: 'a@x.test' })).rejects.toThrow(ConflictException);
  });

  it('leaves the email alone when only switching a recipient off', async () => {
    prisma.alertRecipient.findUnique.mockResolvedValue({ id: 'r1' });
    await service.update('r1', { isActive: false });
    expect(prisma.alertRecipient.update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { isActive: false, email: undefined } });
  });

  it('refuses to edit or remove an unknown recipient', async () => {
    prisma.alertRecipient.findUnique.mockResolvedValue(null);
    await expect(service.update('nope', {})).rejects.toThrow(NotFoundException);
    await expect(service.remove('nope')).rejects.toThrow(NotFoundException);
  });
});
