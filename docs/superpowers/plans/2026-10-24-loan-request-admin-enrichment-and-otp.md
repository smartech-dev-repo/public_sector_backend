# Loan Request Admin Enrichment, Phone Fallback, and Admin-Confirm OTP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins a richer, actionable view of loan requests (client/IPPIS context + `availableActions`), add a phone fallback to the linked `IppisRecord` when a client's own phone is somehow empty, let admin confirm a stuck `PENDING` request via OTP, and collapse admin's approve+disburse into one step with an optional backdated disbursement date.

**Architecture:** All four pieces live in `LoanRequestService` and `AdminLoanRequestController` — the shared `LOAN_REQUEST_RELATIONS_INCLUDE` constant grows to carry onboarding/IPPIS context, a new pure `computeAvailableAdminActions` util drives the new field, `approve()`/`disburse()` both gain an optional `disbursedAt` override that flows into `createClientLoanFromRequest`/`applyTopupToClientLoan`, and `confirmByCode`'s validation is extracted into a shared helper reused by a new ownership-free `adminConfirmByCode`.

**Tech Stack:** NestJS, Prisma 7.10.0, Jest, PostgreSQL (live shared UAT DB).

**Spec:** `docs/superpowers/specs/2026-10-24-loan-request-admin-enrichment-and-otp-design.md`

## Global Constraints

- `IppisRecord.phone` is confirmed nullable (`String?`) in the live schema.
- Zero `LoanRequest` rows are currently `APPROVED` on the live DB — collapsing approve+disburse is safe, nothing is left stranded.
- Admin never gets a resend action — only the existing agent/client `resend()` paths do that (unchanged by this plan).
- `disbursedAt` on `LoanRequest` is a plain column, never part of the `omit: { confirmationCodeHash, confirmationCodeExpiresAt }` — already present on every response; no code change needed to surface it, only confirmed via the new tests.
- A future-dated `disbursedAt` must be rejected with `BadRequestException` before any write happens, on both `approve()` and `disburse()`.

---

### Task 1: Admin enrichment, `availableActions`, and one-step approve/disburse with a settable disbursement date

**Files:**
- Create: `src/loan-request/available-admin-actions.util.ts`
- Create: `src/loan-request/available-admin-actions.util.spec.ts`
- Create: `src/loan-request/dto/disbursement-date.dto.ts`
- Create: `src/loan-request/admin-loan-request.controller.spec.ts`
- Modify: `src/loan-request/loan-request.service.ts:112-155` (`createClientLoanFromRequest`), `:157-203` (`applyTopupToClientLoan`), `:451-454` (`LOAN_REQUEST_RELATIONS_INCLUDE`), `:456-495` (`approve`/`disburse`), insert a new `findById` after `:495`, `:497-537` (`listAll`)
- Modify: `src/loan-request/loan-request.service.spec.ts`
- Modify: `src/loan-request/admin-loan-request.controller.ts`

**Interfaces:**
- Produces: `computeAvailableAdminActions(status: LoanRequestStatus): string[]`; `LoanRequestService.findById(id): Promise<LoanRequest & {availableActions: string[]}>`; `LoanRequestService.approve(id: string, disbursedAt?: Date)` and `.disburse(id: string, disbursedAt?: Date)` (both now return a `DISBURSED` row); `DisbursementDateDto { disbursedAt?: string }` — consumed by Task 3's controller test additions and by Task 4 (e2e).

This is the foundational task for the shared `LOAN_REQUEST_RELATIONS_INCLUDE` constant and the `approve`/`disburse` rewrite — Tasks 2 and 3 touch different methods in the same file and must land after this one to avoid merge conflicts on the same constant/imports.

- [ ] **Step 1: Write the failing test for `computeAvailableAdminActions`**

Create `src/loan-request/available-admin-actions.util.spec.ts`:
```typescript
import { computeAvailableAdminActions } from './available-admin-actions.util';
import { LoanRequestStatus } from '../generated/prisma/client';

describe('computeAvailableAdminActions', () => {
  it('returns confirmCode for PENDING', () => {
    expect(computeAvailableAdminActions(LoanRequestStatus.PENDING)).toEqual(['confirmCode']);
  });

  it('returns approve and reject for CONFIRMED', () => {
    expect(computeAvailableAdminActions(LoanRequestStatus.CONFIRMED)).toEqual(['approve', 'reject']);
  });

  it('returns disburse for APPROVED', () => {
    expect(computeAvailableAdminActions(LoanRequestStatus.APPROVED)).toEqual(['disburse']);
  });

  it('returns an empty array for DISBURSED', () => {
    expect(computeAvailableAdminActions(LoanRequestStatus.DISBURSED)).toEqual([]);
  });

  it('returns an empty array for REJECTED', () => {
    expect(computeAvailableAdminActions(LoanRequestStatus.REJECTED)).toEqual([]);
  });

  it('returns an empty array for FAILED', () => {
    expect(computeAvailableAdminActions(LoanRequestStatus.FAILED)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/loan-request/available-admin-actions.util.spec.ts`
