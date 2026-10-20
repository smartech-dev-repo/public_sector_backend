import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EMAIL_PROVIDERS, EmailMessage } from '../src/email/email-provider.interface';

describe('Admin agent recruitment applications (e2e)', () => {
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

  async function createVerifiedDraft(email: string): Promise<string> {
    await request(app.getHttpServer()).post('/agents/recruitment/email/request-code').send({ email }).expect(200);
    const code = latestCodeFor(email);
    const confirmRes = await request(app.getHttpServer())
      .post('/agents/recruitment/email/confirm-code')
      .send({ email, code })
      .expect(200);
    return confirmRes.body.applicationToken;
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
    'lists an in-progress draft, fetches it by id, reflects it in analytics, and allows deleting it',
    async () => {
      const email = `e2e-admin-draft-${Date.now()}@example.com`;
      createdApplicationEmails.push(email);
      await createVerifiedDraft(email);

      const listRes = await request(app.getHttpServer())
        .get('/admin/agent-recruitment-applications')
        .query({ q: email })
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      const row = listRes.body.data.find((a: { email: string }) => a.email === email);
      expect(row).toBeDefined();
      expect(row.status).toBe('EMAIL_VERIFIED');
      expect(row.submittedAgent).toBeNull();
      expect(row).not.toHaveProperty('emailCodeHash');

      const detailRes = await request(app.getHttpServer())
        .get(`/admin/agent-recruitment-applications/${row.id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(detailRes.body.email).toBe(email);

      const analyticsRes = await request(app.getHttpServer())
        .get('/admin/agent-recruitment-applications/analytics')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(analyticsRes.body.totalApplications).toBeGreaterThanOrEqual(1);
      expect(analyticsRes.body.byStatus).toEqual(
        expect.objectContaining({
          EMAIL_PENDING: expect.any(Number),
          EMAIL_VERIFIED: expect.any(Number),
          SUBMITTED: expect.any(Number),
        }),
      );

      await request(app.getHttpServer())
        .delete(`/admin/agent-recruitment-applications/${row.id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200)
        .expect({ deleted: true });

      await request(app.getHttpServer())
        .get(`/admin/agent-recruitment-applications/${row.id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(404);
    },
    20000,
  );

  it(
    'blocks deleting a submitted application with a 409',
    async () => {
      const email = `e2e-admin-submitted-${Date.now()}@example.com`;
      createdApplicationEmails.push(email);
      const applicationToken = await createVerifiedDraft(email);

      const submitRes = await request(app.getHttpServer())
        .post('/agents/recruitment/submit')
        .set('Authorization', `Bearer ${applicationToken}`)
        .field('fullName', 'E2E Admin Submitted')
        .field('phone', '+2348012399999')
        .field('gender', 'Male')
        .field('address', '1 Example Street')
        .field('city', 'Lagos')
        .field('state', 'Lagos')
        .field('localGovernment', 'Ikeja')
        .field('nin', '12345678901')
        .field('coverLetter', 'Cover letter.')
        .attach('cv', Buffer.from('fake cv content'), 'cv.pdf')
        .attach('passportPhoto', Buffer.from('fake photo content'), 'photo.jpg')
        .expect(201);
      createdAgentIds.push(submitRes.body.id);

      const listRes = await request(app.getHttpServer())
        .get('/admin/agent-recruitment-applications')
        .query({ q: email })
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      const row = listRes.body.data.find((a: { email: string }) => a.email === email);
      expect(row.status).toBe('SUBMITTED');
      expect(row.submittedAgent).toEqual({ id: submitRes.body.id, status: 'PENDING_REVIEW' });
      expect(row).not.toHaveProperty('cvKey');
      expect(row).not.toHaveProperty('passportPhotoKey');
      expect(row).not.toHaveProperty('identityDocumentKey');

      const stored = await prisma.agentApplication.findUniqueOrThrow({ where: { id: row.id } });
      expect(row.cvUrl).toContain(encodeURIComponent(stored.cvKey!));
      expect(row.passportPhotoUrl).toContain(encodeURIComponent(stored.passportPhotoKey!));

      const detailRes = await request(app.getHttpServer())
        .get(`/admin/agent-recruitment-applications/${row.id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(detailRes.body).not.toHaveProperty('cvKey');
      expect(detailRes.body).not.toHaveProperty('passportPhotoKey');
      expect(detailRes.body).not.toHaveProperty('identityDocumentKey');
      expect(detailRes.body.cvUrl).toContain(encodeURIComponent(stored.cvKey!));
      expect(detailRes.body.passportPhotoUrl).toContain(encodeURIComponent(stored.passportPhotoKey!));
      expect(detailRes.body.identityDocumentUrl).toBeNull();

      await request(app.getHttpServer())
        .delete(`/admin/agent-recruitment-applications/${row.id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(409);
    },
    20000,
  );
});
