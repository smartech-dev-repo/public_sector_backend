import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { EligibilityService } from './eligibility/eligibility.service';
import { TWO_WAY_SMS_PROVIDER, TwoWaySmsProvider } from '../two-way-sms/two-way-sms-provider.interface';
import { LOAN_REQUEST_EXPIRY_QUEUE } from './loan-request-queue.constants';
import { LoanRequestStatus, ManagementChargeType } from '../generated/prisma/client';

const EXPIRY_MS = 24 * 60 * 60 * 1000;

export interface LoanRequestExpiryJobData {
  loanRequestId: string;
}

@Injectable()
export class LoanRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibilityService: EligibilityService,
    @Inject(TWO_WAY_SMS_PROVIDER) private readonly smsProvider: TwoWaySmsProvider,
    @InjectQueue(LOAN_REQUEST_EXPIRY_QUEUE) private readonly expiryQueue: Queue<LoanRequestExpiryJobData>,
  ) {}

  private confirmationMessage(amount: number): string {
    return `Reply YES to confirm your loan request of ₦${amount}`;
  }

  async create(clientId: string, amount: number, tenorMonths: number) {
    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      throw new ConflictException('Client has not completed onboarding');
    }

    const eligibility = await this.eligibilityService.check(client, onboarding.ippisRecord, amount);
    if (!eligibility.eligible) {
      throw new UnprocessableEntityException(eligibility.reason);
    }

    const termOption = await this.prisma.loanTermOption.findUnique({
      where: { agency_tenorMonths: { agency: onboarding.ippisRecord.agency, tenorMonths } },
    });
    if (!termOption || !termOption.isActive) {
      throw new UnprocessableEntityException(`No active loan term available for ${tenorMonths} months`);
    }

    const managementChargeAmount =
      termOption.managementChargeType === ManagementChargeType.PERCENTAGE
        ? (amount * Number(termOption.managementChargeValue)) / 100
        : Number(termOption.managementChargeValue);

    await this.smsProvider.send(client.phone, this.confirmationMessage(amount));

    const loanRequest = await this.prisma.loanRequest.create({
      data: {
        clientId,
        amount,
        tenorMonths,
        interestRatePercent: termOption.interestRatePercent,
        managementChargeType: termOption.managementChargeType,
        managementChargeValue: termOption.managementChargeValue,
        managementChargeApplication: termOption.managementChargeApplication,
        managementChargeAmount,
        expiresAt: new Date(Date.now() + EXPIRY_MS),
        confirmationSmsSentAt: new Date(),
      },
    });

    await this.expiryQueue.add('expire', { loanRequestId: loanRequest.id }, { delay: EXPIRY_MS });

    return loanRequest;
  }

  async resend(clientId: string, id: string) {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.clientId !== clientId) {
      throw new NotFoundException('Loan request not found');
    }
    if (loanRequest.status !== LoanRequestStatus.PENDING) {
      throw new ConflictException(`Loan request is not PENDING (currently ${loanRequest.status})`);
    }

    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    await this.smsProvider.send(client.phone, this.confirmationMessage(Number(loanRequest.amount)));

    return this.prisma.loanRequest.update({
      where: { id },
      data: { confirmationSmsSentAt: new Date() },
    });
  }

  async confirmByPhone(phone: string, message: string): Promise<void> {
    const normalized = message.trim().toLowerCase();
    if (normalized !== 'yes' && normalized !== '1') {
      return;
    }

    const client = await this.prisma.client.findUnique({ where: { phone } });
    if (!client) {
      return;
    }

    const pending = await this.prisma.loanRequest.findFirst({
      where: { clientId: client.id, status: LoanRequestStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });
    if (!pending) {
      return;
    }

    await this.prisma.loanRequest.update({
      where: { id: pending.id },
      data: { status: LoanRequestStatus.CONFIRMED, confirmedAt: new Date() },
    });
  }

  async expire(loanRequestId: string): Promise<void> {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id: loanRequestId } });
    if (!loanRequest || loanRequest.status !== LoanRequestStatus.PENDING) {
      return;
    }
    await this.prisma.loanRequest.update({
      where: { id: loanRequestId },
      data: { status: LoanRequestStatus.FAILED },
    });
  }

  async list(clientId: string) {
    return this.prisma.loanRequest.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