Expected: FAIL — `Cannot find module './available-admin-actions.util'`.

- [ ] **Step 3: Implement `computeAvailableAdminActions`**

Create `src/loan-request/available-admin-actions.util.ts`:
```typescript
import { LoanRequestStatus } from '../generated/prisma/client';

export function computeAvailableAdminActions(status: LoanRequestStatus): string[] {
  switch (status) {
    case LoanRequestStatus.PENDING:
      return ['confirmCode'];
    case LoanRequestStatus.CONFIRMED:
      return ['approve', 'reject'];
    case LoanRequestStatus.APPROVED:
      return ['disburse'];
    default:
      return [];
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest src/loan-request/available-admin-actions.util.spec.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Create the new DTO**

Create `src/loan-request/dto/disbursement-date.dto.ts`:
```typescript
import { IsISO8601, IsOptional } from 'class-validator';

export class DisbursementDateDto {
  @IsOptional()
  @IsISO8601()
  disbursedAt?: string;
}
```

- [ ] **Step 6: Write the failing tests for the enriched include, the approve/disburse rewrite, and `findById`**

In `src/loan-request/loan-request.service.spec.ts`, add `hashToken` is already imported — add `computeAvailableAdminActions` is not needed in the spec (tests assert on literal arrays, not the util). No new imports needed here.

Replace the `reject` describe block's success test (lines 583-598):
```typescript
    it('moves a CONFIRMED request to REJECTED with a reason', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'CONFIRMED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1', status: 'REJECTED' });

      await service.reject('lr1', 'not eligible');

      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'REJECTED', rejectionReason: 'not eligible' },
        include: {
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
        },
        omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
      });
    });
```

Replace the entire `approve` describe block (lines 553-575):
```typescript
  describe('approve', () => {
    it('throws ConflictException when the request is not CONFIRMED', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'PENDING' });
      await expect(service.approve('lr1')).rejects.toThrow(ConflictException);
    });

    it('throws BadRequestException when disbursedAt is in the future, without writing anything', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'CONFIRMED' });
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await expect(service.approve('lr1', future)).rejects.toThrow(BadRequestException);
      expect(prisma.loanRequest.update).not.toHaveBeenCalled();
    });

    it('moves a CONFIRMED request straight through to DISBURSED and creates a ClientLoan', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'CONFIRMED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1', status: 'DISBURSED' });
      prisma.loanRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'lr1',
        clientId: 'c1',
        amount: 5000,
        tenorMonths: 6,
        managementChargeAmount: 100,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
      });
      prisma.clientOnboarding.findUniqueOrThrow.mockResolvedValue({
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.clientLoan.create.mockResolvedValue({ id: 'cl1' });

      await service.approve('lr1');

      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'APPROVED', approvedAt: expect.any(Date) },
      });
      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'DISBURSED', disbursedAt: expect.any(Date) },
        include: {
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
        },
        omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
      });
      expect(prisma.clientLoan.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId: 'c1',
          loanRequestId: 'lr1',
          agency: 'NPF',
          staffId: 'NPF-001',
          principalAmount: 5000,
          disbursedAmount: 4900,
          principalBalance: 5000,
        }),
      });
    });

    it('uses a supplied disbursedAt for both LoanRequest.disbursedAt and the ClientLoan disbursementDate/maturationDate', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'CONFIRMED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1', status: 'DISBURSED' });
      prisma.loanRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'lr1',
        clientId: 'c1',
        amount: 5000,
        tenorMonths: 6,
        managementChargeAmount: 100,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
      });
      prisma.clientOnboarding.findUniqueOrThrow.mockResolvedValue({
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.clientLoan.create.mockResolvedValue({ id: 'cl1' });
      const backdated = new Date(2026, 0, 1);

      await service.approve('lr1', backdated);

      expect(prisma.loanRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ disbursedAt: backdated }) }),
      );
      expect(prisma.clientLoan.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          disbursementDate: backdated,
          maturationDate: new Date(2026, 6, 1),
        }),
      });
    });
  });
```

Replace the entire `disburse` describe block (lines 601-640) — note `disburse with a TOPUP request` (the separate describe block further down, lines 812-888) needs **no changes**, since neither of its two tests assert on `prisma.loanRequest.update`'s call shape:
```typescript
  describe('disburse', () => {
    it('throws ConflictException when the request is not APPROVED', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'CONFIRMED' });
      await expect(service.disburse('lr1')).rejects.toThrow(ConflictException);
    });

    it('throws BadRequestException when disbursedAt is in the future, without writing anything', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'APPROVED' });
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await expect(service.disburse('lr1', future)).rejects.toThrow(BadRequestException);
      expect(prisma.loanRequest.update).not.toHaveBeenCalled();
    });

    it('moves an APPROVED request to DISBURSED and creates a ClientLoan', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'APPROVED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1', status: 'DISBURSED' });
      prisma.loanRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'lr1',
        clientId: 'c1',
        amount: 5000,
        tenorMonths: 6,
        managementChargeAmount: 100,
        managementChargeApplication: 'ADD_TO_REPAYMENT',
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
      });
      prisma.clientOnboarding.findUniqueOrThrow.mockResolvedValue({
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.clientLoan.create.mockResolvedValue({ id: 'cl1' });

      await service.disburse('lr1');

      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'DISBURSED', disbursedAt: expect.any(Date) },
        include: {
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
        },
        omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
      });
      expect(prisma.clientLoan.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ disbursedAmount: 5000, principalAmount: 5000 }),
      });
    });
  });
