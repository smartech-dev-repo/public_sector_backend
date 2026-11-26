-- CreateEnum
CREATE TYPE "ClientAssignmentKind" AS ENUM ('AGENT', 'ADMIN');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'RELEASED');

-- CreateEnum
CREATE TYPE "DeviceReleaseStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "assignedAdminId" TEXT,
ADD COLUMN     "assignedAgentId" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "deviceId" TEXT;

-- CreateTable
CREATE TABLE "ClientAssignment" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" "ClientAssignmentKind" NOT NULL,
    "fromId" TEXT,
    "toId" TEXT,
    "reason" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientLinkRequest" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientLinkRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "principalType" "SessionPrincipalType" NOT NULL,
    "principalId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "imei" TEXT,
    "deviceName" TEXT,
    "brand" TEXT,
    "model" TEXT,
    "platform" TEXT,
    "osVersion" TEXT,
    "appVersion" TEXT,
    "pushToken" TEXT,
    "status" "DeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "releasedByAdminId" TEXT,
    "releaseReason" TEXT,
    "releaseProofKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceReleaseRequest" (
    "id" TEXT NOT NULL,
    "principalType" "SessionPrincipalType" NOT NULL,
    "principalId" TEXT NOT NULL,
    "deviceId" TEXT,
    "requestedFingerprint" TEXT,
    "requestedDeviceName" TEXT,
    "requestedBrand" TEXT,
    "requestedModel" TEXT,
    "requestedPlatform" TEXT,
    "requestedImei" TEXT,
    "reason" TEXT,
    "status" "DeviceReleaseStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByAdminId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "proofKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceReleaseRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientAssignment_clientId_createdAt_idx" ON "ClientAssignment"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "ClientLinkRequest_agentId_createdAt_idx" ON "ClientLinkRequest"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "Device_principalType_principalId_status_idx" ON "Device"("principalType", "principalId", "status");

-- CreateIndex
CREATE INDEX "Device_fingerprint_idx" ON "Device"("fingerprint");

-- CreateIndex
CREATE INDEX "DeviceReleaseRequest_status_createdAt_idx" ON "DeviceReleaseRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceReleaseRequest_principalType_principalId_idx" ON "DeviceReleaseRequest"("principalType", "principalId");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_assignedAdminId_fkey" FOREIGN KEY ("assignedAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientAssignment" ADD CONSTRAINT "ClientAssignment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientLinkRequest" ADD CONSTRAINT "ClientLinkRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientLinkRequest" ADD CONSTRAINT "ClientLinkRequest_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One ACTIVE device per agent or client.
CREATE UNIQUE INDEX "Device_one_active_per_principal" ON "Device" ("principalType", "principalId") WHERE "status" = 'ACTIVE';

-- Current owners start as whoever onboarded (or created) the client.
UPDATE "Client" c SET "assignedAgentId" = o."onboardedByAgentId"
FROM "ClientOnboarding" o WHERE o."clientId" = c."id" AND o."onboardedByAgentId" IS NOT NULL;

UPDATE "Client" c SET "assignedAdminId" = COALESCE(o."onboardedById", c."createdById")
FROM "ClientOnboarding" o WHERE o."clientId" = c."id" AND COALESCE(o."onboardedById", c."createdById") IS NOT NULL;

UPDATE "Client" SET "assignedAdminId" = "createdById" WHERE "assignedAdminId" IS NULL AND "createdById" IS NOT NULL;

-- Permissions.
INSERT INTO "Permission" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'clients:assign', 'Assign a client to an agent or admin, and move clients between agents'),
  (gen_random_uuid()::text, 'devices:read', 'See the devices agents and clients are signed in on, and release requests'),
  (gen_random_uuid()::text, 'devices:manage', 'Release a bound device, with a reason, and decide release requests')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "Role" r JOIN "Permission" p ON p."key" IN ('clients:assign', 'devices:read', 'devices:manage')
WHERE r."name" = 'SUPER_ADMIN'
ON CONFLICT DO NOTHING;
