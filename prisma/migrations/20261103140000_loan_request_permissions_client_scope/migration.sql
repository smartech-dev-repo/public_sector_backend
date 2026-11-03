-- 1. Split "loan-requests:review" into one permission per action.
INSERT INTO "Permission" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'loan-requests:read', 'View the loan request list and details'),
  (gen_random_uuid()::text, 'loan-requests:manage', 'Send a confirmed loan request for approval'),
  (gen_random_uuid()::text, 'loan-requests:confirm-code', 'Enter the client''s code to confirm a pending loan request'),
  (gen_random_uuid()::text, 'loan-requests:reject', 'Reject a confirmed loan request'),
  (gen_random_uuid()::text, 'loan-requests:disburse', 'Send an approved loan request for disbursement'),
  -- 2. Record scope: without this an admin sees only clients they onboarded or created.
  (gen_random_uuid()::text, 'clients:all-records', 'See every client''s records, not only clients this admin onboarded')
ON CONFLICT ("key") DO NOTHING;

-- Everyone who could review loans keeps every loan action, and SUPER_ADMIN gets them all.
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT DISTINCT r."id", p."id"
FROM "Role" r
JOIN "Permission" p ON p."key" IN ('loan-requests:read', 'loan-requests:manage', 'loan-requests:confirm-code', 'loan-requests:reject', 'loan-requests:disburse')
WHERE r."name" = 'SUPER_ADMIN'
   OR EXISTS (
     SELECT 1 FROM "RolePermission" rp JOIN "Permission" old ON old."id" = rp."permissionId"
     WHERE rp."roleId" = r."id" AND old."key" = 'loan-requests:review'
   )
ON CONFLICT DO NOTHING;

-- Every existing role keeps seeing all clients, as today. Remove it from a role to limit it.
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "Role" r, "Permission" p WHERE p."key" = 'clients:all-records'
ON CONFLICT DO NOTHING;

-- Notifications already sent to loan reviewers now go to whoever can act on a confirmed loan.
UPDATE "Notification"
SET "targetPermissions" = array_replace("targetPermissions", 'loan-requests:review', 'loan-requests:manage')
WHERE 'loan-requests:review' = ANY ("targetPermissions");

-- The old permission goes; its role grants are removed with it.
DELETE FROM "Permission" WHERE "key" = 'loan-requests:review';
