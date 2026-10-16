# Agent Recruitment Design

## 1. Purpose

Today, agent registration (`POST /agents/register`) is a single-shot, unauthenticated
multipart call collecting only `fullName`/`email`/`phone`/`address` plus a CV and
optional supporting documents, with no email verification, no identity
verification, and no way to resume if the submission is interrupted.

This replaces it entirely with a multi-step recruitment flow: verify the
applicant's email by code, let them check their NIN (shown back to them for
self-confirmation, not a hard gate), then submit a fuller application
(structured address, gender, cover letter, passport photo, optional identity
document) — all gated by a short-lived token issued once their email is
confirmed, so nothing can be submitted under an unverified email. Admin's
existing review (`admin-agent-review`) gains an email on rejection (it
currently sends none) and an analytics summary, mirroring the client
analytics feature built earlier this session.

## 2. Schema

```prisma
enum AgentApplicationStatus {
  EMAIL_PENDING
  EMAIL_VERIFIED
  SUBMITTED
}

model AgentApplication {
  id                  String                 @id @default(uuid())
  email               String                 @unique
  status              AgentApplicationStatus @default(EMAIL_PENDING)
  emailCodeHash       String?
  emailCodeExpiresAt  DateTime?
  emailVerifiedAt     DateTime?
  fullName            String?
  phone               String?
  gender              String?
  address             String?
  city                String?
  state               String?
  localGovernment     String?
  nin                 String?
  ninVerified         Boolean?
  ninVerifiedName     String?
  coverLetter         String?
  cvKey               String?
  passportPhotoKey    String?
  identityDocumentKey String?
  submittedAgentId    String?                @unique
  submittedAgent      Agent?                 @relation(fields: [submittedAgentId], references: [id])
  createdAt           DateTime               @default(now())
  updatedAt           DateTime               @updatedAt
}
```

`Agent` gains the same newly-collected fields, so the real reviewable record
carries everything forward once an application is submitted:

```prisma
model Agent {
  // ...existing fields...
  gender              String?
  city                String?
  state               String?
  localGovernment     String?
  nin                 String?
  ninVerified         Boolean?
  ninVerifiedName     String?
  coverLetter         String?
  passportPhotoKey    String?
  identityDocumentKey String?
}
```

`address` on both models stays today's free-text street line; `city`/`state`/
`localGovernment` are new separate columns, matching the existing split-address
pattern already used on `ClientOnboarding` (`city`, `stateOfResidence`,
`lgaOfResidence`, etc.).

## 3. Email verification

### `POST agent-recruitment/email/request-code`

Body `{ email }`. `@Throttle({ limit: 5, ttl: 900000 })` (same rate limit
already used on login/password-reset).

- If an `Agent` already exists with this email (any status — covers
  in-review, approved, or rejected applications), reject with `409
  Conflict` ("An agent application with this email already exists").
- Otherwise, upsert an `AgentApplication` row keyed by email (create if
  none, reuse if one exists — re-requesting at any point just regenerates
  the code without touching any fields already filled in).
- Generate a 6-digit code (`generateNumericCode`, same util as 2FA/password-reset),
  hash it (`hashToken`), store `emailCodeHash`/`emailCodeExpiresAt` (10 min
  TTL, matching the existing 2FA-email-code TTL), email the plaintext code.

### `POST agent-recruitment/email/confirm-code`

Body `{ email, code }`. `@Throttle({ limit: 5, ttl: 900000 })`.

- Looks up the `AgentApplication` by email; validates `emailCodeHash`/
  `emailCodeExpiresAt` against the submitted code, same comparison pattern
  as `AgentAuthService.confirmTwoFactor`'s EMAIL branch. `401` on
  mismatch/expiry/missing-draft.
- On success: sets `emailVerifiedAt`, `status: EMAIL_VERIFIED` (unless
  already `SUBMITTED`, in which case this call still succeeds and just
  issues a fresh token against the existing submitted draft — see §6),
  clears `emailCodeHash`/`emailCodeExpiresAt`.
- Issues and returns `{ applicationToken }` — a short-lived JWT (own secret
  `JWT_AGENT_APPLICATION_SECRET`, 45-minute TTL — enough for one sitting),
  mirroring `TokenService.signTwoFactorPendingToken`'s existing pattern but
  with its own dedicated secret and longer TTL appropriate for filling out
  a form rather than a few-second login handshake.

