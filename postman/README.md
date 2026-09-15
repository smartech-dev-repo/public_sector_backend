# Postman collection

`public-sector-backend.postman_collection.json` covers every endpoint in the
codebase, with a success scenario and the meaningful failure scenarios
(validation, auth, permission, not-found) for each one. Filterable
list endpoints (`/admin/invites`, `/admin/audit-logs`,
`/admin/documents/batches`) include requests demonstrating their query
params.

## Setup

1. Import `public-sector-backend.postman_collection.json` into Postman.
2. Import `local.postman_environment.json` and select it as the active
   environment.
3. In Postman (not by editing the JSON file), set `admin_password` and
   `agent_password` to your real local values from `.env`
   (`BOOTSTRAP_ADMIN_PASSWORD`, and whatever password you used when
   inserting a test Agent row — see the description on
   "Auth - Agent > POST /auth/agent/login - Success"). Edits you make
   inside the Postman app are stored in Postman's own local data, not
   written back to this repo's JSON file, so there's no risk of committing
   a real password by doing this.
4. Make sure the app is running (`npm run start:dev`) against a
   migrated + seeded database.

## Running it

Requests are grouped so you can run a whole folder (or the whole
collection via Collection Runner) top to bottom and have most of it chain
automatically — success requests capture tokens/ids into collection
variables (`admin_access_token`, `invite_id`, `ippis_batch_id`, etc.) via
test scripts, and later requests reference those variables.

A few things can't be automated end-to-end and need a manual step —
each has a `description` on the request explaining why:

- **Client OTP verify** and **admin invite accept**: the OTP code and
  invite token are only ever delivered via the mock console
  `OtpProvider`/`EmailProvider`, which just logs to the running server's
  stdout (no real SMS/email vendor is wired in yet). Copy the value from
  the server log into `client_otp_code` / `invite_token` before running
  those requests.
- **Agent login**: Agent self-registration isn't built yet (deferred —
  see `docs/specs/2026-09-09-public-sector-backend-spec.md`). You need an
  `Agent` row with `status = APPROVED` and a real bcrypt `passwordHash`
  already in the database before this succeeds.
- **Invite role id**: there's no `GET /admin/roles` endpoint yet. Look up
  the `SUPER_ADMIN` role's id directly in the database and set
  `super_admin_role_id`.
- **Document uploads**: attach any `.xlsx` file — no real parsing exists
  yet (every document type goes through a no-op parser that reports 0
  rows regardless of content). **Never attach the real sample files under
  `docs/added/`** to a request in a shared Postman workspace — those
  contain real BVNs, bank accounts, and names, and are gitignored in this
  repo for that exact reason.

## Maintenance — read this before changing any endpoint

**This collection must be updated in the same change as any code change
that affects it.** That means, whenever you (or an AI assistant working in
this repo):

- add, remove, or rename an endpoint,
- change a DTO's fields or validation rules,
- change a permission key an endpoint requires,
- add or change a query filter,
- change a response shape that a test script or chained request depends on,

...the corresponding request(s) in `public-sector-backend.postman_collection.json`
get added/updated/removed in the same commit — not as separate follow-up
work, not "later." This is a standing project rule (see the repo's
`CLAUDE.md`), not a one-time request.

When adding a new endpoint, follow the existing pattern: one success
request with a test script that captures anything later requests need,
plus the meaningful failure requests (at minimum: validation error if it
takes a body, auth/permission error if it's guarded). Put it in the
folder matching its controller; create a new folder if it's a new
controller/module.
