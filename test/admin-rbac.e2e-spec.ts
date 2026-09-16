import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Admin RBAC (e2e)', () => {
  let app: INestApplication;
  let accessToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });
    accessToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects unauthenticated requests to /admin/me', () => {
    return request(app.getHttpServer()).get('/admin/me').expect(401);
  });

  it('allows the bootstrap super-admin to read /admin/me', () => {
    return request(app.getHttpServer())
      .get('/admin/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.type).toBe('admin');
        expect(res.body.permissions).toContain('roles:manage');
      });
  });

  it('allows the bootstrap super-admin to hit a roles:manage-gated route', () => {
    return request(app.getHttpServer())
      .get('/admin/roles')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  });
});