## 4. Application token guard

New `AgentApplicationTokenGuard`, used on `status`, `nin/verify`, and
`submit`. Reads `Authorization: Bearer <token>` (needed since `GET status`
has no body to carry a token in), verifies it via a new
`TokenService.verifyAgentApplicationToken(token)`, and attaches the resolved
`applicationId` onto the request for the controller to use. Throws
`UnauthorizedException` on any invalid/expired/missing token — there is no
JWT-payload "principal type" check here (this isn't an Admin/Agent/Client
session), just "does this token prove you verified this specific draft's
email."

## 5. NIN verification

### `POST agent-recruitment/nin/verify`

Token-gated. Body `{ nin }`.

```typescript
async verifyNin(applicationId: string, nin: string) {
  const result = await this.identityVerificationService.lookupNin(nin);
  const ninVerified = Boolean(result.firstName);
  const ninVerifiedName = ninVerified ? `${result.firstName} ${result.lastName}`.trim() : null;
  await this.prisma.agentApplication.update({
    where: { id: applicationId },
    data: { nin, ninVerified, ninVerifiedName },
  });
  return { ninVerified, ninVerifiedName };
}
```

Returns `{ ninVerified, ninVerifiedName }` so the applicant can visually
self-check the NIN-registered name matches them — a mismatch does **not**
block submission (name formatting can legitimately differ); it's informational
only, same spirit as `ClientOnboardingService`'s BVN/NIN check not blocking
onboarding on its own. Can be called again (e.g. to fix a typo) any number of
times while the token is valid — each call overwrites the prior result.

## 6. Status / resume

### `GET agent-recruitment/status`

Token-gated, no body.

- If the draft's `status` is `EMAIL_VERIFIED` (not yet submitted): returns
  the draft's own current field values (`fullName`, `phone`, `gender`,
  `address`/`city`/`state`/`localGovernment`, `nin`/`ninVerified`/
  `ninVerifiedName`, `coverLetter`, and booleans `hasCv`/`hasPassportPhoto`/
  `hasIdentityDocument` derived from whether the corresponding `*Key` field
  is set) — lets a resumed session pre-fill whatever was already captured.
  This is the "status checker" requirement: nothing is lost by coming back
  later, since `email/request-code` → `email/confirm-code` just re-issues a
  token against the same draft row, whose fields were never touched by the
  regenerate-code path.
- If the draft's `status` is `SUBMITTED`: fetches the linked `submittedAgent`
  and returns its **current review status** instead (`status`,
  `reviewedAt`, `rejectionReason` if rejected) — so checking status right
  after submitting (within the same 45-minute token window) still shows
  something meaningful, namely where the real application now stands.

## 7. Final submission

### `POST agent-recruitment/submit`

Token-gated, multipart: `fullName, phone, gender, address, city, state,
localGovernment, nin, coverLetter` (all required text fields) plus files
`cv` (required), `passportPhoto` (required), `identityDocument` (optional) —
extends the existing `FileFieldsInterceptor` config from today's
`agent-enrollment.controller.ts` (today's only `cv` + `supportingDocuments`
array becomes `cv` + `passportPhoto` + `identityDocument`, each a distinct
single-file named field; `supportingDocuments` is dropped, since the spec's
field list doesn't call for it).

- `409` if the draft is already `SUBMITTED` (no re-submission; see §10).
- If `nin` wasn't already verified via §5 for this exact NIN value (or was
  never called), `submit` calls `lookupNin` itself first, so `ninVerified`/
  `ninVerifiedName` are always populated on the real `Agent` row by the
  time admin reviews it, regardless of whether the applicant used the
  dedicated check endpoint.
