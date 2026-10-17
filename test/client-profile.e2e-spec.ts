import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Client profile (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokenService: TokenService;
  let clientId: string;
  let accessToken: string;
  const phone = `+234899${Date.now().toString().slice(-7)}`;
  const createdAgentIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    tokenService = moduleFixture.get(TokenService);

    const client = await prisma.client.create({
      data: { phone, status: 'VERIFIED', email: `e2e-client-profile-${Date.now()}@example.com` },
    });
    clientId = client.id;
    accessToken = tokenService.signAccessToken({ sub: clientId, type: 'client' });
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { id: clientId } });
    await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } });
    await app.close();
  });

  it("returns the client's own profile fields", async () => {
    const res = await request(app.getHttpServer())
      .get('/client/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.id).toBe(clientId);
    expect(res.body.phone).toBe(phone);
    expect(res.body.status).toBe('VERIFIED');
  });

  it('rejects an agent token', async () => {
    const agent = await prisma.agent.create({
      data: {
        email: `e2e-agent-vs-client-${Date.now()}@example.com`,
        phone: '+2348012340098',
        fullName: 'E2E Vs Client Agent',
        address: '1 Example Street',
        status: 'APPROVED',
        cvKey: 'agents/e2e/vs-client.pdf',
      },
    });
    createdAgentIds.push(agent.id);
    const agentToken = tokenService.signAccessToken({ sub: agent.id, type: 'agent' });

    await request(app.getHttpServer())
      .get('/client/me')
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(403);
  });

  it('rejects unauthenticated access', () => {
    return request(app.getHttpServer()).get('/client/me').expect(401);
  });
});
