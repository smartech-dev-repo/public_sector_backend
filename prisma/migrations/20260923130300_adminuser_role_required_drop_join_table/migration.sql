-- Backfill: populate AdminUser.roleId/departmentId from the existing
-- AdminUserRole many-to-many data before roleId is made NOT NULL below.
-- Deterministic but arbitrary tie-break: for an admin holding more than one
-- role, the lowest roleId is chosen (AdminUserRole has no timestamp column,
-- so "most recent" cannot be determined). This is a one-time, reviewable
-- step, not an ongoing policy.
UPDATE "AdminUser" au
SET "roleId" = sub."roleId", "departmentId" = r."departmentId"
FROM (
  SELECT DISTINCT ON ("adminUserId") "adminUserId", "roleId"
  FROM "AdminUserRole"
  ORDER BY "adminUserId", "roleId" ASC
) sub
JOIN "Role" r ON r.id = sub."roleId"
WHERE au.id = sub."adminUserId";

-- DropForeignKey
ALTER TABLE "AdminUser" DROP CONSTRAINT "AdminUser_roleId_fkey";

-- DropForeignKey
ALTER TABLE "AdminUserRole" DROP CONSTRAINT "AdminUserRole_adminUserId_fkey";

-- DropForeignKey
ALTER TABLE "AdminUserRole" DROP CONSTRAINT "AdminUserRole_roleId_fkey";

-- AlterTable
ALTER TABLE "AdminUser" ALTER COLUMN "roleId" SET NOT NULL;

-- DropTable
DROP TABLE "AdminUserRole";

-- AddForeignKey
ALTER TABLE "AdminUser" ADD CONSTRAINT "AdminUser_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
