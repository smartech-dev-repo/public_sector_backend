# Agent Client Onboarding + Admin Analytics Design

## 1. Purpose

Today, a `Client` can be onboarded two ways: self-service (phone/OTP, client-driven)
or admin-initiated (an admin runs the IPPIS lookup and optionally the whole
flow on the client's behalf). Both are already distinguishable in the schema
(`ClientOnboarding.onboardedById` null vs set). There is no third path: an
Agent cannot onboard a client at all today — no endpoint, no schema link
between `Agent` and `Client`/`ClientOnboarding`.

This adds that third path (agent-initiated onboarding, gated by a new
per-agent capability flag an admin grants), extends the existing
self/admin-onboarding-source distinction to a three-way self/agent/admin
split, and builds an admin-facing analytics endpoint plus an agent-facing
"clients I onboarded" list on top of it.

## 2. Schema

```prisma
model Agent {
  // ...existing fields...
  canOnboardClients Boolean @default(false)
}

model ClientOnboarding {
  // ...existing fields...
  onboardedByAgentId String?
  onboardedByAgent   Agent?  @relation(fields: [onboardedByAgentId], references: [id])
}
```

`onboardedByAgentId` is new, nullable, parallel to the existing
`onboardedById`/`onboardedByAdmin` (admin) pair. **Onboarding source is not
stored as its own column** — it's derived at read time from which of the two
FKs (if either) is set:

```typescript
export type OnboardingSource = 'SELF' | 'AGENT' | 'ADMIN';

export function deriveOnboardingSource(onboarding: {
  onboardedById: string | null;
  onboardedByAgentId: string | null;
} | null): OnboardingSource | null {
  if (!onboarding) return null; // no ClientOnboarding row exists yet at all
  if (onboarding.onboardedByAgentId) return 'AGENT';
  if (onboarding.onboardedById) return 'ADMIN';
  return 'SELF';
}
```

Storing a separate enum column would risk drifting from the two FKs over
time; deriving it keeps a single source of truth. No backfill needed —
existing rows simply have `onboardedByAgentId` null, which correctly resolves
to their existing SELF/ADMIN classification unchanged.

## 3. Agent onboarding flow

New controller, `@Controller('agent/clients')`, mirroring the existing
`AdminClientOnboardingController` route-for-route, but under `agent/` and
reusing the same underlying `ClientOnboardingService` methods
(`submitIdentityVerified`, `uploadDocument`, `submitFaceMatchFromPassportPhoto`)
for every step except starting:

- `POST agent/clients/onboarding/ippis-lookup`
- `POST agent/clients/:clientId/onboarding/identity`
- `POST agent/clients/:clientId/onboarding/documents/:type`
- `POST agent/clients/:clientId/onboarding/face-match`
- `GET agent/clients/:clientId/onboarding/status`

Guarded by `JwtAuthGuard, AgentOnlyGuard, AgentCanOnboardClientsGuard` (new —
see §6).

### `agentStartOnboarding(ippisNumber, agentId)`

Parallel to `adminStartOnboarding`, with a restriction `adminStartOnboarding`
does not have:

```typescript
async agentStartOnboarding(ippisNumber: string, agentId: string): Promise<ClientOnboarding> {
  const ippisRecord = await this.prisma.ippisRecord.findFirst({ where: { staffId: ippisNumber } });
  if (!ippisRecord) {
    throw new NotFoundException('No IPPIS record found for that staff ID');
  }

  const existing = await this.prisma.clientOnboarding.findUnique({ where: { ippisRecordId: ippisRecord.id } });
  if (existing) {
    if (existing.onboardedByAgentId === agentId) {
      return existing; // resuming this same agent's own prior attempt
    }
    throw new ConflictException('This client has already been onboarded');
  }

  if (!ippisRecord.phone) {
    throw new UnprocessableEntityException('IPPIS record has no phone number on file');
  }

  const client = await this.prisma.client.upsert({
    where: { phone: ippisRecord.phone },
    update: {},
    create: { phone: ippisRecord.phone },
  });

  return this.createOnboardingRecord(client.id, ippisRecord, undefined, agentId);
}
```

(`createOnboardingRecord`'s existing signature gains a 4th optional
`onboardedByAgentId` parameter, parallel to its existing 3rd optional
`onboardedById`; exactly one of the two is ever passed by any caller.)

**Restriction, exactly:** if a `ClientOnboarding` already exists for that IPPIS
number and it was *not* started by this same agent — whether it's
self-onboarded, admin-onboarded, or started by a *different* agent — the
request is rejected with `409 Conflict`. Only a fresh IPPIS number, or one
this exact agent already started, proceeds. This is deliberately stricter
than admin's own idempotent/resumable behavior (any admin can pick up any
client's onboarding) — admin visibility/control is intentionally broader
than agent scope.

## 4. Admin toggle for agent onboarding access

`PATCH admin/agents/:id/onboarding-access`, body `{ canOnboardClients: boolean }`,
permission `agents:onboarding-access:manage` (new, kept separate from
`agents:review` — approving an agent's enrollment and granting them
client-onboarding access are different decisions an admin might make at
different times, matching this repo's one-permission-per-capability
convention).

Validates the target agent's enrollment status is `APPROVED` before allowing
`canOnboardClients: true` — `422` otherwise (`canOnboardClients: false` is
always allowed, to let an admin revoke access regardless of status). `404` if
the agent doesn't exist.

## 5. Admin client list — source field + filter

`GET /admin/clients` response: each row gains `onboardingSource: 'SELF' |
'AGENT' | 'ADMIN' | null` (computed from the already-included `onboarding`
relation via `deriveOnboardingSource` — no new query). `null` only when the
`Client` has no `ClientOnboarding` row at all yet (phone-verified, not yet
IPPIS-linked).

`ListClientsQueryDto` gains an optional `onboardingSource?: 'SELF' | 'AGENT' |
'ADMIN'` filter, translated server-side to the matching Prisma `where` clause
(`onboarding: { onboardedByAgentId: { not: null } }` for `AGENT`, `onboarding:
{ onboardedById: { not: null } }` for `ADMIN`, `onboarding: { onboardedById:
null, onboardedByAgentId: null } }` for `SELF` — note `SELF` still requires an
onboarding row to exist, distinct from `null`/no-onboarding-yet).

`GET /admin/clients/:id` detail response also gains `onboardingSource`, plus —
since this is a single-record fetch, not per-row list cost — the actual
agent/admin's name when applicable (list view stays label-only per your
confirmed choice; detail view can afford richer context).

