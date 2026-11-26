-- CreateTable
CREATE TABLE "Sector" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sector_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Sector_code_key" ON "Sector"("code");

-- The sector was stored as CUSTOM; its proper code is CUSTOMS. Done across every
-- table with an agency column, so existing records stay matched to the sector.
DO $$
DECLARE target record;
BEGIN
  FOR target IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND column_name = 'agency'
  LOOP
    EXECUTE format('UPDATE %I SET agency = ''CUSTOMS'' WHERE agency = ''CUSTOM''', target.table_name);
  END LOOP;
END $$;

UPDATE "LoanProduct" SET "sectors" = array_replace("sectors", 'CUSTOM', 'CUSTOMS') WHERE 'CUSTOM' = ANY("sectors");

INSERT INTO "Sector" ("id", "code", "name") VALUES
  (gen_random_uuid()::text, 'NPF', 'Nigerian Police Force'),
  (gen_random_uuid()::text, 'NSCDC', 'Nigeria Security and Civil Defence Corps'),
  (gen_random_uuid()::text, 'IMMIGRATION', 'Nigeria Immigration Service'),
  (gen_random_uuid()::text, 'CORRECTIONAL', 'Nigerian Correctional Service'),
  (gen_random_uuid()::text, 'CUSTOMS', 'Nigeria Customs Service'),
  (gen_random_uuid()::text, 'LASG', 'Lagos State Civil Service');

-- Keep any sector already in use, so nothing disappears from pickers or filters.
INSERT INTO "Sector" ("id", "code")
SELECT gen_random_uuid()::text, code FROM (
  SELECT DISTINCT agency AS code FROM "IppisRecord"
  UNION
  SELECT DISTINCT unnest("sectors") FROM "LoanProduct"
) existing
WHERE code IS NOT NULL AND code <> ''
ON CONFLICT ("code") DO NOTHING;

-- Who may set sectors up, granted to SUPER_ADMIN straight away.
INSERT INTO "Permission" ("id", "key", "description")
VALUES (gen_random_uuid()::text, 'sectors:manage', 'Add, rename and remove sectors')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r, "Permission" p
WHERE r."name" = 'SUPER_ADMIN' AND p."key" = 'sectors:manage'
ON CONFLICT DO NOTHING;
