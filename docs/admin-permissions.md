# Admin Permissions Guide

> **Out of date (checked 2026-11-27).** Last updated 2026-10-20. Since then these keys were added
> to the code and aren't covered below: `alerts:manage`, `clients:assign`, `devices:manage`,
> `devices:read`, `face-match:manage`, `loan-requests:confirm-code`, `loan-requests:disburse`,
> `loan-requests:manage`, `loan-requests:read`, `loan-requests:reject`, `management-fees:manage`,
> `reconciliation:resolve`, `sectors:manage`, `sessions:manage`. `loan-requests:review` is no
> longer used. The code (`@RequirePermissions` and `prisma/seed.ts`) is the source of truth.

Which permission key guards which admin endpoint, and how the guard mechanism actually resolves that per route.

## How it works

- **Guard**: `src/auth/permissions.guard.ts` — `PermissionsGuard.canActivate()`
  reads required permissions via
  `Reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [handler, class])`.
  **A method-level decorator overrides the class-level one entirely** (not
  merged) — see the one place this actually happens, flagged below. If no
  decorator is present at either level, the guard passes everyone through
  with no permission check (the route still requires a valid admin JWT via
  `JwtAuthGuard`/`AdminOnlyGuard`, just no specific permission).
- **Decorator**: `src/auth/permissions.decorator.ts` —
  `@RequirePermissions('key:action', ...)`, backed by `SetMetadata` under
  `PERMISSIONS_KEY = 'requiredPermissions'`.
- Permission keys are seeded in `prisma/seed.ts`'s `BOOTSTRAP_PERMISSIONS`
  and granted per-role via `admin/roles`; the bootstrap `SUPER_ADMIN` role
  gets every key.
- Admin auth itself (`/auth/admin/*`) lives outside the `admin/*` path
  prefix — easy to miss if you're grepping by path convention alone.

---

## Endpoint → Permission

### Agents — `src/admin-agent-review/admin-agent-review.controller.ts` (`admin/agents`)
| Route | Permission |
|---|---|
| GET /admin/agents | `agents:read` |
| GET /admin/agents/analytics | `agents:analytics:read` |
| GET /admin/agents/:id | `agents:read` |
| POST /admin/agents/:id/approve | `agents:review` |
| POST /admin/agents/:id/reject | `agents:review` |
| POST /admin/agents/:id/resend-credentials | `agents:review` |
| PATCH /admin/agents/:id/onboarding-access | `agents:onboarding-access:manage` |

### Agent recruitment — `src/admin-agent-review/admin-agent-recruitment-review.controller.ts` (`admin/agent-recruitment-applications`)
| Route | Permission |
|---|---|
| GET /admin/agent-recruitment-applications | `agents:recruitment:read` |
| GET /admin/agent-recruitment-applications/analytics | `agents:recruitment:analytics:read` |
| GET /admin/agent-recruitment-applications/:id | `agents:recruitment:read` |
| DELETE /admin/agent-recruitment-applications/:id | `agents:recruitment:manage` |

### Audit log — `src/admin-audit-log/admin-audit-log.controller.ts` (`admin/audit-logs`)
| Route | Permission |
|---|---|
| GET /admin/audit-logs | `audit:read` |

### Catalog — `src/admin-catalog/admin-ippis-records.controller.ts` (`admin/ippis-records`)
| Route | Permission |
|---|---|
| GET /admin/ippis-records | `ippis:upload` |

### Catalog — `src/admin-catalog/admin-loans.controller.ts` (`admin/loans`)
| Route | Permission |
|---|---|
| GET /admin/loans | `loans:upload` |

### Departments — `src/admin-department/admin-departments.controller.ts` (`admin/departments`)
| Route | Permission |
|---|---|
| POST /admin/departments | `departments:manage` |
| GET /admin/departments | `departments:manage` |
| GET /admin/departments/:id | `departments:manage` |
| PATCH /admin/departments/:id | `departments:manage` |
| DELETE /admin/departments/:id | `departments:manage` |

### Client review — `src/admin-client-review/admin-client-review.controller.ts` (`admin/clients`)
| Route | Permission |
|---|---|
| GET /admin/clients | `clients:review` |
| GET /admin/clients/analytics | `clients:analytics:read` |
| GET /admin/clients/:id | `clients:review` |
| GET /admin/clients/:id/activities | `clients:read` |
| POST /admin/clients/:id/approve | `clients:review` |
| POST /admin/clients/:id/retry | `clients:review` |

### Admin role assignment — `src/admin-rbac/admin-role-assignment.controller.ts` (`admin/admins`)
| Route | Permission |
|---|---|
| GET /admin/admins | `roles:manage` |
| PATCH /admin/admins/:id/role | `roles:manage` |
| POST /admin/admins/:id/suspend | `roles:manage` |
| POST /admin/admins/:id/unsuspend | `roles:manage` |