```

Replace the `listAll` describe block's "includes client and topupTarget" test (lines 653-668):
```typescript
    it('includes client and topupTarget on every row, with availableActions computed per row', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([{ id: 'lr1', status: 'CONFIRMED' }]);
      prisma.loanRequest.count.mockResolvedValue(1);

      const result = await service.listAll();

      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
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
          },
          omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
        }),
      );
      expect(result.data[0]).toEqual(expect.objectContaining({ id: 'lr1', availableActions: ['approve', 'reject'] }));
    });
```

Add a new `describe('findById', ...)` block right after the `listAll` describe block closes (after line 669's closing `});`, before `describe('exportDisbursementSummaryCsv', ...)`):
```typescript

  describe('findById', () => {
    it('throws NotFoundException for an unknown id', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue(null);
      await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
    });

    it('returns the enriched row with availableActions for its status', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'PENDING' });

      const result = await service.findById('lr1');

      expect(prisma.loanRequest.findUnique).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        include: expect.objectContaining({ topupTarget: { select: { id: true, status: true, agency: true } } }),
        omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
      });
      expect(result).toEqual({ id: 'lr1', status: 'PENDING', availableActions: ['confirmCode'] });
    });
  });
```

- [ ] **Step 7: Run the spec file to verify it fails**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: FAIL — multiple mismatches (old include shape, `approve`/`disburse` arity, `service.findById is not a function`).

- [ ] **Step 8: Implement the service changes**

In `src/loan-request/loan-request.service.ts`, add the import (after the existing local imports, e.g. after the `computeClientLoanStatus` import):
```typescript
import { computeAvailableAdminActions } from './available-admin-actions.util';
```

Replace `createClientLoanFromRequest` (lines 112-155):
```typescript
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
```
(Only change from the original: the new `disbursementDate` parameter with a default, `applyTopupToClientLoan` now receives it as a second argument, and the local `const disbursementDate = new Date();` line is removed since the parameter replaces it.)

Replace `applyTopupToClientLoan` (lines 157-203):
```typescript
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
```
(Same change: `disbursementDate` is now a parameter with a default instead of a local `new Date()` declaration. `confirmPending`'s existing call `this.createClientLoanFromRequest(confirmed.id)` — no second argument — is unaffected and keeps defaulting to `new Date()`, matching today's auto-threshold behavior exactly.)

Replace `LOAN_REQUEST_RELATIONS_INCLUDE` (lines 451-454):
```typescript
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
  } as const;
```

Replace `approve` and `disburse` in full (lines 456-495), and insert `findById` right after:
```typescript
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
```
(Note `reject()` is included above unchanged in body — it's shown only because it sits between `approve` and `disburse` in the file and automatically picks up the new `LOAN_REQUEST_RELATIONS_INCLUDE` shape with zero code changes of its own.)

Replace `listAll`'s `return buildPaginatedResult(data, total, page, limit);` line (inside the method spanning lines 497-537) with:
```typescript
    const dataWithActions = data.map((row) => ({ ...row, availableActions: computeAvailableAdminActions(row.status) }));
    return buildPaginatedResult(dataWithActions, total, page, limit);
```

- [ ] **Step 9: Run the spec file to verify it passes**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: PASS (all tests).

- [ ] **Step 10: Write the failing controller tests**

Create `src/loan-request/admin-loan-request.controller.spec.ts`:
```typescript
import { AdminLoanRequestController } from './admin-loan-request.controller';
import { LoanRequestService } from './loan-request.service';
import { AuditLogService } from '../audit/audit-log.service';
import { JwtPayload } from '../auth/jwt-payload.interface';

