import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { buildPaginatedResult } from '../common/pagination/paginated-result';
import { EligibilityService } from './eligibility/eligibility.service';
import { TopupEligibilityService } from './eligibility/topup-eligibility.service';
import { SmsService } from '../sms/sms.service';
import { SmsType } from '../sms/sms-type';
import { LoanProductResolverService } from './eligibility/loan-product-resolver.service';
import { LOAN_REQUEST_EXPIRY_QUEUE } from './loan-request-queue.constants';
import { generatePeriodRange, toPeriodKey } from '../reconciliation/period.util';
import { computeExpectedInstallment } from '../reconciliation/amortization.util';
import { WalletService } from '../wallet/wallet.service';
import { EmailService } from '../email/email.service';
import { LoanSettingsService } from '../loan-settings/loan-settings.service';
import { loanConfirmationEmail, loanConfirmationSms } from './loan-confirmation-messages';
import { hashToken } from '../common/opaque-token.util';
import { generateNumericCode } from '../common/generate-numeric-code.util';
import { devCodeEcho } from '../common/dev-code-echo.util';
import { classifyVariance } from '../reconciliation/variance-classification.util';
import { computeClientLoanStatus } from '../reconciliation/client-loan-status.util';
import { computeAvailableAdminActions } from './available-admin-actions.util';
import {
  AuditActorType,
  ClientLoan,
  ClientLoanStatus,
  LoanRequest,
  LoanRequestStatus,
  LoanRequestType,
  ManagementChargeApplication,
  ManagementChargeType,
  Prisma,
  VarianceSource,
} from '../generated/prisma/client';

const EXPIRY_MS = 24 * 60 * 60 * 1000;
const LOAN_CONFIRMATION_CODE_TTL_MS = 10 * 60 * 1000;

export const LOAN_APPROVAL_PHONE_MISSING =
  'Agents cannot request loans until an admin sets the loan approval phone number under Configuration → Loan Settings';
export const AGENT_REQUEST_NEEDS_ADMIN =
  'This loan was requested by an agent. The client must send the code to the loan approval phone number, and an admin confirms it';

interface ConfirmationTarget {
  client: { phone: string; email: string | null };
  ippisRecord?: { phone: string | null } | null;
  amount: number;
  topup: boolean;
  /** Set for an agent-made request: the client is told to send the code here. */
  approvalPhone: string | null;
  codeExpiresAt: Date;
}

export interface LoanRequestExpiryJobData {
  loanRequestId: string;
}

@Injectable()
export class LoanRequestService {
  private readonly logger = new Logger(LoanRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibilityService: EligibilityService,
    private readonly smsService: SmsService,
    @InjectQueue(LOAN_REQUEST_EXPIRY_QUEUE) private readonly expiryQueue: Queue<LoanRequestExpiryJobData>,
    private readonly topupEligibilityService: TopupEligibilityService,
    private readonly walletService: WalletService,
    private readonly loanProductResolverService: LoanProductResolverService,
    private readonly configService?: ConfigService,
    private readonly emailService?: EmailService,
    private readonly loanSettingsService?: LoanSettingsService,
  ) {}

  private resolveSmsPhone(client: { phone: string }, ippisRecord?: { phone: string | null } | null): string {
    return client.phone || ippisRecord?.phone || client.phone;
  }

  /** The admin approval phone, required before an agent can request a loan. */
  private async requireApprovalPhone(): Promise<string> {
    const settings = await this.loanSettingsService?.get();
    if (!settings?.loanApprovalPhone) {
      throw new ConflictException(LOAN_APPROVAL_PHONE_MISSING);
    }
    return settings.loanApprovalPhone;
  }

