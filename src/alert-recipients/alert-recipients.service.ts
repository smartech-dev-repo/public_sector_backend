import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AlertRecipient } from '../generated/prisma/client';
import { isUniqueConstraintError } from '../common/is-unique-constraint-error.util';

export interface AlertRecipientInput {
  email?: string;
  name?: string;
  isActive?: boolean;
}

@Injectable()
export class AlertRecipientsService {
  constructor(private readonly prisma: PrismaService) {}

  list(): Promise<AlertRecipient[]> {
    return this.prisma.alertRecipient.findMany({ orderBy: { createdAt: 'asc' } });
  }

  async findById(id: string): Promise<AlertRecipient> {
    const recipient = await this.prisma.alertRecipient.findUnique({ where: { id } });
    if (!recipient) {
      throw new NotFoundException('Alert recipient not found');
    }
    return recipient;
  }

  private async save(email: string | undefined, write: () => Promise<AlertRecipient>): Promise<AlertRecipient> {
    try {
      return await write();
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`${email} is already on the list`);
      }
      throw error;
    }
  }

  create(input: AlertRecipientInput & { email: string }): Promise<AlertRecipient> {
    const email = input.email.trim().toLowerCase();
    return this.save(email, () => this.prisma.alertRecipient.create({ data: { ...input, email } }));
  }

  async update(id: string, input: AlertRecipientInput): Promise<AlertRecipient> {
    await this.findById(id);
    const email = input.email?.trim().toLowerCase();
    return this.save(email, () => this.prisma.alertRecipient.update({ where: { id }, data: { ...input, email } }));
  }

  async remove(id: string): Promise<AlertRecipient> {
    const recipient = await this.findById(id);
    await this.prisma.alertRecipient.delete({ where: { id } });
    return recipient;
  }
}
