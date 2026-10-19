import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Agent loan-products (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const staffId = `E2E-AGENT-LP-${Date.now()}`;
  const agency = 'NPF';
  const productCode = `E2E-AGENT-LP-PRODUCT-${Date.now()}`;
  let agentId: string;
  let agentAccessToken: string;
  let otherAgentAccessToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    await prisma.loanProduct.create({
      data: {
        productName: 'E2E Agent Loan Products Product',
        productCode,
        sectors: [agency],
        minimumAmount: 1000,
        maximumAmount: 1000000,
        minimumTenorMonths: 3,
        maximumTenorMonths: 3,
        interestTiers: [{ minTenorMonths: 3, maxTenorMonths: 3, interestRatePercent: 5 }],
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
      },
    });

    const agent = await prisma.agent.create({
      data: {
        email: `${staffId}-agent@example.com`,
        phone: '+2348060000001',
        fullName: 'E2E Agent LP Test',
        address: '1 Test Street',
        cvKey: 'e2e/cv.pdf',
        status: 'APPROVED',
        mustChangePassword: false,
      },
    });
    agentId = agent.id;
    const otherAgent = await prisma.agent.create({
      data: {
        email: `${staffId}-other-agent@example.com`,
        phone: '+2348060000002',
        fullName: 'E2E Agent LP Other',
        address: '1 Test Street',
        cvKey: 'e2e/cv.pdf',
        status: 'APPROVED',
        mustChangePassword: false,
      },
    });

    const tokenService = moduleFixture.get(TokenService);
    agentAccessToken = tokenService.signAccessToken({ sub: agentId, type: 'agent' });
    otherAgentAccessToken = tokenService.signAccessToken({ sub: otherAgent.id, type: 'agent' });
  });

  afterAll(async () => {
    const clientIds = (
      await prisma.clientOnboarding.findMany({
        where: { ippisRecord: { staffId: { startsWith: staffId } } },
        select: { clientId: true },
      })
    ).map((c) => c.clientId);
    await prisma.clientOnboarding.deleteMany({ where: { ippisRecord: { staffId: { startsWith: staffId } } } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { startsWith: staffId } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await prisma.agent.deleteMany({ where: { email: { startsWith: staffId } } });
    await prisma.loanProduct.deleteMany({ where: { productCode } });
    await app.close();
  });

  it('lists the eligible loan products for a client the agent onboarded', async () => {
    const client = await prisma.client.create({ data: { phone: '+2348070000001', status: 'VERIFIED' } });
    const ippisRecord = await prisma.ippisRecord.create({
      data: { agency, staffId: `${staffId}-A`, employeeName: 'E2E Agent LP Client', salary: 1000000 },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId: client.id,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E Agent LP Client',
        agency,
        step: 'COMPLETED',
        onboardedByAgentId: agentId,
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/agent/clients/${client.id}/loan-products`)
      .set('Authorization', `Bearer ${agentAccessToken}`)
      .expect(200);

    expect(res.body.mode).toBe('NEW_LOAN');
    expect(res.body.eligible).toBe(true);
    expect(res.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ productCode })]));
  });

  it('returns 404 when the client was not onboarded by the calling agent', async () => {
    const client = await prisma.client.create({ data: { phone: '+2348070000002', status: 'VERIFIED' } });
    const ippisRecord = await prisma.ippisRecord.create({
      data: { agency, staffId: `${staffId}-B`, employeeName: 'E2E Agent LP Client 2', salary: 1000000 },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId: client.id,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E Agent LP Client 2',
        agency,
        step: 'COMPLETED',
        onboardedByAgentId: agentId,
      },
    });

    await request(app.getHttpServer())
      .get(`/agent/clients/${client.id}/loan-products`)
      .set('Authorization', `Bearer ${otherAgentAccessToken}`)
      .expect(404);
  });

  it('returns 404 for a clientId that does not exist at all', async () => {
    await request(app.getHttpServer())
      .get('/agent/clients/00000000-0000-0000-0000-000000000000/loan-products')
      .set('Authorization', `Bearer ${agentAccessToken}`)
      .expect(404);
  });
});