  /**
   * Issues a fresh code and sends it by SMS (and email when the client has one).
   * A client-made request gets a short-lived code for the app; an agent-made one
   * tells the client to send the code to the admin approval phone, so it lasts
   * as long as the request does.
   */
  private async sendConfirmationCode(target: ConfirmationTarget): Promise<{
    confirmationCodeHash: string;
    confirmationCodeExpiresAt: Date;
    devCode?: string;
  }> {
    const length = Number(this.configService?.get('EMAIL_CODE_LENGTH') ?? 6);
    const code = generateNumericCode(length);
    const ttlMinutes = Math.max(1, Math.ceil((target.codeExpiresAt.getTime() - Date.now()) / 60000));
    const params = {
      code,
      amount: target.amount,
      topup: target.topup,
      approvalPhone: target.approvalPhone,
      ttlMinutes,
    };

    await this.smsService.send({
      type: SmsType.LOAN_CONFIRMATION,
      phone: this.resolveSmsPhone(target.client, target.ippisRecord),
      message: loanConfirmationSms(params),
    });

    const email = target.client.email;
    if (email) {
      try {
        await this.emailService?.send({ to: email, ...loanConfirmationEmail(params) });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Loan-request confirmation code email to ${email} failed: ${err}`);
      }
    }

    return {
      confirmationCodeHash: hashToken(code),
      confirmationCodeExpiresAt: target.codeExpiresAt,
      devCode: devCodeEcho(this.configService, code),
    };
  }

  private codeExpiry(agentRequested: boolean, requestExpiresAt: Date): Date {
    return agentRequested ? requestExpiresAt : new Date(Date.now() + LOAN_CONFIRMATION_CODE_TTL_MS);
  }

  private async createClientLoanFromRequest(loanRequestId: string, disbursementDate: Date = new Date()): Promise<void> {
    const loanRequest = await this.prisma.loanRequest.findUniqueOrThrow({ where: { id: loanRequestId } });

    if (loanRequest.type === LoanRequestType.TOPUP) {
      await this.applyTopupToClientLoan(loanRequest, disbursementDate);
      return;
    }

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

  private async applyTopupToClientLoan(loanRequest: LoanRequest, disbursementDate: Date = new Date()): Promise<void> {
    const topupAmount = Number(loanRequest.amount);
    const managementChargeAmount = Number(loanRequest.managementChargeAmount);
    const disbursedAmount =
      loanRequest.managementChargeApplication === ManagementChargeApplication.DEDUCT_FROM_DISBURSEMENT
        ? topupAmount - managementChargeAmount
        : topupAmount;

    const maturationDate = new Date(disbursementDate);
    maturationDate.setMonth(maturationDate.getMonth() + loanRequest.tenorMonths);

    const fields = {
      principalAmount: topupAmount,
      disbursedAmount,
      principalBalance: topupAmount,
      tenorMonths: loanRequest.tenorMonths,
      interestRatePercent: loanRequest.interestRatePercent,
      managementChargeType: loanRequest.managementChargeType,
      managementChargeValue: loanRequest.managementChargeValue,
      managementChargeApplication: loanRequest.managementChargeApplication,
      managementChargeAmount,
      disbursementDate,
      maturationDate,
      status: ClientLoanStatus.ACTIVE,
    };

    if (loanRequest.topupTargetId) {
      await this.prisma.clientLoan.update({ where: { id: loanRequest.topupTargetId }, data: fields });
      return;
    }

    const onboarding = await this.prisma.clientOnboarding.findUniqueOrThrow({
      where: { clientId: loanRequest.clientId },
      include: { ippisRecord: true },
    });

    await this.prisma.clientLoan.create({
      data: {
        clientId: loanRequest.clientId,
        loanRequestId: loanRequest.id,
        agency: onboarding.ippisRecord.agency,
        staffId: onboarding.ippisRecord.staffId,
        ...fields,
      },
    });
  }

  async applyWalletToLoan(clientId: string, amount: number) {
    const clientLoan = await this.prisma.clientLoan.findFirst({
      where: { clientId, principalBalance: { gt: 0 } },
      orderBy: { disbursementDate: 'desc' },
    });
    if (!clientLoan) {
      throw new UnprocessableEntityException('No outstanding loan balance to pay down');
    }

    const currentPeriod = toPeriodKey(new Date());
    const existingVariance = await this.prisma.clientLoanRepaymentVariance.findUnique({
      where: { clientLoanId_period: { clientLoanId: clientLoan.id, period: currentPeriod } },
    });
    if (existingVariance) {
      throw new ConflictException('This period has already been reconciled for this loan');
    }

    const principalBalance = Number(clientLoan.principalBalance);
    const appliedAmount = Math.min(amount, principalBalance);

    await this.walletService.debit(clientId, appliedAmount, `Applied toward loan #${clientLoan.id}`, {
      actorType: AuditActorType.CLIENT,
      actorId: clientId,
    });

    const expectedAmount = computeExpectedInstallment(
      Number(clientLoan.principalAmount),
      Number(clientLoan.interestRatePercent),
      clientLoan.disbursementDate,
      clientLoan.maturationDate,
    );
    const variance = appliedAmount - expectedAmount;
    const status = classifyVariance(appliedAmount, variance);

    await this.prisma.clientLoanRepaymentVariance.create({
      data: {
        clientLoanId: clientLoan.id,
        period: currentPeriod,
        expectedAmount,
        actualAmount: appliedAmount,
        variance,
        status,
        source: VarianceSource.WALLET_APPLICATION,
      },
    });

    const remainingBalance = principalBalance - appliedAmount;
    const newStatus = computeClientLoanStatus(
      { principalBalance: remainingBalance, maturationDate: clientLoan.maturationDate },
      status,
    );

    await this.prisma.clientLoan.update({
      where: { id: clientLoan.id },
      data: { principalBalance: remainingBalance, status: newStatus },
    });

    return { appliedAmount, remainingBalance, status: newStatus };
  }

