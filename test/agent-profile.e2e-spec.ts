import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Agent profile (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokenService: TokenService;
  let agentId: string;
  let accessToken: string;
  const createdClientIds: string[] = [];
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

    const agent = await prisma.agent.create({
      data: {
        email: `e2e-agent-profile-${Date.now()}@example.com`,
        phone: '+2348012340099',
        fullName: 'E2E Profile Agent',
        address: '1 Example Street',
        status: 'APPROVED',
        cvKey: 'agents/e2e/profile.pdf',
      },
    });
    agentId = agent.id;
    createdAgentIds.push(agentId);
    accessToken = tokenService.signAccessToken({ sub: agentId, type: 'agent' });
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
    await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } });
    await app.close();
  });

  it("returns the agent's own profile fields, excluding passwordHash", async () => {
    const res = await request(app.getHttpServer())
      .get('/agent/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.id).toBe(agentId);
    expect(res.body.fullName).toBe('E2E Profile Agent');
    expect(res.body.status).toBe('APPROVED');
    expect(res.body).not.toHaveProperty('passwordHash');
  });

  it('rejects a client token', async () => {
    const client = await prisma.client.create({ data: { phone: `+2348099${Date.now().toString().slice(-6)}` } });
    createdClientIds.push(client.id);
    const clientToken = tokenService.signAccessToken({ sub: client.id, type: 'client' });

    await request(app.getHttpServer())
      .get('/agent/me')
      .set('Authorization', `Bearer ${clientToken}`)
      .expect(403);
  });

  it('rejects unauthenticated access', () => {
    return request(app.getHttpServer()).get('/agent/me').expect(401);
  });
});
