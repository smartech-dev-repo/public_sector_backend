-- CreateTable
CREATE TABLE "AlertRecipient" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AlertRecipient_email_key" ON "AlertRecipient"("email");

-- New permission for managing recipients, granted to SUPER_ADMIN straight away
-- so it works after deploy without a manual seed.
INSERT INTO "Permission" ("id", "key", "description")
VALUES (gen_random_uuid()::text, 'alerts:manage', 'Choose who receives security alert emails')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r, "Permission" p
WHERE r."name" = 'SUPER_ADMIN' AND p."key" = 'alerts:manage'
ON CONFLICT DO NOTHING;