  /** `requestedByAgentId` is set when an agent makes the request for the client. */
  async create(clientId: string, amount: number, tenorMonths: number, requestedByAgentId?: string) {
    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      throw new ConflictException('Client has not completed onboarding');
    }
    const approvalPhone = requestedByAgentId ? await this.requireApprovalPhone() : null;

    const eligibility = await this.eligibilityService.check(client, onboarding.ippisRecord, amount);
    if (!eligibility.eligible) {
      throw new UnprocessableEntityException(eligibility.reason);
    }

    const { product, tier } = await this.loanProductResolverService.resolve(onboarding.ippisRecord, amount, tenorMonths);

    const managementChargeAmount =
      product.managementChargeType === ManagementChargeType.PERCENTAGE
        ? (amount * Number(product.managementChargeValue)) / 100
        : Number(product.managementChargeValue);

    const expiresAt = new Date(Date.now() + EXPIRY_MS);
    const { confirmationCodeHash, confirmationCodeExpiresAt, devCode } = await this.sendConfirmationCode({
      client,
      ippisRecord: onboarding.ippisRecord,
      amount,
      topup: false,
      approvalPhone,
      codeExpiresAt: this.codeExpiry(!!requestedByAgentId, expiresAt),
    });

    const loanRequest = await this.prisma.loanRequest.create({
      data: {
        clientId,
        requestedByAgentId: requestedByAgentId ?? null,
        amount,
        tenorMonths,
        interestRatePercent: tier.interestRatePercent,
        managementChargeType: product.managementChargeType,
        managementChargeValue: product.managementChargeValue,
        managementChargeApplication: product.managementChargeApplication,
        managementChargeAmount,
        expiresAt,
        confirmationSmsSentAt: new Date(),
        confirmationCodeHash,
        confirmationCodeExpiresAt,
      },
      omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
    });

    await this.expiryQueue.add('expire', { loanRequestId: loanRequest.id }, { delay: EXPIRY_MS });

