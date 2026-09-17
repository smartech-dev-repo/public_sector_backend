# Postman collection

`public-sector-backend.postman_collection.json` covers every endpoint in the
codebase, with a success scenario and the meaningful failure scenarios
(validation, auth, permission, not-found) for each one. Filterable
list endpoints (`/admin/invites`, `/admin/audit-logs`,
`/admin/documents/batches`) include requests demonstrating their query
params.

## Folder structure

Three top-level groups, each self-contained (its own Auth where applicable,
and its own Session sub-folder using that group's own tokens), plus a
standalone Health check:

- **Health** — the one endpoint that isn't tied to any principal type.
- **Admin** — Auth, Session (admin tokens), Reference (`/admin/me`),
  **Permissions** (full CRUD, blocked-delete-if-in-use), **Roles** (full
  CRUD, SUPER_ADMIN protections, role↔permission assignment), **Admins**
  (list admins, assign/remove roles, SUPER_ADMIN-lockout protection),
  Invites, Audit Logs, Force-Revoke Sessions (an admin action that
  *targets* an Agent's or a Client's sessions — it lives here because an
  Admin performs it, and it doesn't affect or get affected by the
  Agent/Client groups' own session management of themselves), and
  **Documents** (the ippis-broadsheet/disbursed-loans/repayment-schedule
  upload + batch + file-download endpoints — admin-authenticated, so it
  lives here rather than under its own group; there's no separate "IPPIS"
  principal type in the JWT system), and **Client Review** (list/inspect
  clients stuck at `Client.status = MANUAL_REVIEW` and approve or retry
  them, gated by `clients:review`).
- **Agent** — Auth and this agent's own Session (agent tokens).
- **Client** — Auth (phone + OTP), this client's own Session (client
  tokens), and **Onboarding** (IPPIS number linking, BVN/NIN identity
  submission, and selfie face-match, walking the client from
  `PHONE_VERIFIED` to `Client.status = VERIFIED`/`MANUAL_REVIEW`). In this
  codebase an IPPIS civil servant is onboarded and logs in *as* a Client —
  see `docs/specs/2026-09-09-public-sector-backend-spec.md`.

## Setup

1. Import `public-sector-backend.postman_collection.json` into Postman.
2. Import `local.postman_environment.json` and select it as the active
   environment.
3. In Postman (not by editing the JSON file), set `admin_password` and
   `agent_password` to your real local values from `.env`
   (`BOOTSTRAP_ADMIN_PASSWORD`, and whatever password you used when
   inserting a test Agent row — see the description on
   "Agent > Auth > POST /auth/agent/login - Success"). Edits you make
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
- **Document uploads**: all three document types (IPPIS Broadsheet,
  Disbursed Loans, Repayment Schedule) are fully parsed — see each
  upload request's `description` for the real column headers it expects.
  **Never attach the real sample files under `docs/added/`** to a request
  in a shared Postman workspace — those contain real BVNs, bank accounts,
  and names, and are gitignored in this repo for that exact reason.

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
takes a body, auth/permission error if it's guarded). Place it under
whichever of the three groups (Admin/Agent/Client) matches who
*authenticates* to call it — not who it's about — in the sub-folder
matching its controller, creating a new sub-folder for a new
controller/module. A brand new fourth top-level group is only warranted
for a genuinely new principal type (the JWT system currently has exactly
three: admin, agent, client).
