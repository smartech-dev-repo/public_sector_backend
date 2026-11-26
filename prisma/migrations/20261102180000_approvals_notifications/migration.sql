-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'FAILED');

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requiredPermission" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "pendingKey" TEXT,
    "requestedById" TEXT NOT NULL,
    "assignedToId" TEXT,
    "decidedById" TEXT,
    "decisionNote" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "targetPermissions" TEXT[],
    "recipientAdminId" TEXT,
    "excludeAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationRead" (
    "notificationId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationRead_pkey" PRIMARY KEY ("notificationId","adminId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRequest_pendingKey_key" ON "ApprovalRequest"("pendingKey");
CREATE INDEX "ApprovalRequest_status_requiredPermission_idx" ON "ApprovalRequest"("status", "requiredPermission");
CREATE INDEX "ApprovalRequest_requestedById_idx" ON "ApprovalRequest"("requestedById");
CREATE INDEX "ApprovalRequest_assignedToId_idx" ON "ApprovalRequest"("assignedToId");
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");
CREATE INDEX "Notification_recipientAdminId_idx" ON "Notification"("recipientAdminId");

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NotificationRead" ADD CONSTRAINT "NotificationRead_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Who may decide each kind of request, granted to SUPER_ADMIN straight away so
-- approvals work after deploy without a manual seed.
INSERT INTO "Permission" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'approvals:loans', 'Decide loan approvals, disbursements and code confirmations sent for approval'),
  (gen_random_uuid()::text, 'approvals:agents', 'Decide agent approvals and credential resends sent for approval'),
  (gen_random_uuid()::text, 'approvals:wallets', 'Decide wallet credits and debits sent for approval')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r, "Permission" p
WHERE r."name" = 'SUPER_ADMIN' AND p."key" IN ('approvals:loans', 'approvals:agents', 'approvals:wallets')
ON CONFLICT DO NOTHING;
