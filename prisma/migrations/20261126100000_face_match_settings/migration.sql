-- Face comparison settings: one row, edited from the back office. Off until switched on.
CREATE TABLE "FaceMatchSettings" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "minimumScore" INTEGER NOT NULL DEFAULT 40,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FaceMatchSettings_pkey" PRIMARY KEY ("id")
);

-- The minimum score in force when a client's photos were compared (null: comparison was off).
ALTER TABLE "ClientOnboarding" ADD COLUMN "faceMatchMinimumScore" INTEGER;

-- New permission for the settings, granted to SUPER_ADMIN straight away
-- so it works after deploy without a manual seed.
INSERT INTO "Permission" ("id", "key", "description")
VALUES (gen_random_uuid()::text, 'face-match:manage', 'Switch face comparison on or off and set the minimum score for client onboarding')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r, "Permission" p
WHERE r."name" = 'SUPER_ADMIN' AND p."key" = 'face-match:manage'
ON CONFLICT DO NOTHING;
