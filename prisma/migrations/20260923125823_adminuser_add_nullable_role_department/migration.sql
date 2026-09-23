-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "roleId" TEXT;

-- AddForeignKey
ALTER TABLE "AdminUser" ADD CONSTRAINT "AdminUser_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminUser" ADD CONSTRAINT "AdminUser_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