    return { ...loanRequest, devCode };
  }

  async createTopup(clientId: string, amount: number, tenorMonths: number, requestedByAgentId?: string) {
    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      throw new ConflictException('Client has not completed onboarding');
    }
    const approvalPhone = requestedByAgentId ? await this.requireApprovalPhone() : null;

    const eligibility = await this.topupEligibilityService.check(client, onboarding.ippisRecord, amount);
    if (!eligibility.eligible) {
      throw new UnprocessableEntityException(eligibility.reason);
    }

    const existingClientLoan = await this.prisma.clientLoan.findFirst({
      where: { clientId },
      orderBy: { disbursementDate: 'desc' },
    });

    const { product, tier } = await this.loanProductResolverService.resolve(onboarding.ippisRecord, amount, tenorMonths);

    const managementChargeAmount =
      product.managementChargeType === ManagementChargeType.PERCENTAGE
        ? (amount * Number(product.managementChargeValue)) / 100
        : Number(product.managementChargeValue);

    const expiresAt = new Date(Date.now() + EXPIRY_MS);
    const { confirmationCodeHash, confirmationCodeExpiresAt, devCode } = await this.sendConfirmationCode({
      client,
      ippisRecord: onboarding.ippisRecord,
      amount,
      topup: true,
      approvalPhone,
      codeExpiresAt: this.codeExpiry(!!requestedByAgentId, expiresAt),
    });

    const loanRequest = await this.prisma.loanRequest.create({
      data: {
        clientId,
        requestedByAgentId: requestedByAgentId ?? null,
        amount,
        tenorMonths,
        type: LoanRequestType.TOPUP,
        topupTargetId: existingClientLoan?.id,
        interestRatePercent: tier.interestRatePercent,
        managementChargeType: product.managementChargeType,
        managementChargeValue: product.managementChargeValue,
        managementChargeApplication: product.managementChargeApplication,
        managementChargeAmount,
        expiresAt,
        confirmationSmsSentAt: new Date(),
        confirmationCodeHash,
        confirmationCodeExpiresAt,
      },
      omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
    });

    await this.expiryQueue.add('expire', { loanRequestId: loanRequest.id }, { delay: EXPIRY_MS });

    return { ...loanRequest, devCode };
  }

  async resend(clientId: string, id: string) {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.clientId !== clientId) {
      throw new NotFoundException('Loan request not found');
    }
    if (loanRequest.status !== LoanRequestStatus.PENDING) {
      throw new ConflictException(`Loan request is not PENDING (currently ${loanRequest.status})`);
    }

    const client = await this.prisma.client.findUniqueOrThrow({
      where: { id: clientId },
      include: { onboarding: { include: { ippisRecord: true } } },
    });
    // Worded for whoever made the request, not whoever asks for the resend.
    const agentRequested = !!loanRequest.requestedByAgentId;
    const { confirmationCodeHash, confirmationCodeExpiresAt, devCode } = await this.sendConfirmationCode({
      client,
      ippisRecord: client.onboarding?.ippisRecord,
      amount: Number(loanRequest.amount),
      topup: loanRequest.type === LoanRequestType.TOPUP,
      approvalPhone: agentRequested ? await this.requireApprovalPhone() : null,
      codeExpiresAt: this.codeExpiry(agentRequested, loanRequest.expiresAt),
    });

    const updated = await this.prisma.loanRequest.update({
      where: { id },
      data: { confirmationSmsSentAt: new Date(), confirmationCodeHash, confirmationCodeExpiresAt },
      omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
    });

    return { ...updated, devCode };
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

    // Agent-made requests need an admin to enter the code, so a reply can't confirm them.
    const pending = await this.prisma.loanRequest.findFirst({
      where: { clientId: client.id, status: LoanRequestStatus.PENDING, requestedByAgentId: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!pending) {
      return;
    }

    await this.confirmPending(pending);
  }

  /** Client or agent entering the code. Agent-made requests are confirmed by an admin instead. */
  async confirmByCode(clientId: string, id: string, code: string): Promise<void> {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.clientId !== clientId) {
      throw new NotFoundException('Loan request not found');
    }
    if (loanRequest.requestedByAgentId) {
      throw new ForbiddenException(AGENT_REQUEST_NEEDS_ADMIN);
    }
    await this.verifyCodeAndConfirm(loanRequest, code);
  }

  async adminConfirmByCode(id: string, code: string): Promise<void> {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest) {
      throw new NotFoundException('Loan request not found');
    }
    await this.verifyCodeAndConfirm(loanRequest, code);
  }

  private assertValidCode(loanRequest: LoanRequest, code: string): void {
    if (loanRequest.status !== LoanRequestStatus.PENDING) {
      throw new ConflictException(`Loan request is not PENDING (currently ${loanRequest.status})`);
    }
    if (
      !loanRequest.confirmationCodeHash ||
      !loanRequest.confirmationCodeExpiresAt ||
      loanRequest.confirmationCodeExpiresAt < new Date() ||
      loanRequest.confirmationCodeHash !== hashToken(code)
    ) {
      throw new UnauthorizedException('Invalid or expired verification code');
    }
  }

  private async verifyCodeAndConfirm(loanRequest: LoanRequest, code: string): Promise<void> {
    this.assertValidCode(loanRequest, code);
    await this.confirmPending(loanRequest);
  }

  /** Checks an admin-entered code now, so a checker never has to see or handle it. */
  async checkConfirmationCode(id: string, code: string): Promise<LoanRequest> {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest) {
      throw new NotFoundException('Loan request not found');
    }
    this.assertValidCode(loanRequest, code);
    return loanRequest;
  }

  /** Completes a confirmation whose code was already checked when it was sent for approval. */
  async confirmAfterApproval(id: string): Promise<void> {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.status !== LoanRequestStatus.PENDING) {
      throw new ConflictException(`Loan request is no longer PENDING (currently ${loanRequest?.status ?? 'missing'})`);
    }
    await this.confirmPending(loanRequest);
  }

  /** Stops a maker sending a request that could never be carried out. */
  async requireStatus(id: string, status: LoanRequestStatus, actionLabel: string) {
    const loanRequest = await this.prisma.loanRequest.findUnique({
      where: { id },
      include: { client: { select: { phone: true, onboarding: { select: { employeeName: true } } } } },
    });
    if (!loanRequest || loanRequest.status !== status) {
      throw new ConflictException(`Loan request must be ${status} to ${actionLabel}`);
    }
    return loanRequest;
  }

  private async confirmPending(pending: LoanRequest): Promise<void> {
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

  private static readonly LOAN_REQUEST_RELATIONS_INCLUDE = {
    client: {
      select: {
        id: true,
        phone: true,
        email: true,
        status: true,
        onboarding: {
          select: {
            employeeName: true,
            agency: true,
            onboardedByAgentId: true,
            ippisRecord: {
              select: {
                agency: true,
                staffId: true,
                employeeName: true,
                employeeStatus: true,
                hireDate: true,
                department: true,
                grade: true,
                bankName: true,
                accountNumber: true,
              },
            },
          },
        },
      },
    },
    topupTarget: { select: { id: true, status: true, agency: true } },
    requestedByAgent: { select: { id: true, fullName: true, phone: true } },
  } as const;

  async approve(id: string, disbursedAt?: Date) {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.status !== LoanRequestStatus.CONFIRMED) {
      throw new ConflictException('Loan request must be CONFIRMED to approve');
    }
    const disbursementTimestamp = disbursedAt ?? new Date();
    if (disbursementTimestamp.getTime() > Date.now()) {
      throw new BadRequestException('disbursedAt cannot be in the future');
    }

    await this.prisma.loanRequest.update({
      where: { id },
      data: { status: LoanRequestStatus.APPROVED, approvedAt: new Date() },
    });

    const disbursed = await this.prisma.loanRequest.update({
      where: { id },
      data: { status: LoanRequestStatus.DISBURSED, disbursedAt: disbursementTimestamp },
      include: LoanRequestService.LOAN_REQUEST_RELATIONS_INCLUDE,
      omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
    });
    await this.createClientLoanFromRequest(id, disbursementTimestamp);
    return disbursed;
  }

  async reject(id: string, reason: string) {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.status !== LoanRequestStatus.CONFIRMED) {
      throw new ConflictException('Loan request must be CONFIRMED to reject');
    }
    return this.prisma.loanRequest.update({
      where: { id },
      data: { status: LoanRequestStatus.REJECTED, rejectionReason: reason },
      include: LoanRequestService.LOAN_REQUEST_RELATIONS_INCLUDE,
      omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
    });
  }

  async disburse(id: string, disbursedAt?: Date) {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.status !== LoanRequestStatus.APPROVED) {
      throw new ConflictException('Loan request must be APPROVED to disburse');
    }
    const disbursementTimestamp = disbursedAt ?? new Date();
    if (disbursementTimestamp.getTime() > Date.now()) {
      throw new BadRequestException('disbursedAt cannot be in the future');
    }
    const updated = await this.prisma.loanRequest.update({
      where: { id },
      data: { status: LoanRequestStatus.DISBURSED, disbursedAt: disbursementTimestamp },
      include: LoanRequestService.LOAN_REQUEST_RELATIONS_INCLUDE,
      omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
    });
    await this.createClientLoanFromRequest(id, disbursementTimestamp);
    return updated;
  }

  async findById(id: string) {
    const loanRequest = await this.prisma.loanRequest.findUnique({
      where: { id },
      include: LoanRequestService.LOAN_REQUEST_RELATIONS_INCLUDE,
      omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
    });
    if (!loanRequest) {
      throw new NotFoundException('Loan request not found');
    }
    return { ...loanRequest, availableActions: computeAvailableAdminActions(loanRequest.status) };
  }

  async listAll(
    filters: {
      status?: LoanRequestStatus;
      type?: LoanRequestType;
      clientId?: string;
      createdFrom?: Date;
      createdTo?: Date;
      disbursedFrom?: Date;
      disbursedTo?: Date;
    } = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where = {
      status: filters.status,
      type: filters.type,
      clientId: filters.clientId,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
      disbursedAt:
        filters.disbursedFrom || filters.disbursedTo
          ? { gte: filters.disbursedFrom, lte: filters.disbursedTo }
          : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.loanRequest.findMany({
        where,
        include: LoanRequestService.LOAN_REQUEST_RELATIONS_INCLUDE,
        omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.loanRequest.count({ where }),
    ]);

    const dataWithActions = data.map((row) => ({ ...row, availableActions: computeAvailableAdminActions(row.status) }));
    return buildPaginatedResult(dataWithActions, total, page, limit);
  }

  async listByClient(
    clientId: string | undefined,
    filters: { status?: ClientLoanStatus; agency?: string; disbursedFrom?: Date; disbursedTo?: Date } = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.ClientLoanWhereInput = {
      clientId,
      status: filters.status,
      agency: filters.agency,
      disbursementDate:
        filters.disbursedFrom || filters.disbursedTo
          ? { gte: filters.disbursedFrom, lte: filters.disbursedTo }
          : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.clientLoan.findMany({
        where,
        include: {
          loanRequest: { select: { id: true, type: true, status: true } },
          client: { select: { id: true, phone: true } },
        },
        orderBy: { disbursementDate: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.clientLoan.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
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

  async list(
    clientId: string,
    filters: { status?: LoanRequestStatus } = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.LoanRequestWhereInput = { clientId, status: filters.status };

    const [data, total] = await Promise.all([
      this.prisma.loanRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
      }),
      this.prisma.loanRequest.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }

  async getMyLoan(clientId: string) {
    const clientLoan = await this.prisma.clientLoan.findFirst({
      where: { clientId },
      orderBy: { disbursementDate: 'desc' },
    });
    if (!clientLoan) {
      return null;
    }
    return this.buildLoanWithSchedule(clientLoan);
  }

  async getRepaymentPlanById(clientLoanId: string) {
    const clientLoan = await this.prisma.clientLoan.findUnique({
      where: { id: clientLoanId },
      include: {
        loanRequest: { select: { id: true, type: true, status: true } },
        client: { select: { id: true, phone: true } },
      },
    });
    if (!clientLoan) {
      throw new NotFoundException('Loan not found');
    }
    return this.buildLoanWithSchedule(clientLoan);
  }

  private async buildLoanWithSchedule(clientLoan: ClientLoan) {
    const periods = generatePeriodRange(clientLoan.disbursementDate, clientLoan.maturationDate);
    const expectedAmount = computeExpectedInstallment(
      Number(clientLoan.principalAmount),
      Number(clientLoan.interestRatePercent),
      clientLoan.disbursementDate,
      clientLoan.maturationDate,
    );

    const varianceRows = await this.prisma.clientLoanRepaymentVariance.findMany({
      where: { clientLoanId: clientLoan.id },
    });
    const varianceByPeriod = new Map(varianceRows.map((row) => [row.period, row]));

    const schedule = periods.map((period) => {
      const varianceRow = varianceByPeriod.get(period);
      if (!varianceRow) {
        return { period, expectedAmount, actualAmount: null, variance: null, status: 'UPCOMING' as const };
      }
      return {
        period,
        expectedAmount,
        actualAmount: Number(varianceRow.actualAmount),
        variance: Number(varianceRow.variance),
        status: varianceRow.status,
      };
    });

    return { ...clientLoan, schedule };
  }
}
