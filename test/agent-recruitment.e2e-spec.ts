import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EMAIL_PROVIDERS, EmailMessage } from '../src/email/email-provider.interface';
import { SAMPLE_JPEG_BUFFER, SAMPLE_PDF_BUFFER } from './fixtures/sample-files';

describe('Agent recruitment (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let capturedEmails: EmailMessage[];
  let adminAccessToken: string;
  const createdAgentIds: string[] = [];
  const createdApplicationEmails: string[] = [];

  function latestCodeFor(email: string): string {
    const match = [...capturedEmails]
      .reverse()
      .find((m) => m.to === email && /verification code is: (\d+)/.test(m.text ?? ''));
    const codeMatch = match?.text?.match(/verification code is: (\d+)/);
    if (!codeMatch) {
      throw new Error(`No verification code email found for ${email}`);
    }
    return codeMatch[1];
  }

  beforeAll(async () => {
    capturedEmails = [];
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMAIL_PROVIDERS)
      .useValue([
        {
          name: 'test-capture',
          send: async (message: EmailMessage) => {
            capturedEmails.push(message);
          },
        },
      ])
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD });
    adminAccessToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } });
    await prisma.agentApplication.deleteMany({ where: { email: { in: createdApplicationEmails } } });
    await app.close();
  });

  it(
    'runs the full recruitment journey: request code -> confirm -> NIN verify -> submit -> appears in admin list',
    async () => {
      const email = `e2e-recruit-${Date.now()}@example.com`;
      createdApplicationEmails.push(email);

      await request(app.getHttpServer())
        .post('/agents/recruitment/email/request-code')
        .send({ email })
        .expect(200)
        .expect({ sent: true });

      const code = latestCodeFor(email);
      const confirmRes = await request(app.getHttpServer())
        .post('/agents/recruitment/email/confirm-code')
        .send({ email, code })
        .expect(200);
      const applicationToken = confirmRes.body.applicationToken;
      expect(typeof applicationToken).toBe('string');

      const ninRes = await request(app.getHttpServer())
        .post('/agents/recruitment/nin/verify')
        .set('Authorization', `Bearer ${applicationToken}`)
        .send({ nin: '12345678901' })
        .expect(200);
      expect(ninRes.body.ninVerified).toBe(true);
      expect(typeof ninRes.body.ninVerifiedName).toBe('string');

      const statusRes = await request(app.getHttpServer())
        .get('/agents/recruitment/status')
        .set('Authorization', `Bearer ${applicationToken}`)
        .expect(200);
      expect(statusRes.body.status).toBe('EMAIL_VERIFIED');
      expect(statusRes.body.ninVerified).toBe(true);

      const submitRes = await request(app.getHttpServer())
        .post('/agents/recruitment/submit')
        .set('Authorization', `Bearer ${applicationToken}`)
        .field('fullName', 'E2E Recruit')
        .field('phone', '+2348012345678')
        .field('gender', 'Female')
        .field('address', '1 Example Street')
        .field('city', 'Lagos')
        .field('state', 'Lagos')
        .field('localGovernment', 'Ikeja')
        .field('nin', '12345678901')
        .field('coverLetter', 'I would like to join as an agent.')
        .attach('cv', SAMPLE_PDF_BUFFER, 'cv.pdf')
        .attach('passportPhoto', SAMPLE_JPEG_BUFFER, 'photo.jpg')
        .expect(201);
      expect(submitRes.body.status).toBe('PENDING_REVIEW');
      const agentId = submitRes.body.id;
      createdAgentIds.push(agentId);

      // The default (no status filter) agent list now only shows APPROVED
      // agents -- a freshly submitted one is still PENDING_REVIEW, so it's
      // absent there, but still reachable via an explicit status filter.
      const defaultListRes = await request(app.getHttpServer())
        .get('/admin/agents')
        .query({ q: 'E2E Recruit' })
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(defaultListRes.body.data.some((a: { id: string }) => a.id === agentId)).toBe(false);

      const pendingListRes = await request(app.getHttpServer())
        .get('/admin/agents')
        .query({ q: 'E2E Recruit', status: 'PENDING_REVIEW' })
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(pendingListRes.body.data.some((a: { id: string }) => a.id === agentId)).toBe(true);
    },
    20000,
  );

  it('resumes after re-requesting a code, losing nothing already filled in', async () => {
    const email = `e2e-resume-${Date.now()}@example.com`;
    createdApplicationEmails.push(email);

    await request(app.getHttpServer()).post('/agents/recruitment/email/request-code').send({ email }).expect(200);
    const firstCode = latestCodeFor(email);
    const firstConfirm = await request(app.getHttpServer())
      .post('/agents/recruitment/email/confirm-code')
      .send({ email, code: firstCode })
      .expect(200);

    await request(app.getHttpServer())
      .post('/agents/recruitment/nin/verify')
      .set('Authorization', `Bearer ${firstConfirm.body.applicationToken}`)
      .send({ nin: '12345678901' })
      .expect(200);

    // Simulate coming back later: request a fresh code for the same email.
    await request(app.getHttpServer()).post('/agents/recruitment/email/request-code').send({ email }).expect(200);
    const secondCode = latestCodeFor(email);
    const secondConfirm = await request(app.getHttpServer())
      .post('/agents/recruitment/email/confirm-code')
      .send({ email, code: secondCode })
      .expect(200);

    const statusRes = await request(app.getHttpServer())
      .get('/agents/recruitment/status')
      .set('Authorization', `Bearer ${secondConfirm.body.applicationToken}`)
      .expect(200);
    expect(statusRes.body.ninVerified).toBe(true);
    expect(statusRes.body.status).toBe('EMAIL_VERIFIED');
  });

  it(
    'rejects requesting a code for an email that already has an Agent application',
    async () => {
      const email = `e2e-duplicate-${Date.now()}@example.com`;
      createdApplicationEmails.push(email);

      await request(app.getHttpServer()).post('/agents/recruitment/email/request-code').send({ email }).expect(200);
      const code = latestCodeFor(email);
      const confirmRes = await request(app.getHttpServer())
        .post('/agents/recruitment/email/confirm-code')
        .send({ email, code })
        .expect(200);

      const submitRes = await request(app.getHttpServer())
        .post('/agents/recruitment/submit')
        .set('Authorization', `Bearer ${confirmRes.body.applicationToken}`)
        .field('fullName', 'E2E Duplicate')
        .field('phone', '+2348012345679')
        .field('gender', 'Male')
        .field('address', '1 Example Street')
        .field('city', 'Lagos')
        .field('state', 'Lagos')
        .field('localGovernment', 'Ikeja')
        .field('nin', '12345678901')
        .field('coverLetter', 'Cover letter.')
        .attach('cv', SAMPLE_PDF_BUFFER, 'cv.pdf')
        .attach('passportPhoto', SAMPLE_JPEG_BUFFER, 'photo.jpg')
        .expect(201);
      createdAgentIds.push(submitRes.body.id);

      await request(app.getHttpServer())
        .post('/agents/recruitment/email/request-code')
        .send({ email })
        .expect(409);
    },
    20000,
  );

  it(
    'admin rejection emails the applicant with the reason',
    async () => {
      const email = `e2e-reject-${Date.now()}@example.com`;
      createdApplicationEmails.push(email);

      await request(app.getHttpServer()).post('/agents/recruitment/email/request-code').send({ email }).expect(200);
      const code = latestCodeFor(email);
      const confirmRes = await request(app.getHttpServer())
        .post('/agents/recruitment/email/confirm-code')
        .send({ email, code })
        .expect(200);

      const submitRes = await request(app.getHttpServer())
        .post('/agents/recruitment/submit')
        .set('Authorization', `Bearer ${confirmRes.body.applicationToken}`)
        .field('fullName', 'E2E Reject')
        .field('phone', '+2348012345680')
        .field('gender', 'Female')
        .field('address', '1 Example Street')
        .field('city', 'Lagos')
        .field('state', 'Lagos')
        .field('localGovernment', 'Ikeja')
        .field('nin', '12345678901')
        .field('coverLetter', 'Cover letter.')
        .attach('cv', SAMPLE_PDF_BUFFER, 'cv.pdf')
        .attach('passportPhoto', SAMPLE_JPEG_BUFFER, 'photo.jpg')
        .expect(201);
      const agentId = submitRes.body.id;
      createdAgentIds.push(agentId);

      await request(app.getHttpServer())
        .post(`/admin/agents/${agentId}/reject`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ reason: 'Incomplete documentation' })
        .expect(200)
        .expect({ rejected: true });

      const rejectionEmail = [...capturedEmails]
        .reverse()
        .find((m) => m.to === email && /update on your agent application/.test(m.subject ?? ''));
      expect(rejectionEmail).toBeDefined();
      expect(rejectionEmail?.text).toContain('Incomplete documentation');
    },
    20000,
  );

  it('returns an analytics summary with totals and breakdowns', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/agents/analytics')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    expect(res.body.totalApplications).toBeGreaterThanOrEqual(1);
    expect(res.body.byStatus).toEqual(
      expect.objectContaining({
        PENDING_REVIEW: expect.any(Number),
        APPROVED: expect.any(Number),
        REJECTED: expect.any(Number),
      }),
    );
    expect(Array.isArray(res.body.reviewerLeaderboard)).toBe(true);
    expect(res.body.activity).toEqual(
      expect.objectContaining({ totalApproved: expect.any(Number), totalRejected: expect.any(Number) }),
    );
  });
});