- Uploads `cv`/`passportPhoto`/`identityDocument` via the existing
  `FileStorageProvider`, keyed `agent-documents/<agentId>/<field>-<uuid><ext>`
  (same key-naming convention as today's `agent-enrollment.service.ts`).
- Creates the real `Agent` row (`status: PENDING_REVIEW`, all the collected
  fields, `passwordHash: null` until approved — unchanged from today's
  post-approval credential-issuance flow), updates the draft to
  `status: SUBMITTED` + `submittedAgentId`.
- Returns a plain, explicit response shape (`id, email, fullName, status,
  createdAt`) — **not** the raw Prisma row — fixing today's
  `agent-enrollment.service.ts` behavior of returning the full row
  including null password/2FA columns.

## 8. Admin: reject email

`AdminAgentReviewService.reject()` gains an `EmailService.send()` call
(the method currently sends nothing at all):

```typescript
await this.emailService.send({
  to: agent.email,
  subject: 'Your agent application was not approved',
  html: `<p>Your application was not approved.</p><p>Reason: ${reason}</p>`,
  text: `Your application was not approved.\nReason: ${reason}`,
});
```

Inserted into the existing `reject()` method, after the status update,
before returning — `EmailModule` is already imported in
`AdminAgentReviewModule` (used today by `issueCredentials`), so no module
wiring change is needed.

## 9. Admin: analytics

New `AdminAgentAnalyticsService`, mirroring `AdminClientAnalyticsService`'s
exact shape and registered inside the existing `AdminAgentReviewModule`
(not a new module — same as how the client analytics service lives inside
`admin-client-review`, not its own module):

```typescript
interface AgentAnalyticsSummary {
  totalApplications: number;
  byStatus: { PENDING_REVIEW: number; APPROVED: number; REJECTED: number };
  reviewerLeaderboard: Array<{ adminId: string; adminName: string; approvedCount: number; rejectedCount: number }>;
  activity: { averageReviewTimeHours: number | null; totalApproved: number; totalRejected: number };
}
```

`averageReviewTimeHours` is computed from `reviewedAt - createdAt` across
every reviewed (`APPROVED`/`REJECTED`) agent in the filtered range, `null`
when there are none yet (avoids a divide-by-zero). New route
`GET admin/agents/analytics`, registered **before** `GET admin/agents/:id`
in the controller (same route-ordering requirement already handled for
`GET admin/clients/analytics` vs `GET admin/clients/:id` — a literal path
segment must be registered before a param route or NestJS matches the param
route first). New permission `agents:analytics:read`, seeded alongside the
existing four agent-related permission keys.

## 10. Out of scope

- Editing or withdrawing a submitted application.
- Re-opening a `REJECTED` application for resubmission (a rejected
  applicant would need to start a fresh application under the same email —
  today's duplicate-email check in §3 would need the "any status" condition
  relaxed if this is ever wanted; not built now).
- File-content moderation beyond today's existing mimetype/size checks.
- Agent-side visibility into application status once they're an approved,
  logged-in `Agent` — already covered by the existing `GET agent/me`.

## 11. Testing

- Unit: `AgentRecruitmentService` — `requestCode` (409 on existing Agent
  email, regenerates code on repeat calls without touching filled fields),
  `confirmCode` (hash/expiry validation, token issuance, the
  already-submitted-still-works-for-status case), `verifyNin` (stores and
  returns verified/name), `getStatus` (pre-submission field echo vs.
  post-submission Agent-status passthrough), `submit` (creates the Agent
  row, uploads all three files, auto-verifies NIN if not already done,
  rejects a second submit attempt).
- Unit: `AgentApplicationTokenGuard` (valid/invalid/expired/missing token).
- Unit: `AdminAgentReviewService.reject` (email sent with the reason).
- Unit: `AdminAgentAnalyticsService` (status breakdown, leaderboard,
  average-review-time with and without any reviewed rows).
- e2e: full happy path (request code → confirm → NIN verify → submit →
  appears in `GET admin/agents`); the resume path (request code → confirm →
  request code again → confirm → `GET status` shows nothing lost → submit);
  the 409 existing-email case; `GET admin/agents/analytics`;
  `POST admin/agents/:id/reject` now sending an email.

## 12. Postman

Per this repo's `CLAUDE.md`: delete the old `Agent → Enrollment` request(s)
for `POST /agents/register`, add a new `Agent → Recruitment` folder with all
five endpoints (success + meaningful failure scenarios each), and add
`GET /admin/agents/analytics` + the updated `POST /admin/agents/:id/reject`
example (now showing the email side-effect isn't itself part of the HTTP
response, but worth noting in the request's description) under the existing
Admin agents folder.
