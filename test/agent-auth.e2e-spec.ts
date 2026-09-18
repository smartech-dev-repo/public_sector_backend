import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as bcrypt from 'bcrypt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Agent auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = 'approved-agent@example.com';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const passwordHash = await bcrypt.hash('agent-password', 12);
    await prisma.agent.create({
      data: {
        email,
        phone: '+2348022222222',
        fullName: 'Test Agent',
        address: '1 Example Street, Lagos',
        cvKey: 'agent-documents/test-agent/cv.pdf',
        passwordHash,
        status: 'APPROVED',
      },
    });
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { email } });
    await app.close();
  });

  it('logs in an approved agent with the right password', () => {
    return request(app.getHttpServer())
      .post('/auth/agent/login')
      .send({ email, password: 'agent-password' })
      .expect(200)
      .expect((res) => {
        expect(typeof res.body.accessToken).toBe('string');
      });
  });

  it('rejects the right password for a non-existent agent', () => {
    return request(app.getHttpServer())
      .post('/auth/agent/login')
      .send({ email: 'nobody@example.com', password: 'agent-password' })
      .expect(401);
  });
});
