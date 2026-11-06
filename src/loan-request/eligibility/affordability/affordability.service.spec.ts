import { UnprocessableEntityException } from '@nestjs/common';
import { AffordabilityAssessment, AffordabilityService } from './affordability.service';

const product = (over: Record<string, unknown> = {}) => ({
  id: 'prod-1',
  productName: 'Salary Loan',
  productCode: 'SAL',
  minimumAmount: 50000,
  maximumAmount: 5000000,
  managementChargeType: 'PERCENTAGE',
  managementChargeValue: 2,
  managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
  ...over,
});
const tier = { minTenorMonths: 1, maxTenorMonths: 24, interestRatePercent: 2 };

/** The assessment for ₦30,000 usable pay over 12 months at 2%: maximum ₦290,000. */
const assessment = (over: Partial<AffordabilityAssessment> = {}): AffordabilityAssessment => ({
  type: 'LOAN',
  tenorMonths: 12,
  eligible: true,
  maxAmount: 290000,
  salary: { paymentThreeMonthsAgo: 80000, paymentTwoMonthsAgo: 80000, paymentLastMonth: 80000, pattern: 'AAA', outcome: 'A', salaryUsed: 80000 },
  repaymentAddedBack: 0,
  capacity: { method: 'BASE_PAY_DTI', basePayAmount: 50000, dtiPercent: 40, source: 'SECTOR', usablePay: 30000, limitedBy: 'BASE_PAY' },
  product: null,
  paybackRatio: 1.24,
  currentLoan: null,
  newLoanTotal: 290000,
  monthlyRepayment: 29966.67,
  assessedAt: new Date().toISOString(),
  ...over,
});

describe('AffordabilityService.checkAmount', () => {
  const ippis = { agency: 'NPF' } as never;
  let resolver: { resolve: jest.Mock; candidatesForTenor: jest.Mock };
  let service: AffordabilityService;
  let assess: jest.SpyInstance;

  beforeEach(() => {
    resolver = { resolve: jest.fn().mockResolvedValue({ product: product(), tier }), candidatesForTenor: jest.fn() };
    service = new AffordabilityService({} as never, {} as never, {} as never, resolver as never);
    assess = jest.spyOn(service, 'assess').mockResolvedValue(assessment());
  });

  it('an amount within the maximum is accepted, with its own repayment, charge and payout', async () => {
    const check = await service.checkAmount('client-1', ippis, 150000, assessment());
    expect(resolver.resolve).toHaveBeenCalledWith(ippis, 150000, 12);
    expect(check).toEqual({
      amount: 150000,
      eligible: true,
      product: { id: 'prod-1', name: 'Salary Loan', code: 'SAL', monthlyRatePercent: 2 },
      managementCharge: { amount: 3000, application: 'DEDUCT_FROM_DISBURSEMENT' },
      disbursedAmount: 147000,
      newLoanTotal: 150000,
      // 150,000 × 1.24 / 12
      monthlyRepayment: 15500,
      totalRepayment: 186000,
      repaymentHeadroom: 14500,
    });
  });

  it('an amount above the maximum is refused with the same message as the request, but still priced', async () => {
    const check = await service.checkAmount('client-1', ippis, 400000, assessment());
    expect(check.eligible).toBe(false);
    expect(check.reason).toBe('For 12 months, the most you can borrow is ₦290,000');
    expect(check.monthlyRepayment).toBe(41333.33);
    expect(check.repaymentHeadroom).toBe(-11333.33);
    // From the exact figure, not 41,333.33 × 12.
    expect(check.totalRepayment).toBe(496000);
    expect(assess).not.toHaveBeenCalled();
  });

  it('an amount no product covers says why, without a price', async () => {
    resolver.resolve.mockRejectedValue(new UnprocessableEntityException('No loan product matches this amount/tenor for your agency'));
    const check = await service.checkAmount('client-1', ippis, 20000, assessment());
    expect(check).toMatchObject({ eligible: false, reason: 'No loan product matches this amount/tenor for your agency', product: null, monthlyRepayment: null });
  });

  it('a client who is not eligible at all gets that reason first', async () => {
    resolver.resolve.mockRejectedValue(new UnprocessableEntityException('No loan product matches this amount/tenor for your agency'));
    const check = await service.checkAmount('client-1', ippis, 100000, assessment({ eligible: false, maxAmount: 0, reason: 'Salary leaves nothing for a monthly repayment' }));
    expect(check.reason).toBe('Salary leaves nothing for a monthly repayment');
  });

  it('a top-up resolves the product on balance + top-up and repays the balance too', async () => {
    const best = assessment({ type: 'TOPUP', maxAmount: 190000, currentLoan: { source: 'APP', id: 'loan-1', outstandingBalance: 100000, monthlyRepayment: 9000 } });
    assess.mockResolvedValue(best);
    const check = await service.checkAmount('client-1', ippis, 50000, best);
    expect(resolver.resolve).toHaveBeenCalledWith(ippis, 150000, 12);
    expect(check).toMatchObject({ eligible: true, newLoanTotal: 150000, disbursedAmount: 49000, monthlyRepayment: 15500 });
    expect(check.managementCharge).toEqual({ amount: 1000, application: 'DEDUCT_FROM_DISBURSEMENT' });
  });

  it('the product the amount falls under can allow less than the best one', async () => {
    assess.mockResolvedValue(assessment({ maxAmount: 120000 }));
    const check = await service.checkAmount('client-1', ippis, 150000, assessment());
    expect(check.eligible).toBe(false);
    expect(check.reason).toBe('For 12 months, the most you can borrow is ₦120,000');
  });
});

describe('AffordabilityService.preview with an amount', () => {
  it('adds the amount check, and leaves it null without one', async () => {
    const prisma = {
      clientOnboarding: { findUnique: jest.fn().mockResolvedValue({ ippisRecord: { agency: 'NPF' } }) },
      loanProduct: { aggregate: jest.fn().mockResolvedValue({ _min: { minimumTenorMonths: 1 }, _max: { maximumTenorMonths: 24 } }) },
    };
    const service = new AffordabilityService(prisma as never, {} as never, {} as never, {} as never);
    jest.spyOn(service, 'assess').mockResolvedValue(assessment());
    const check = { amount: 150000, eligible: true } as never;
    const checkAmount = jest.spyOn(service, 'checkAmount').mockResolvedValue(check);

    const without = await service.preview('client-1', 12, 'LOAN');
    expect(without.requested).toBeNull();
    expect(checkAmount).not.toHaveBeenCalled();

    const withAmount = await service.preview('client-1', 12, 'LOAN', 150000);
    expect(withAmount.requested).toBe(check);
    expect(withAmount.maxAmount).toBe(290000);
  });
});