## 6. Guards

New `AgentCanOnboardClientsGuard`: looks up the acting agent (from the JWT
payload's subject id) and checks `canOnboardClients === true`, throwing
`ForbiddenException('Not authorized to onboard clients')` otherwise. Applied
alongside `AgentOnlyGuard` on the 5 onboarding-flow routes in §3 only — **not**
on `GET agent/clients` (§7), which stays accessible even if access is later
revoked, since an agent should still be able to see clients they previously
onboarded.

## 7. Agent-side "clients I onboarded" list

`GET agent/clients`, guarded by `JwtAuthGuard, AgentOnlyGuard` only (no
`AgentCanOnboardClientsGuard` — see §6). Automatically scoped to
`onboardedByAgentId = <acting agent's id>` from the JWT; no `agentId` query
param exists since an agent can only ever see their own. Same
pagination/filter conventions as the admin list (`status`, `q`,
`createdFrom`/`createdTo`) minus `onboardingSource` (implicitly always
`AGENT` for this endpoint) and minus any admin-only fields.

## 8. Analytics summary endpoint

`GET admin/clients/analytics`, permission `clients:analytics:read` (new,
dedicated key — not reusing `clients:read`). Optional `createdFrom`/`createdTo`
query params (same date-range convention as the existing list), applied to
`Client.createdAt`.

```typescript
interface ClientAnalyticsSummary {
  totalClients: number;
  bySource: { SELF: number; AGENT: number; ADMIN: number; NONE: number };
  byOnboardingStep: Record<OnboardingStep, number>; // all 6 values
  byClientStatus: Record<ClientStatus, number>; // all 4 values
  agentLeaderboard: Array<{
    agentId: string;
    agentName: string;
    totalOnboarded: number;
    completedCount: number;
    stalledCount: number; // totalOnboarded - completedCount
  }>; // sorted by totalOnboarded desc
  activity: {
    clientsWithAtLeastOneLoanRequest: number;
    clientsWithAtLeastOneDisbursedLoan: number;
    clientsWithAtLeastOneSession: number;
    totalLoanRequests: number;
    totalWalletEntries: number;
  };
}
```

Lives as a new `AdminClientAnalyticsService` class alongside the existing
`AdminClientActivityService`, in `src/admin-client-review/`, wired into the
existing `AdminClientReviewController`.

The `activity` block uses direct Prisma aggregate queries (`count`,
`groupBy`, `distinct`) against `LoanRequest`/`ClientLoan`/`Session`/
`WalletEntry` directly — it does **not** reuse `AdminClientActivityService`'s
per-client timeline-merge logic, which is built for one client's full event
list (app-code merge across 4-5 sources), not a cheap cross-client rollup.
For this version, activity totals are overall figures, not cross-tabulated by
onboarding source (e.g. not split into "self-onboarded clients' loan
requests" vs "agent-onboarded clients' loan requests") — a reasonable
follow-up enhancement, out of scope here to keep this endpoint's query count
bounded.

`agentLeaderboard` is built from a `groupBy` on `ClientOnboarding.onboardedByAgentId`
(non-null), joined to `Agent` for the name, with `completedCount` from a
second `count` scoped to `step: COMPLETED` per agent.

## 9. Permission seeding

Two new permissions added to `prisma/seed.ts`'s `BOOTSTRAP_PERMISSIONS`:

- `agents:onboarding-access:manage` — "Grant or revoke an agent's ability to onboard clients"
- `clients:analytics:read` — "View aggregate client onboarding and activity analytics"

The seed script's existing loop grants **every** permission to the
`SUPER_ADMIN` role unconditionally — no extra step needed for that role.
**Rollout note:** any *other* role that should have either of these
permissions needs it granted manually afterward via the existing
role-permission admin endpoints, same as any new permission added to this
system (this was already called out for `loan-products:manage` earlier and
applies identically here).

## 10. Full new/changed API surface

- `POST agent/clients/onboarding/ippis-lookup` — start/resume
- `POST agent/clients/:clientId/onboarding/identity`
- `POST agent/clients/:clientId/onboarding/documents/:type`
- `POST agent/clients/:clientId/onboarding/face-match`
- `GET agent/clients/:clientId/onboarding/status`
- `GET agent/clients` — agent's own onboarded-clients list
- `PATCH admin/agents/:id/onboarding-access`
- `GET admin/clients/analytics`
- `GET admin/clients` / `GET admin/clients/:id` — extended response
  (`onboardingSource`), new list filter

## 11. Testing

- Unit: `agentStartOnboarding` — fresh IPPIS number creates; same-agent resume
  returns existing; self-onboarded/admin-onboarded/different-agent-onboarded
  all reject with `ConflictException`.
- Unit: `AgentCanOnboardClientsGuard` — allows when flag true, rejects when
  false/agent not found.
- Unit: `deriveOnboardingSource` — all four cases (no onboarding, self, agent,
  admin).
- Unit: `AdminClientAnalyticsService` — each aggregate query mocked
  independently; leaderboard sorting; stalled-count derivation.
- Unit: admin onboarding-access toggle — rejects enabling for a
  non-`APPROVED` agent (422), allows disabling regardless of status, 404 for
  unknown agent.
- e2e: full agent-onboarding journey (ippis-lookup → identity → documents →
  face-match → status COMPLETED); the 409 restriction case (self-onboarded
  client, then a second agent, then the same agent resuming); the admin
  toggle (+ 422 on unapproved agent); `GET admin/clients/analytics`; `GET
  agent/clients` scoping; the admin list's new `onboardingSource`
  field/filter.

## 12. Postman

Per this repo's `CLAUDE.md`: new "Agent → Client Onboarding" folder (5
requests, success + validation/permission/409 failure scenarios each as
applicable) and new "Agent → My Clients" request under the Agent group; new
"Admin → Agents" folder gains the onboarding-access PATCH request (success +
422 + 403 + 404); new "Admin → Clients" (or wherever the existing client list
lives) gains the analytics GET request and an updated example for the
existing list showing the new `onboardingSource` field.

## 13. Out of scope

- Cross-tabulating activity totals by onboarding source (noted in §8 as a
  future enhancement).
- Any agent-facing analytics/leaderboard view — only admins see the
  leaderboard; agents only ever see their own flat client list (§7).
- Any change to how `clients:onboard` (admin's own onboarding) behaves —
  admin's existing idempotent/resumable-by-anyone behavior is untouched.
- Migrating/backfilling existing `ClientOnboarding` rows — none need it,
  since the new field is purely additive and defaults correctly to their
  existing self/admin classification.