describe('AdminLoanRequestController', () => {
  let controller: AdminLoanRequestController;
  let loanRequestService: {
    listAll: jest.Mock;
    approve: jest.Mock;
    reject: jest.Mock;
    disburse: jest.Mock;
    findById: jest.Mock;
    adminConfirmByCode: jest.Mock;
  };
  let auditLogService: { record: jest.Mock };
  const adminReq = { user: { sub: 'admin-1', type: 'admin' } as JwtPayload };

  beforeEach(() => {
    loanRequestService = {
      listAll: jest.fn(),
      approve: jest.fn(),
      reject: jest.fn(),
      disburse: jest.fn(),
      findById: jest.fn(),
      adminConfirmByCode: jest.fn(),
    };
    auditLogService = { record: jest.fn().mockResolvedValue(undefined) };
    controller = new AdminLoanRequestController(
      loanRequestService as unknown as LoanRequestService,
      auditLogService as unknown as AuditLogService,
    );
  });

  describe('findOne', () => {
    it('delegates to LoanRequestService.findById', () => {
      loanRequestService.findById.mockResolvedValue({ id: 'lr1' });
      controller.findOne('lr1');
      expect(loanRequestService.findById).toHaveBeenCalledWith('lr1');
    });
  });

  describe('approve', () => {
    it('passes undefined when disbursedAt is omitted', async () => {
      loanRequestService.approve.mockResolvedValue({ id: 'lr1', status: 'DISBURSED' });
      await controller.approve('lr1', {}, adminReq);
      expect(loanRequestService.approve).toHaveBeenCalledWith('lr1', undefined);
    });

    it('converts a supplied disbursedAt string to a Date', async () => {
      loanRequestService.approve.mockResolvedValue({ id: 'lr1', status: 'DISBURSED' });
      await controller.approve('lr1', { disbursedAt: '2026-01-01T00:00:00.000Z' }, adminReq);
      expect(loanRequestService.approve).toHaveBeenCalledWith('lr1', new Date('2026-01-01T00:00:00.000Z'));
    });

    it('records an audit log entry', async () => {
      loanRequestService.approve.mockResolvedValue({ id: 'lr1', status: 'DISBURSED' });
      await controller.approve('lr1', {}, adminReq);
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'loan-request.approve', targetId: 'lr1', actorId: 'admin-1' }),
      );
    });
  });

  describe('disburse', () => {
    it('converts a supplied disbursedAt string to a Date', async () => {
      loanRequestService.disburse.mockResolvedValue({ id: 'lr1', status: 'DISBURSED' });
      await controller.disburse('lr1', { disbursedAt: '2026-01-01T00:00:00.000Z' }, adminReq);
      expect(loanRequestService.disburse).toHaveBeenCalledWith('lr1', new Date('2026-01-01T00:00:00.000Z'));
    });
  });
});
```

- [ ] **Step 11: Run the controller spec to verify it fails**

Run: `npx jest src/loan-request/admin-loan-request.controller.spec.ts`
Expected: FAIL — `controller.findOne is not a function`, and the `approve`/`disburse` calls don't match (no `DisbursementDateDto` param yet).

- [ ] **Step 12: Implement the controller changes**

In `src/loan-request/admin-loan-request.controller.ts`, add the import:
```typescript
import { DisbursementDateDto } from './dto/disbursement-date.dto';
```
Change the `approve` method:
```typescript
  @Post(':id/approve')
  @HttpCode(200)
  async approve(@Param('id') id: string, @Body() dto: DisbursementDateDto, @Req() req: { user: JwtPayload }) {
    const result = await this.loanRequestService.approve(id, dto.disbursedAt ? new Date(dto.disbursedAt) : undefined);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'loan-request.approve',
      targetType: 'LoanRequest',
      targetId: id,
    });
    return result;
  }
```
Change the `disburse` method:
```typescript
  @Post(':id/disburse')
  @HttpCode(200)
  async disburse(@Param('id') id: string, @Body() dto: DisbursementDateDto, @Req() req: { user: JwtPayload }) {
    const result = await this.loanRequestService.disburse(id, dto.disbursedAt ? new Date(dto.disbursedAt) : undefined);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'loan-request.disburse',
      targetType: 'LoanRequest',
      targetId: id,
    });
    return result;
  }
```
Add a new `findOne` route right after `list` (and before `approve`):
```typescript
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.loanRequestService.findById(id);
  }
```

- [ ] **Step 13: Run the controller spec to verify it passes**

Run: `npx jest src/loan-request/admin-loan-request.controller.spec.ts`
Expected: PASS (6/6).

- [ ] **Step 14: Typecheck and run the full loan-request suite**

Run:
```bash
npx jest src/loan-request
npx tsc --noEmit
```
Expected: all PASS, no new type errors.

- [ ] **Step 15: Commit**

```bash
git add src/loan-request/available-admin-actions.util.ts src/loan-request/available-admin-actions.util.spec.ts src/loan-request/dto/disbursement-date.dto.ts src/loan-request/admin-loan-request.controller.spec.ts src/loan-request/loan-request.service.ts src/loan-request/loan-request.service.spec.ts src/loan-request/admin-loan-request.controller.ts
git commit -m "feat(loan-request): enrich admin loan-request responses and collapse approve+disburse"
```

---

### Task 2: Phone fallback to the linked IppisRecord

**Files:**
- Modify: `src/loan-request/loan-request.service.ts` (add `resolveSmsPhone` near `confirmationMessage`/`sendEmailCopy`; modify `create()`, `createTopup()`, `resend()`)
- Modify: `src/loan-request/loan-request.service.spec.ts`

**Interfaces:**
- Produces: `LoanRequestService.resolveSmsPhone(client: {phone: string}, ippisRecord?: {phone: string|null} | null): string` — private, no other task depends on it directly.

This task touches different methods (`create`/`createTopup`/`resend`) than Task 1 touched (`approve`/`disburse`/`reject`/`listAll`/`findById`), but must land after Task 1 since both modify the same file — run it sequentially, not in parallel.

- [ ] **Step 1: Write the failing tests**

In `src/loan-request/loan-request.service.spec.ts`, add this new test to the end of the `describe('create', ...)` block, right before its closing `});` (after the "returns the real code as devCode..." test, before the block's final `});`):
```typescript

    it('falls back to the IppisRecord phone when the client has no phone on file', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        ippisRecord: { salary: 1000000, agency: 'NPF', phone: '+2348099999999' },
      });
      eligibilityService.check.mockResolvedValue({ eligible: true });
      loanProductResolverService.resolve.mockResolvedValue({
        product: {
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        },
        tier: { minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 },
      });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr1' });

      await service.create('c1', 5000, 6);

      expect(smsProvider.send).toHaveBeenCalledWith('+2348099999999', expect.stringContaining('5000'));
    });
