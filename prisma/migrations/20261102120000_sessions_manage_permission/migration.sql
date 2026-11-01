-- New permission for the User Sessions page, granted to SUPER_ADMIN straight away
-- so it works after deploy without a manual seed.
INSERT INTO "Permission" ("id", "key", "description")
VALUES (gen_random_uuid()::text, 'sessions:manage', 'View every user''s sessions and sign users out')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r, "Permission" p
WHERE r."name" = 'SUPER_ADMIN' AND p."key" = 'sessions:manage'
ON CONFLICT DO NOTHING;