### Permissions — `src/admin-rbac/admin-permissions.controller.ts` (`admin/permissions`)
| Route | Permission |
|---|---|
| POST /admin/permissions | `permissions:manage` |
| GET /admin/permissions | `permissions:manage` |
| GET /admin/permissions/:id | `permissions:manage` |
| PATCH /admin/permissions/:id | `permissions:manage` |
| DELETE /admin/permissions/:id | `permissions:manage` |

### Roles — `src/admin-rbac/admin-roles.controller.ts` (`admin/roles`)
| Route | Permission |
|---|---|
| POST /admin/roles | `roles:manage` |
| GET /admin/roles | `roles:manage` |
| GET /admin/roles/:id | `roles:manage` |
| PATCH /admin/roles/:id | `roles:manage` |
| DELETE /admin/roles/:id | `roles:manage` |
| POST /admin/roles/:id/permissions | `roles:manage` |
| POST /admin/roles/:id/permissions/bulk | `roles:manage` |
| DELETE /admin/roles/:id/permissions/:permissionId | `roles:manage` |

### Invites — `src/admin-invite/admin-invite.controller.ts` (`admin/invites`)
| Route | Permission |
|---|---|
| POST /admin/invites | `admins:create` |
| POST /admin/invites/:id/resend | `admins:create` |
| GET /admin/invites | `admins:create` |
| DELETE /admin/invites/:id | `admins:create` |

### Session revoke — `src/admin-session/admin-session.controller.ts` (`admin`)
| Route | Permission |
|---|---|
| POST /admin/agents/:id/sessions/revoke-all | `agents:sessions:revoke` |
| POST /admin/clients/:id/sessions/revoke-all | `clients:sessions:revoke` |

### Admin profile — `src/admin/admin.controller.ts` (`admin`)
| Route | Permission |
|---|---|
| GET /admin/me | *(admin auth only — no permission)* |
| PATCH /admin/me | *(admin auth only — no permission)* |
| POST /admin/me/profile-image | *(admin auth only — no permission)* |
| DELETE /admin/me/profile-image | *(admin auth only — no permission)* |

### Admin-initiated client onboarding — `src/client-onboarding/admin-client-onboarding.controller.ts` (`admin/clients`)
| Route | Permission |
|---|---|
| POST /admin/clients/onboarding/ippis-lookup | `clients:onboard` |
| POST /admin/clients/:clientId/onboarding/identity | `clients:onboard` |
| POST /admin/clients/:clientId/onboarding/documents/:type | `clients:onboard` |
| POST /admin/clients/:clientId/onboarding/face-match | `clients:onboard` |
| GET /admin/clients/:clientId/onboarding/status | `clients:onboard` |

### Loan products — `src/loan-products/admin-loan-products.controller.ts` (`admin/loan-products`)
Class-level only — `@RequirePermissions('loan-products:manage')`, no per-method overrides.
| Route | Permission |
|---|---|
| GET /admin/loan-products/sectors | `loan-products:manage` |
| POST /admin/loan-products | `loan-products:manage` |
| GET /admin/loan-products | `loan-products:manage` |
| PATCH /admin/loan-products/:id | `loan-products:manage` |

### Loan requests — `src/loan-request/admin-loan-request.controller.ts` (`admin/loan-requests`)
Class-level only — `@RequirePermissions('loan-requests:review')`, no per-method overrides.
| Route | Permission |
|---|---|
| GET /admin/loan-requests | `loan-requests:review` |
| POST /admin/loan-requests/:id/approve | `loan-requests:review` |
| POST /admin/loan-requests/:id/reject | `loan-requests:review` |
| POST /admin/loan-requests/:id/disburse | `loan-requests:review` |

### Client loans — `src/loan-request/admin-client-loans.controller.ts` (`admin/client-loans`)
Class-level `@RequirePermissions('client-loans:read')` — **except `list()`, which carries
its own `@RequirePermissions('clients:read')` and overrides the class-level one entirely**
(the one place in this codebase where method- and class-level permissions disagree).
| Route | Permission |
|---|---|
| GET /admin/client-loans | `clients:read` *(method-level override — not `client-loans:read`)* |
| GET /admin/client-loans/disbursement-summary | `client-loans:read` |
| GET /admin/client-loans/:id/repayment-plan | `client-loans:read` |

### Loan settings — `src/loan-settings/admin-loan-settings.controller.ts` (`admin/loan-settings`)
Class-level only — `@RequirePermissions('loan-settings:manage')`, no per-method overrides.
| Route | Permission |
|---|---|
| GET /admin/loan-settings | `loan-settings:manage` |
| PATCH /admin/loan-settings | `loan-settings:manage` |

