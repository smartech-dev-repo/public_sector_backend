import * as request from 'supertest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin departments (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  const departmentName = `E2E-Department-${Date.now()}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD });
    adminAccessToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await prisma.role.deleteMany({ where: { name: { startsWith: 'E2E-DEPT-ROLE-' } } });
    await prisma.department.deleteMany({ where: { name: departmentName } });
    await app.close();
  });

  it('creates, lists, updates, and deletes a department; blocks deleting one still assigned to a role', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/admin/departments')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ name: departmentName, description: 'E2E test department' })
      .expect(201);
    const departmentId = createRes.body.id;

    const listRes = await request(app.getHttpServer())
      .get('/admin/departments')
      .query({ q: departmentName })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(listRes.body.data.some((d: { id: string }) => d.id === departmentId)).toBe(true);

    await request(app.getHttpServer())
      .patch(`/admin/departments/${departmentId}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ description: 'Updated description' })
      .expect(200)
      .expect((res) => expect(res.body.description).toBe('Updated description'));

    const roleRes = await request(app.getHttpServer())
      .post('/admin/roles')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ name: `E2E-DEPT-ROLE-${Date.now()}`, departmentId })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/admin/departments/${departmentId}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(409);

    await prisma.role.deleteMany({ where: { id: roleRes.body.id } });

    await request(app.getHttpServer())
      .delete(`/admin/departments/${departmentId}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200)
      .expect({ deleted: true });
  });

  it('rejects creating a department without a name (400)', () => {
    return request(app.getHttpServer())
      .post('/admin/departments')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ description: 'No name provided' })
      .expect(400);
  });

  it('rejects unauthenticated access (401)', () => {
    return request(app.getHttpServer()).get('/admin/departments').expect(401);
  });
});