```

Add this new test to the end of the `describe('resend', ...)` block, right before its closing `});`:
```typescript

    it('falls back to the IppisRecord phone when the client has no phone on file', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', clientId: 'c1', status: 'PENDING', amount: 5000 });
      prisma.client.findUniqueOrThrow.mockResolvedValue({
        id: 'c1',
        phone: '',
        onboarding: { ippisRecord: { phone: '+2348099999999' } },
      });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1' });

      await service.resend('c1', 'lr1');

      expect(smsProvider.send).toHaveBeenCalledWith('+2348099999999', expect.stringContaining('5000'));
    });
```

Add this new test to the end of the `describe('createTopup', ...)` block, right before its closing `});`:
```typescript

    it('falls back to the IppisRecord phone when the client has no phone on file', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        ippisRecord: { agency: 'NPF', phone: '+2348099999999' },
      });
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      loanProductResolverService.resolve.mockResolvedValue({
        product: {
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        },
        tier: { minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 6 },
      });
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr2' });

      await service.createTopup('c1', 2000, 12);

      expect(smsProvider.send).toHaveBeenCalledWith('+2348099999999', expect.stringContaining('top-up'));
    });
```

- [ ] **Step 2: Run the spec file to verify the three new tests fail**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: FAIL — the three new tests expect the fallback phone but the SMS still goes to the (empty) `client.phone`.

- [ ] **Step 3: Implement the service changes**

In `src/loan-request/loan-request.service.ts`, add the `resolveSmsPhone` private helper right before `private async sendEmailCopy` (which currently follows `confirmationMessage`):
```typescript
  private resolveSmsPhone(client: { phone: string }, ippisRecord?: { phone: string | null } | null): string {
    return client.phone || ippisRecord?.phone || client.phone;
  }
```

In `create()`, change:
```typescript
    await this.smsProvider.send(client.phone, this.confirmationMessage(amount));
```
to:
```typescript
    await this.smsProvider.send(this.resolveSmsPhone(client, onboarding.ippisRecord), this.confirmationMessage(amount));
```

In `createTopup()`, change:
```typescript
    await this.smsProvider.send(client.phone, this.confirmationMessage(amount, LoanRequestType.TOPUP));
```
to:
```typescript
    await this.smsProvider.send(
      this.resolveSmsPhone(client, onboarding.ippisRecord),
      this.confirmationMessage(amount, LoanRequestType.TOPUP),
    );
```

In `resend()`, change the client lookup from:
```typescript
    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    await this.smsProvider.send(client.phone, this.confirmationMessage(Number(loanRequest.amount)));
```
to:
```typescript
    const client = await this.prisma.client.findUniqueOrThrow({
      where: { id: clientId },
      include: { onboarding: { include: { ippisRecord: true } } },
    });
    await this.smsProvider.send(
      this.resolveSmsPhone(client, client.onboarding?.ippisRecord),
      this.confirmationMessage(Number(loanRequest.amount)),
    );
```

- [ ] **Step 4: Run the spec file to verify it passes**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: PASS (all tests, including the 3 new ones).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/loan-request/loan-request.service.ts src/loan-request/loan-request.service.spec.ts
git commit -m "feat(loan-request): fall back to the linked IppisRecord phone for SMS when the client has none"
```

---

### Task 3: Admin confirms a PENDING request via OTP

**Files:**
- Modify: `src/loan-request/loan-request.service.ts` (refactor `confirmByCode`, add `adminConfirmByCode` + `verifyCodeAndConfirm`)
- Modify: `src/loan-request/loan-request.service.spec.ts`
- Modify: `src/loan-request/admin-loan-request.controller.ts`
- Modify: `src/loan-request/admin-loan-request.controller.spec.ts`

**Interfaces:**
- Consumes: `ConfirmLoanRequestCodeDto` (existing, from `src/loan-request/dto/confirm-loan-request-code.dto.ts` — no new DTO needed, same `{ code: string }` shape already used by the client/agent confirm-code routes).
- Produces: `LoanRequestService.adminConfirmByCode(id: string, code: string): Promise<void>`.

Must land after Task 1 (same file, same general area) and is independent of Task 2's methods — sequential for file safety, not because of a real dependency.

