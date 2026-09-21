import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { EligibilityService } from './eligibility/eligibility.service';
import { TWO_WAY_SMS_PROVIDER, TwoWaySmsProvider } from '../two-way-sms/two-way-sms-provider.interface';
import { LOAN_REQUEST_EXPIRY_QUEUE } from './loan-request-queue.constants';
import {
  ClientLoanStatus,
  LoanRequestStatus,
  ManagementChargeApplication,
  ManagementChargeType,
} from '../generated/prisma/client';

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
    private readonly configService?: ConfigService,
  ) {}

  private confirmationMessage(amount: number): string {
    return `Reply YES to confirm your loan request of ₦${amount}`;
  }

  private async createClientLoanFromRequest(loanRequestId: string): Promise<void> {
    const loanRequest = await this.prisma.loanRequest.findUniqueOrThrow({ where: { id: loanRequestId } });
    const onboarding = await this.prisma.clientOnboarding.findUniqueOrThrow({
      where: { clientId: loanRequest.clientId },
      include: { ippisRecord: true },
    });

    const principalAmount = Number(loanRequest.amount);
    const managementChargeAmount = Number(loanRequest.managementChargeAmount);
    const disbursedAmount =
      loanRequest.managementChargeApplication === ManagementChargeApplication.DEDUCT_FROM_DISBURSEMENT
        ? principalAmount - managementChargeAmount
        : principalAmount;

    const disbursementDate = new Date();
    const maturationDate = new Date(disbursementDate);
    maturationDate.setMonth(maturationDate.getMonth() + loanRequest.tenorMonths);

    await this.prisma.clientLoan.create({
      data: {
        clientId: loanRequest.clientId,
        loanRequestId: loanRequest.id,
        agency: onboarding.ippisRecord.agency,
        staffId: onboarding.ippisRecord.staffId,
        principalAmount,
        disbursedAmount,
        principalBalance: principalAmount,
        tenorMonths: loanRequest.tenorMonths,
        interestRatePercent: loanRequest.interestRatePercent,
        managementChargeType: loanRequest.managementChargeType,
        managementChargeValue: loanRequest.managementChargeValue,
        managementChargeApplication: loanRequest.managementChargeApplication,
        managementChargeAmount: loanRequest.managementChargeAmount,
        disbursementDate,
        maturationDate,
      },
    });
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

    const confirmed = await this.prisma.loanRequest.update({
      where: { id: pending.id },
      data: { status: LoanRequestStatus.CONFIRMED, confirmedAt: new Date() },
    });

    const threshold = Number(this.configService?.get('LOAN_AUTO_APPROVE_THRESHOLD') ?? 0);
    if (Number(confirmed.amount) < threshold) {
      await this.prisma.loanRequest.update({
        where: { id: confirmed.id },
        data: { status: LoanRequestStatus.DISBURSED, approvedAt: new Date(), disbursedAt: new Date() },
      });
      await this.createClientLoanFromRequest(confirmed.id);
    }
  }

  async approve(id: string) {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.status !== LoanRequestStatus.CONFIRMED) {
      throw new ConflictException('Loan request must be CONFIRMED to approve');
    }
    return this.prisma.loanRequest.update({
      where: { id },
      data: { status: LoanRequestStatus.APPROVED, approvedAt: new Date() },
    });
  }

  async reject(id: string, reason: string) {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.status !== LoanRequestStatus.CONFIRMED) {
      throw new ConflictException('Loan request must be CONFIRMED to reject');
    }
    return this.prisma.loanRequest.update({
      where: { id },
      data: { status: LoanRequestStatus.REJECTED, rejectionReason: reason },
    });
  }

  async disburse(id: string) {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.status !== LoanRequestStatus.APPROVED) {
      throw new ConflictException('Loan request must be APPROVED to disburse');
    }
    const updated = await this.prisma.loanRequest.update({
      where: { id },
      data: { status: LoanRequestStatus.DISBURSED, disbursedAt: new Date() },
    });
    await this.createClientLoanFromRequest(id);
    return updated;
  }

  async listAll(status?: LoanRequestStatus) {
    return this.prisma.loanRequest.findMany({ where: { status }, orderBy: { createdAt: 'desc' } });
  }

  async exportDisbursementSummaryCsv(month: string): Promise<string> {
    const match = /^(\d{4})-(\d{2})$/.exec(month);
    if (!match) {
      throw new BadRequestException('month must be in YYYY-MM format');
    }
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    const start = new Date(year, monthIndex, 1);
    const end = new Date(year, monthIndex + 1, 1);

    const loans = await this.prisma.clientLoan.findMany({
      where: { disbursementDate: { gte: start, lt: end } },
      include: { client: { include: { onboarding: true } } },
      orderBy: { disbursementDate: 'asc' },
    });

    const header = [
      'clientPhone',
      'clientName',
      'agency',
      'principalAmount',
      'disbursedAmount',
      'tenorMonths',
      'interestRatePercent',
      'managementChargeAmount',
      'disbursementDate',
    ];
    const rows = loans.map((loan) =>
      [
        loan.client.phone,
        loan.client.onboarding?.employeeName ?? '',
        loan.agency,
        Number(loan.principalAmount),
        Number(loan.disbursedAmount),
        loan.tenorMonths,
        Number(loan.interestRatePercent),
        Number(loan.managementChargeAmount),
        loan.disbursementDate.toISOString(),
      ].join(','),
    );

    return [header.join(','), ...rows].join('\n') + '\n';
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
