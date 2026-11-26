-- Backfill: split any remaining AdminUser.fullName on its first space into
-- firstName/lastName before the columns are made NOT NULL below. This is a
-- one-time, reviewable heuristic (same spirit as the local backfill script
-- already run against this environment) so any other environment applying
-- this migration gets the same treatment automatically, rather than relying
-- solely on a separately-run script.
UPDATE "AdminUser"
SET "firstName" = split_part(trim("fullName"), ' ', 1),
    "lastName" = CASE
      WHEN position(' ' in trim("fullName")) = 0 THEN ''
      ELSE trim(substring(trim("fullName") from position(' ' in trim("fullName")) + 1))
    END
WHERE "firstName" IS NULL;

-- AlterTable
ALTER TABLE "AdminUser" ALTER COLUMN "firstName" SET NOT NULL,
ALTER COLUMN "lastName" SET NOT NULL;