- [ ] **Step 1: Write the failing tests**

In `src/loan-request/loan-request.service.spec.ts`, add a new `describe('adminConfirmByCode', ...)` block right after the existing `describe('confirmByCode', ...)` block closes (after its closing `});`, before `describe('approve', ...)`):
```typescript

  describe('adminConfirmByCode', () => {
    it('throws NotFoundException when the loan request does not exist', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue(null);
      await expect(service.adminConfirmByCode('lr1', '123456')).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when the loan request is not PENDING', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', clientId: 'c1', status: 'CONFIRMED' });
      await expect(service.adminConfirmByCode('lr1', '123456')).rejects.toThrow(ConflictException);
    });

    it('throws UnauthorizedException when the code does not match the stored hash', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({
        id: 'lr1',
        clientId: 'c1',
        status: 'PENDING',
        confirmationCodeHash: hashToken('654321'),
        confirmationCodeExpiresAt: new Date(Date.now() + 60000),
      });
      await expect(service.adminConfirmByCode('lr1', '123456')).rejects.toThrow(UnauthorizedException);
    });

    it('confirms and auto-disburses under the configured threshold on a correct, unexpired code, with no client-ownership check', async () => {
      const configService = { get: jest.fn().mockReturnValue('10000') } as unknown as ConfigService;
      service = new LoanRequestService(
        prisma as unknown as PrismaService,
        eligibilityService as unknown as EligibilityService,
        smsProvider as unknown as TwoWaySmsProvider,
        expiryQueue as unknown as Queue,
        topupEligibilityService as unknown as TopupEligibilityService,
        walletService as unknown as WalletService,
        loanProductResolverService as unknown as LoanProductResolverService,
        configService,
      );
      prisma.loanRequest.findUnique.mockResolvedValue({
        id: 'lr1',
        clientId: 'some-other-client',
        status: 'PENDING',
        confirmationCodeHash: hashToken('123456'),
        confirmationCodeExpiresAt: new Date(Date.now() + 60000),
      });
      prisma.loanRequest.update.mockResolvedValueOnce({ id: 'lr1', amount: 5000 });
      prisma.loanRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'lr1',
        clientId: 'some-other-client',
        amount: 5000,
        tenorMonths: 6,
        managementChargeAmount: 100,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
      });
      prisma.clientOnboarding.findUniqueOrThrow.mockResolvedValue({
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.clientLoan.create.mockResolvedValue({ id: 'cl1' });

      await service.adminConfirmByCode('lr1', '123456');

      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'DISBURSED', approvedAt: expect.any(Date), disbursedAt: expect.any(Date) },
      });
      expect(prisma.clientLoan.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ clientId: 'some-other-client', loanRequestId: 'lr1' }) }),
      );
    });
  });
```

- [ ] **Step 2: Run the spec file to verify the new tests fail**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: FAIL — `service.adminConfirmByCode is not a function`.

- [ ] **Step 3: Implement the service changes**

In `src/loan-request/loan-request.service.ts`, replace `confirmByCode` in full with the refactored version plus the two new methods:
```typescript
  async confirmByCode(clientId: string, id: string, code: string): Promise<void> {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.clientId !== clientId) {
      throw new NotFoundException('Loan request not found');
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

  private async verifyCodeAndConfirm(loanRequest: LoanRequest, code: string): Promise<void> {
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

    await this.confirmPending(loanRequest);
  }
```
(This is a byte-for-byte behavior-preserving refactor for `confirmByCode` itself — none of its 5 existing tests need any changes.)

- [ ] **Step 4: Run the spec file to verify it passes**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: PASS (all tests, including the 4 new `adminConfirmByCode` ones).

- [ ] **Step 5: Write the failing controller test**

In `src/loan-request/admin-loan-request.controller.spec.ts`, add a new `describe('confirmCode', ...)` block at the end of the file, right before the final closing `});`:
```typescript

  describe('confirmCode', () => {
    it('delegates to LoanRequestService.adminConfirmByCode and records an audit log entry', async () => {
      loanRequestService.adminConfirmByCode.mockResolvedValue(undefined);

      const result = await controller.confirmCode('lr1', { code: '123456' }, adminReq);

      expect(loanRequestService.adminConfirmByCode).toHaveBeenCalledWith('lr1', '123456');
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'loan-request.confirm-code', targetId: 'lr1', actorId: 'admin-1' }),
      );
      expect(result).toEqual({ confirmed: true });
    });
  });
```

- [ ] **Step 6: Run the controller spec to verify it fails**

Run: `npx jest src/loan-request/admin-loan-request.controller.spec.ts`
Expected: FAIL — `controller.confirmCode is not a function`.

- [ ] **Step 7: Implement the controller route**