### File downloads — `src/file-storage/file-download.controller.ts` (`admin/documents/files`)
| Route | Permission |
|---|---|
| GET /admin/documents/files/:key | `documents:read` |

### Document ingestion — `src/document-ingestion/admin-documents.controller.ts` (`admin/documents`)
| Route | Permission |
|---|---|
| POST /admin/documents/ippis-broadsheet/upload | `ippis:upload` |
| POST /admin/documents/disbursed-loans/upload | `loans:upload` |
| POST /admin/documents/repayment-schedule/upload | `repayments:upload` |
| GET /admin/documents/batches | `documents:read` |
| GET /admin/documents/batches/:id | `documents:read` |

### Reconciliation — `src/reconciliation/admin-reconciliation.controller.ts` (`admin/reconciliation`)
| Route | Permission |
|---|---|
| GET /admin/reconciliation | `reconciliation:read` |

### Wallet — `src/wallet/admin-wallet.controller.ts` (`admin/clients/:clientId/wallet`)
| Route | Permission |
|---|---|
| GET /admin/clients/:clientId/wallet | `wallets:read` |
| POST /admin/clients/:clientId/wallet/credit | `wallets:manage` |
| POST /admin/clients/:clientId/wallet/debit | `wallets:manage` |

### Admin auth — `src/auth/admin/admin-auth.controller.ts` (`auth/admin` — outside the `admin/*` prefix)
| Route | Permission |
|---|---|
| POST /auth/admin/login | *(public — no guard)* |
| POST /auth/admin/accept-invite | *(public, token-based — no guard)* |
| POST /auth/admin/forgot-password | *(public — no guard)* |
| POST /auth/admin/reset-password | *(public, token-based — no guard)* |
| POST /auth/admin/change-password | *(admin auth only — no permission)* |
| POST /auth/admin/2fa/setup | *(admin auth only — no permission)* |
| POST /auth/admin/2fa/confirm | *(admin auth only — no permission)* |
| POST /auth/admin/2fa/disable | *(admin auth only — no permission)* |
| POST /auth/admin/2fa/login-verify | *(public, pending-token based — no guard)* |

---

## Canonical permission keys (`prisma/seed.ts`)

| Key | Description |
|---|---|
| `admins:create` | Create admin users |
| `roles:manage` | Create/edit roles and permissions |
| `agents:read` | View agent enrollment submissions |
| `agents:review` | Approve or reject agent submissions |
| `clients:review` | Review clients flagged for manual review |
| `ippis:upload` | Upload/refresh IPPIS master data |
| `agents:sessions:revoke` | Force-revoke an agent's active sessions |
| `clients:sessions:revoke` | Force-revoke a client's active sessions |
| `audit:read` | View audit log entries |
| `loans:upload` | Upload disbursed loans reports |
| `repayments:upload` | Upload IPPIS repayment schedule reports |
| `documents:read` | View document upload batches and snapshot exports |
| `permissions:manage` | Create, edit, and delete permission definitions |
| `reconciliation:read` | View loan repayment reconciliation variances |
| `wallets:read` | View a client's wallet balance and entries |
| `wallets:manage` | Credit or debit a client's wallet |
| `loan-products:manage` | Create/edit the loan product catalog (sectors, amount/tenor range, interest tiers, service-length eligibility) |
| `loan-settings:manage` | Configure the global retirement-age and max-service-years settings used for loan eligibility |
| `loan-requests:review` | Approve, reject, or disburse client loan requests |
| `client-loans:read` | View client loans and disbursement reports |
| `clients:read` | View a client's loan requests, loans, and activity history |
| `departments:manage` | Create, edit, and delete department definitions |
| `clients:onboard` | Onboard a client on the client's behalf (admin-initiated onboarding) |
| `agents:onboarding-access:manage` | Grant or revoke an agent's ability to onboard clients |
| `clients:analytics:read` | View aggregate client onboarding and activity analytics |
| `agents:analytics:read` | View aggregate agent-application analytics |
| `agents:recruitment:read` | View in-progress and completed agent recruitment applications |
| `agents:recruitment:analytics:read` | View agent recruitment funnel analytics |
| `agents:recruitment:manage` | Delete an abandoned agent recruitment application |

**29 keys total.** The bootstrap `SUPER_ADMIN` role is granted every one of them.
Every key above is referenced by at least one route, and every route's
`@RequirePermissions(...)` string matches one of these keys exactly — no
unused permissions, no typos, as of this writing.

---

## Keeping this current

This is a snapshot, not generated at build time — if a new admin
controller/route is added, update the relevant table here (and
`postman/public-sector-backend.postman_collection.json`, per this
project's standing CLAUDE.md rule) in the same change.
