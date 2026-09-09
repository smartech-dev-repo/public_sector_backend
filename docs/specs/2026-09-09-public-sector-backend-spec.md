# Public Sector Backend — System Spec

**Date:** 2026-09-09
**Status:** Draft v1
**Tech stack:** Node.js, NestJS (TypeScript), PostgreSQL, Prisma ORM, Passport/JWT

## 1. Purpose

A backend platform serving three user populations — **Admin** (back office),
**Agent** (field/enrollment agents), and **Client** (end beneficiaries,
including IPPIS-verified public servants) — each with a different
authentication mechanism and onboarding path.

## 2. User Types & Authentication

| Role | Login credential | Onboarding path |
|---|---|---|
| Admin | Email + password | Provisioned internally by another Admin holding `admins:create`; no public registration |
| Agent | Email + password | Public open registration form → back-office review/approval before login is enabled |
| Client (incl. IPPIS) | Phone number + OTP | Self-service via phone OTP; IPPIS clients additionally go through an automated identity-verification pipeline |

## 3. Admin & RBAC

- Admin accounts are never self-registered; created by a super-admin or an
  admin holding the right permission.
- Fine-grained RBAC: a `Role` has many `Permission`s; an `AdminUser` has many
  `Role`s (many-to-many both ways).
- Permissions are string keys namespaced `resource:action`, e.g.
  `agents:approve`, `agents:read`, `ippis:upload`, `roles:manage`,
  `admins:create`.
- A bootstrap super-admin (with an all-permissions role) is created by a seed
  script from environment variables — never a hardcoded credential.
- Every admin-guarded route declares its required permission(s) explicitly.
  There is no implicit "isAdmin ⇒ full access" — even the super-admin's
  access comes from having every permission assigned, not from a role name
  special-cased in code.

## 4. Agent Onboarding

- A public, unauthenticated registration endpoint collects: full name,
  email, phone, address, CV (file upload), and other supporting documents.
- On submission, an `Agent` record is created with
  `status = PENDING_REVIEW`; uploaded files go through a `FileStorageProvider`
  abstraction (local disk in dev, S3-compatible in prod) and are referenced
  by key on the record.
- Back-office Admins holding `agents:read` / `agents:review` can list, view,
  approve, or reject submissions, with a required reason on rejection.
- Only once `APPROVED` can the Agent set a password and log in with
  email + password.

## 5. Client / IPPIS Onboarding (automated pipeline)

1. Client submits a phone number → OTP sent via a pluggable `OtpProvider` →
   client verifies the OTP → a base `Client` record is created
   (`status = PHONE_VERIFIED`).
2. Client submits their IPPIS number, BVN, and NIN.
3. System looks up the IPPIS number against admin-uploaded IPPIS master data
   (`IppisRecord`, populated via bulk import) and confirms no other Client
   is already linked to that IPPIS number.
4. System compares the submitted BVN/NIN and other identity fields against
   the matched `IppisRecord`.
5. System calls a pluggable `IdentityVerificationProvider` to validate the
   BVN/NIN against the national registries.
6. System captures a selfie and calls a pluggable `FaceVerificationProvider`
   to match it against the photo on file for that BVN/NIN/IPPIS record.
7. If every step passes, the Client is auto-promoted to
   `status = VERIFIED`. If any step fails or is inconclusive, the Client
   moves to `status = MANUAL_REVIEW` with the failure reason(s) attached,
   visible to Admins holding `clients:review`.
8. A separate authenticated endpoint (`ippis:upload` permission) lets Admins
   bulk-import/refresh IPPIS master data.

## 6. Cross-cutting concerns

- **Pluggable external integrations** — `OtpProvider`,
  `IdentityVerificationProvider` (BVN/NIN), `FaceVerificationProvider`, and
  `FileStorageProvider` are defined as interfaces with a mock/local
  implementation for development. Real vendors are swapped in later without
  touching business logic.
- **Multi-provider + failover** — OTP delivery and BVN/NIN verification
  each accept an *ordered list* of providers, not a single one. A
  dispatcher tries the first provider; on failure (timeout, vendor error,
  vendor outage) it falls through to the next configured provider, and
  only fails the operation once every provider in the list has failed. New
  vendors are added by implementing the interface and appending them to
  the configured list — no changes to calling code. This mechanism is
  built and unit-tested in Phase 1 against mock providers (see
  `OtpService`/`OTP_PROVIDERS` in the Phase 1 plan) so Phase 3 only has to
  add concrete `IdentityVerificationProvider` implementations, not
  redesign the pattern. `FaceVerificationProvider` stays single-provider
  for now since only one external vendor was specified for it; extend it
  to the same list+failover shape later if a second vendor is added.
- **File storage — S3-compatible abstraction** — `FileStorageProvider`
  wraps an S3-compatible object storage API (`putObject`, `getSignedUrl`,
  `deleteObject`). The initial implementation targets **Google Cloud
  Storage** using GCS's S3-interoperability endpoint, so the same
  AWS-S3-SDK-based client class can point at GCS today and at real **AWS
  S3** later by changing only the endpoint/credentials/bucket config — no
  code change. A non-S3-compatible external provider can still be
  supported by adding a second class behind the same interface. This is
  built in **Phase 2**, where the Agent CV/document upload first needs
  storage; Phase 1 has no file upload and does not need this yet.
- **Auditability** — state-changing actions (Agent review, Client review,
  RBAC changes) should be attributable and timestamped. Entities carry
  `reviewedBy` / `reviewedAt` from the start even though a full audit-log
  subsystem is a later phase.
- **Multi-tenancy** — not required for v1 (single deployment).

## 7. Roadmap

Each phase below is an independently shippable plan under
`docs/superpowers/plans/`:

- **Phase 1 — Foundation** *(planned in detail; see
  `2026-09-09-phase-1-foundation.md`)*: project scaffold, Postgres + Prisma,
  core schema (AdminUser/Role/Permission, Agent & Client skeletons, OTP
  infra), all three login flows, RBAC guard. No onboarding business logic
  yet.
- **Phase 2 — Agent Enrollment**: public registration endpoint with file
  upload, back-office review/approve/reject workflow, Agent activation.
- **Phase 3 — Client/IPPIS Verification Pipeline**: IPPIS bulk upload +
  lookup, BVN/NIN comparison, identity- and face-verification provider
  integration, manual-review queue.
- **Phase 4 — Admin & RBAC Management + Audit Log**: CRUD for
  roles/permissions/admins, full audit trail.
- **Phase 5 — Hardening**: rate limiting, observability, real vendor
  integrations replacing mocks, load testing.

## 8. Open questions — resolved

- **SMS/OTP and BVN/NIN vendors** — may be multiple per capability;
  built as an ordered provider list with automatic failover (see section
  6). Concrete vendor names still TBD — mock providers are fine to start
  and ship in Phase 1/3; real vendors slot in later without redesign.
- **Facial verification** — one external provider for now, pluggable
  interface, mock implementation to start.
- **File storage** — S3-compatible abstraction; Google Cloud Storage
  (via its S3-interoperability endpoint) first, AWS S3 provisioned as a
  drop-in second target, with room for a non-S3 external provider later
  (see section 6). Built in Phase 2.

## 9. Remaining open questions

- Retention/compliance requirements for BVN/NIN data at rest (likely needs
  encryption-at-rest and restricted-access columns — flag for Phase 3
  design).