In `src/loan-request/admin-loan-request.controller.ts`, add the import:
```typescript
import { ConfirmLoanRequestCodeDto } from './dto/confirm-loan-request-code.dto';
```
Add the new route (anywhere among the existing `POST :id/...` routes, e.g. right after `approve`):
```typescript
  @Post(':id/confirm-code')
  @HttpCode(200)
  async confirmCode(@Param('id') id: string, @Body() dto: ConfirmLoanRequestCodeDto, @Req() req: { user: JwtPayload }) {
    await this.loanRequestService.adminConfirmByCode(id, dto.code);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'loan-request.confirm-code',
      targetType: 'LoanRequest',
      targetId: id,
    });
    return { confirmed: true };
  }
```

- [ ] **Step 8: Run the controller spec to verify it passes**

Run: `npx jest src/loan-request/admin-loan-request.controller.spec.ts`
Expected: PASS (7/7).

- [ ] **Step 9: Typecheck and run the full loan-request suite**

Run:
```bash
npx jest src/loan-request
npx tsc --noEmit
```
Expected: all PASS, no new type errors.

- [ ] **Step 10: Commit**

```bash
git add src/loan-request/loan-request.service.ts src/loan-request/loan-request.service.spec.ts src/loan-request/admin-loan-request.controller.ts src/loan-request/admin-loan-request.controller.spec.ts
git commit -m "feat(loan-request): let admin confirm a PENDING request via OTP"
```

---

### Task 4: e2e coverage

**Files:**
- Modify: `test/loan-origination.e2e-spec.ts`
- Modify: `test/loan-topup.e2e-spec.ts`

Both files currently call admin `approve` then admin `disburse` as two separate steps — that second call is no longer reachable from a fresh `CONFIRMED` request (Task 1 made `approve` go straight to `DISBURSED`), so both files need their call sequences updated, plus new coverage for the admin confirm-code and enriched-detail endpoints. This task is file-disjoint from Task 5 and can run in parallel with it, once Tasks 1-3 have landed.

- [ ] **Step 1: Fix `test/loan-origination.e2e-spec.ts`'s approve+disburse sequence**

Replace (lines 137-147):
```typescript
      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${loanRequestId}/approve`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200)
        .expect((res) => expect(res.body.status).toBe('APPROVED'));

      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${loanRequestId}/disburse`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200)
        .expect((res) => expect(res.body.status).toBe('DISBURSED'));
```
with:
```typescript
      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${loanRequestId}/approve`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200)
        .expect((res) => expect(res.body.status).toBe('DISBURSED'));
```
Also rename the test's title on line 115 from `'runs the full manual-review flow: request -> confirm -> admin approve -> admin disburse -> ClientLoan exists'` to `'runs the full manual-review flow: request -> confirm -> admin approve (which disburses in one step) -> ClientLoan exists'`.

- [ ] **Step 2: Add admin enrichment + confirm-code e2e coverage to `test/loan-origination.e2e-spec.ts`**

Add this new test right after the "rejects a CONFIRMED request with a reason" test (after its closing `});`, before "returns a CSV for the disbursement summary export"):
```typescript

  it(
    'GET /admin/loan-requests/:id returns the enriched detail with availableActions, and admin can confirm a PENDING request via OTP',
    async () => {
      const { accessToken } = await createVerifiedClient('0000005', 'E');

      const createRes = await request(app.getHttpServer())
        .post('/client/loan-requests')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amount: 120000, tenorMonths: 3 })
        .expect(201);
      const loanRequestId = createRes.body.id;

      const detailRes = await request(app.getHttpServer())
        .get(`/admin/loan-requests/${loanRequestId}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(detailRes.body.availableActions).toEqual(['confirmCode']);
      expect(detailRes.body.client.onboarding.ippisRecord.agency).toBe(agency);

      if (!createRes.body.devCode) {
        // EMAIL_CODE_DEV_ECHO isn't set in this environment -- there's no way
        // to read the real code back out (it's hashed), so this test can only
        // verify the enriched detail shape, not the admin confirm-code path.
        return;
      }

      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${loanRequestId}/confirm-code`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ code: createRes.body.devCode })
        .expect(200)
        .expect({ confirmed: true });

      const confirmed = await prisma.loanRequest.findUniqueOrThrow({ where: { id: loanRequestId } });
      expect(['CONFIRMED', 'DISBURSED']).toContain(confirmed.status);

      // Whether this lands on CONFIRMED (availableActions: ['approve', 'reject'])
      // or auto-disburses straight to DISBURSED (availableActions: []) depends on
      // this environment's LOAN_AUTO_APPROVE_THRESHOLD config, which this test
      // doesn't control -- just confirm the detail endpoint still resolves cleanly
      // with a well-formed availableActions array either way.
      const afterConfirmRes = await request(app.getHttpServer())
        .get(`/admin/loan-requests/${loanRequestId}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(Array.isArray(afterConfirmRes.body.availableActions)).toBe(true);
    },
    20000,
  );

  it(
    'admin can approve with a backdated disbursedAt, which shifts the ClientLoan schedule to match',
    async () => {
      const { client, accessToken } = await createVerifiedClient('0000006', 'F');

      const createRes = await request(app.getHttpServer())
        .post('/client/loan-requests')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amount: 90000, tenorMonths: 3 })
        .expect(201);
      const loanRequestId = createRes.body.id;

      await request(app.getHttpServer())
        .post('/webhooks/sms/inbound')
        .send({ phone: client.phone, message: 'YES' })
        .expect(200);

      const backdated = '2026-01-01T00:00:00.000Z';
      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${loanRequestId}/approve`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ disbursedAt: backdated })
        .expect(200)
        .expect((res) => expect(res.body.disbursedAt).toBe(backdated));

      const clientLoan = await prisma.clientLoan.findUniqueOrThrow({ where: { loanRequestId } });
      expect(clientLoan.disbursementDate.toISOString()).toBe(backdated);
      expect(clientLoan.maturationDate.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    },
    20000,
  );

  it('rejects a future disbursedAt on approve with 400', async () => {
    const { client, accessToken } = await createVerifiedClient('0000007', 'G');

    const createRes = await request(app.getHttpServer())
      .post('/client/loan-requests')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 50000, tenorMonths: 3 })
      .expect(201);
    const loanRequestId = createRes.body.id;

    await request(app.getHttpServer())
      .post('/webhooks/sms/inbound')
      .send({ phone: client.phone, message: 'YES' })
      .expect(200);

    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await request(app.getHttpServer())
      .post(`/admin/loan-requests/${loanRequestId}/approve`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ disbursedAt: future })
      .expect(400);
  });
