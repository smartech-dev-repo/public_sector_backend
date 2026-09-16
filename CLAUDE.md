# Project instructions

## Postman collection — always keep it in sync

`postman/public-sector-backend.postman_collection.json` must be updated in
the **same change** as any code change that affects the API surface — not
as separate follow-up work. This applies to every session, not just the
one that first created the collection.

Update it whenever you:
- add, remove, or rename an endpoint,
- change a DTO's fields or validation rules,
- change a permission key an endpoint requires,
- add or change a query filter,
- change a response shape that an existing test script or chained request
  in the collection depends on (e.g. a field a later request's test script
  reads to set a collection variable).

The collection is organized into four top-level groups by *who
authenticates* to call the endpoint — Admin, Agent, IPPIS (document
ingestion, which is admin-authenticated), Client — plus a standalone
Health folder, each with an Auth (where applicable) and Session
sub-folder. See `postman/README.md`'s "Folder structure" section for the
full rationale (e.g. why Admin's force-revoke-sessions endpoints, which
*target* an Agent/Client, still live under Admin).

For a **new** endpoint: add a folder-appropriate request with a success
scenario (with a test script capturing anything later requests need into a
collection variable, following the existing naming pattern) plus the
meaningful failure scenarios — at minimum validation error if it takes a
body, and auth/permission error if it's guarded by `JwtAuthGuard`/
`PermissionsGuard`. Place it under the group matching who authenticates to
call it, in the sub-folder matching its controller; create a new
sub-folder for a new controller/module within that group. Only add a new
top-level group if a genuinely new principal type is introduced.

For a **changed** endpoint: find its existing request(s) by searching the
collection JSON for the route path, and update the body/params/test
script to match — don't leave a stale request that no longer reflects
reality.

See `postman/README.md` for the full usage and maintenance notes.

## Sensitive local files

`docs/added/` may contain real personal data (BVNs, bank accounts, phone
numbers, names) used as reference material during design work. It's
gitignored — never commit it, never attach files from it to a shared
Postman workspace or any other shared tool, and never reference its
contents in a way that would leak specifics into a committed file.