```

- [ ] **Step 3: Fix `test/loan-topup.e2e-spec.ts`'s two approve+disburse sequences**

Replace the one inside `originateAndDisburseLoan` (lines 104-111):
```typescript
    await request(app.getHttpServer())
      .post(`/admin/loan-requests/${loanRequestId}/approve`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/admin/loan-requests/${loanRequestId}/disburse`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
```
with:
```typescript
    await request(app.getHttpServer())
      .post(`/admin/loan-requests/${loanRequestId}/approve`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
```

Replace the one inside "runs a full renewal flow..." (lines 169-176):
```typescript
      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${topupId}/approve`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${topupId}/disburse`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
```
with:
```typescript
      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${topupId}/approve`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
```

- [ ] **Step 4: Run both e2e files**

Run:
```bash
npx jest --config ./test/jest-e2e.json test/loan-origination.e2e-spec.ts test/loan-topup.e2e-spec.ts
```
Expected: PASS.

- [ ] **Step 5: Run the full e2e suite once to check for cross-suite regressions**

Run: `npx jest --config ./test/jest-e2e.json`
Expected: PASS (isolated re-runs of any transient DB-contention failures should pass alone, per this project's established flakiness baseline).

- [ ] **Step 6: Commit**

```bash
git add test/loan-origination.e2e-spec.ts test/loan-topup.e2e-spec.ts
git commit -m "test(e2e): cover admin loan-request enrichment, confirm-code, and one-step approve+disburse"
```

---

### Task 5: Postman sync

**Files:**
- Modify: `postman/public-sector-backend.postman_collection.json`

This task is file-disjoint from Task 4 and can run in parallel with it, once Tasks 1-3 have landed.

- [ ] **Step 1: Update the existing `Admin > Loan Requests` list/approve/reject/disburse saved response examples**

Find the existing `GET /admin/loan-requests` request's saved response example(s) and add the new enriched `client.onboarding`/`ippisRecord` fields and `availableActions` to each row, matching the shapes in this plan's Task 1. Do the same for the `POST :id/approve`, `POST :id/reject`, and `POST :id/disburse` requests' saved success examples — all now return the enriched `include` shape too (via the shared `LOAN_REQUEST_RELATIONS_INCLUDE` constant).

- [ ] **Step 2: Update the approve and disburse requests' bodies**

Add an optional `disbursedAt` field (ISO 8601 string) to both the `POST :id/approve` and `POST :id/disburse` requests' example bodies, and add a new saved response example to the approve request for a future-dated `disbursedAt`: `{ "statusCode": 400, "message": "disbursedAt cannot be in the future", "error": "Bad Request" }`.

- [ ] **Step 3: Add the new `GET /admin/loan-requests/:id` request**

Add it to the `Admin > Loan Requests` folder, alongside the existing list request. Saved response: the enriched detail shape (same fields as a list row) plus a 404 example: `{ "statusCode": 404, "message": "Loan request not found", "error": "Not Found" }`.

- [ ] **Step 4: Add the new `POST /admin/loan-requests/:id/confirm-code` request**

Add it to the same folder. Saved response examples:
- **Success (200):** `{ "confirmed": true }`
- **Invalid/expired code (401):** `{ "statusCode": 401, "message": "Invalid or expired verification code", "error": "Unauthorized" }`
- **Not PENDING (409):** `{ "statusCode": 409, "message": "Loan request is not PENDING (currently CONFIRMED)", "error": "Conflict" }`

- [ ] **Step 5: Validate the collection is still well-formed JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('postman/public-sector-backend.postman_collection.json', 'utf8')); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 6: Commit**

```bash
git add postman/public-sector-backend.postman_collection.json
git commit -m "docs(postman): add admin loan-request enrichment, confirm-code, and disbursedAt fields"
```
