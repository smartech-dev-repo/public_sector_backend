# Email Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all 13 bare, inline-built email bodies across this app with a shared Moneyfield-branded layout and proper, warm, context-appropriate copy — 11 template functions in a new `src/email/templates/` directory, with every call site updated to use them.

**Architecture:** A shared `wrapEmailLayout`/`wrapEmailLayoutText`/`highlightBox` set of plain functions (`layout.ts`) builds the branded shell; 11 small template functions (split across `verification-code-emails.ts`, `token-emails.ts`, `action-emails.ts`) each call it with their own headline/body and return `{ subject, html, text }`. Call sites change from building their own object to spreading a template function's return value alongside `to`. No change to `EmailMessage`/`EmailProvider`/`EmailService`.

**Tech Stack:** NestJS, plain TypeScript functions (no templating library), Jest unit tests.

**Spec:** `docs/superpowers/specs/2026-10-19-email-templates-design.md`

## Global Constraints

- No new dependency, no change to `EmailMessage`/`EmailProvider`/`EmailService` or any of the 3 provider implementations.
- 7 of the 11 templates (`twoFactorSetupCodeEmail`, `loginVerificationCodeEmail`, `agentRecruitmentVerificationCodeEmail`, `adminPasswordResetEmail`, `agentPasswordResetEmail`, `adminInviteEmail`, `adminInviteResentEmail`) MUST keep an exact old phrase-adjacent-to-value substring in their `text` output, byte-for-byte, so existing e2e/unit test regexes keep matching — see each template's own code comment for the exact phrase.
- `clientOtpCodeEmail`'s copy MUST contain the literal substring "verification code" (unit test constraint in `src/otp/otp.service.spec.ts:243`).
- Palette/brand constants (`#2B6830`, `#7AC142`, `#96874A`, `#2D2D2D`, `#F4F6F4`, `#FFFFFF`, "RC: 903524") are hardcoded in `layout.ts`, not configurable.
- `EMAIL_LOGO_URL` and `SUPPORT_EMAIL` are new env vars (read via `process.env` directly in `layout.ts`, matching the existing plain-function pattern in `src/common/password-hash.util.ts` — not injectable, so no `ConfigService`).

---

### Task 1: Shared layout (`layout.ts`)

**Files:**
- Create: `src/email/templates/layout.ts`
- Create: `src/email/templates/layout.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `wrapEmailLayout({ headline: string; bodyHtml: string }): string`, `wrapEmailLayoutText({ headline: string; bodyText: string }): string`, `highlightBox(value: string): string` — consumed by Tasks 2, 3, 4.

- [ ] **Step 1: Write the layout module**

```typescript
// src/email/templates/layout.ts
const PRIMARY_GREEN = '#2B6830';
const SECONDARY_GREEN = '#7AC142';
const OLIVE_GOLD = '#96874A';
const BODY_TEXT_COLOR = '#2D2D2D';
const PAGE_BACKGROUND = '#F4F6F4';
const CARD_BACKGROUND = '#FFFFFF';
const RC_NUMBER = 'RC: 903524';

function logoUrl(): string {
  return (
    process.env.EMAIL_LOGO_URL ??
    'https://res.cloudinary.com/dwfedg8uv/image/upload/f_auto,q_auto:best/moneyfield-logo_vcfhhn'
  );
}

function companyName(): string {
  return process.env.EMAIL_FROM_NAME ?? 'Moneyfield Microfinance Bank Limited';
}

function supportEmail(): string {
  return process.env.SUPPORT_EMAIL ?? 'support@moneyfieldmfb.com';
}

export function highlightBox(value: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding: 16px 0;"><div style="display: inline-block; background-color: #EAF5EA; border: 2px solid ${PRIMARY_GREEN}; border-radius: 6px; padding: 12px 24px; font-family: monospace; font-size: 22px; font-weight: 700; letter-spacing: 2px; color: ${PRIMARY_GREEN};">${value}</div></td></tr></table>`;
}

export function wrapEmailLayout(params: { headline: string; bodyHtml: string }): string {
  return `<!doctype html>
<html>
  <body style="margin: 0; padding: 0; background-color: ${PAGE_BACKGROUND}; font-family: Arial, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: ${PAGE_BACKGROUND};">
      <tr>
        <td align="center" style="padding: 24px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background-color: ${CARD_BACKGROUND};">
            <tr>
              <td align="center" style="background-color: ${CARD_BACKGROUND}; padding: 24px; border-bottom: 2px solid ${SECONDARY_GREEN};">
                <img src="${logoUrl()}" alt="${companyName()}" style="max-width: 240px; height: auto;" />
              </td>
            </tr>
            <tr>
              <td style="background-color: ${CARD_BACKGROUND}; padding: 32px;">
                <h1 style="margin: 0 0 16px; color: ${PRIMARY_GREEN}; font-size: 20px; font-weight: 600;">${params.headline}</h1>
                <div style="color: ${BODY_TEXT_COLOR}; font-size: 15px; line-height: 1.6;">${params.bodyHtml}</div>
              </td>
            </tr>
            <tr>
              <td align="center" style="background-color: ${PAGE_BACKGROUND}; padding: 24px; font-size: 12px; color: #6B6B6B;">
                <div style="color: ${OLIVE_GOLD}; font-weight: 600;">${companyName()}</div>
                <div>${RC_NUMBER}</div>
                <div>Need help? Contact ${supportEmail()}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function wrapEmailLayoutText(params: { headline: string; bodyText: string }): string {
  return `${params.headline}\n\n${params.bodyText}\n\n—\n${companyName()}\n${RC_NUMBER}\nNeed help? Contact ${supportEmail()}`;
}
```

- [ ] **Step 2: Write its spec**

```typescript
// src/email/templates/layout.spec.ts
import { wrapEmailLayout, wrapEmailLayoutText, highlightBox } from './layout';

describe('highlightBox', () => {
  it('wraps the value in a bordered box', () => {
    const html = highlightBox('123456');
    expect(html).toContain('123456');
    expect(html).toContain('#2B6830');
  });
});

describe('wrapEmailLayout', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('includes the headline, body, logo, and footer', () => {
    const html = wrapEmailLayout({ headline: 'Test Headline', bodyHtml: '<p>Test body</p>' });
    expect(html).toContain('Test Headline');
    expect(html).toContain('Test body');
    expect(html).toContain('RC: 903524');
    expect(html).toContain('moneyfield-logo_vcfhhn');
  });

  it('uses EMAIL_LOGO_URL from the environment when set', () => {
    process.env.EMAIL_LOGO_URL = 'https://example.com/custom-logo.png';
    const html = wrapEmailLayout({ headline: 'H', bodyHtml: '<p>B</p>' });
    expect(html).toContain('https://example.com/custom-logo.png');
  });

  it('uses SUPPORT_EMAIL from the environment when set', () => {
    process.env.SUPPORT_EMAIL = 'help@example.com';
    const html = wrapEmailLayout({ headline: 'H', bodyHtml: '<p>B</p>' });
    expect(html).toContain('help@example.com');
  });

  it('falls back to the default support email when unset', () => {
    delete process.env.SUPPORT_EMAIL;
    const html = wrapEmailLayout({ headline: 'H', bodyHtml: '<p>B</p>' });
    expect(html).toContain('support@moneyfieldmfb.com');
  });
});

describe('wrapEmailLayoutText', () => {
  it('includes the headline, body, and footer with no markup', () => {
    const text = wrapEmailLayoutText({ headline: 'Test Headline', bodyText: 'Test body' });
    expect(text).toContain('Test Headline');
    expect(text).toContain('Test body');
    expect(text).toContain('RC: 903524');
    expect(text).not.toContain('<');
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest src/email/templates/layout.spec.ts`
Expected: PASS (7 tests)

- [ ] **Step 4: Add the env vars**

In `.env.example`, add near the other `EMAIL_*` entries:

```
EMAIL_LOGO_URL=https://res.cloudinary.com/dwfedg8uv/image/upload/f_auto,q_auto:best/moneyfield-logo_vcfhhn
SUPPORT_EMAIL=support@moneyfieldmfb.com
```

- [ ] **Step 5: Commit**

```bash
git add src/email/templates/layout.ts src/email/templates/layout.spec.ts .env.example
git commit -m "feat(email): add shared branded layout for email templates"
```

---

### Task 2: Verification-code templates

**Files:**
- Create: `src/email/templates/verification-code-emails.ts`
- Create: `src/email/templates/verification-code-emails.spec.ts`

**Interfaces:**
- Consumes: `wrapEmailLayout`, `wrapEmailLayoutText`, `highlightBox` (Task 1).
- Produces: `twoFactorSetupCodeEmail`, `loginVerificationCodeEmail`, `agentRecruitmentVerificationCodeEmail`, `clientOtpCodeEmail` — each `(params) => { subject, html, text }` — consumed by Task 5 (auth services) and Task 7 (recruitment/otp services).

- [ ] **Step 1: Write the templates**

```typescript
// src/email/templates/verification-code-emails.ts
import { wrapEmailLayout, wrapEmailLayoutText, highlightBox } from './layout';

export function twoFactorSetupCodeEmail(params: { code: string; ttlMinutes: number }): { subject: string; html: string; text: string } {
  // "Your verification code is: " must stay immediately before the code,
  // on one line, in `text` — test/admin-two-factor-auth.e2e-spec.ts,
  // agent-two-factor-auth.e2e-spec.ts, and src/auth/admin/admin-auth.service.spec.ts:319-321
  // / src/auth/agent/agent-auth.service.spec.ts:426-428 regex-match this exact phrase.
  const bodyText = `You're enabling email-based two-factor authentication on your account.\n\nYour verification code is: ${params.code}\n\nThis code expires in ${params.ttlMinutes} minutes. If you didn't request this, you can safely ignore this email.`;
  const bodyHtml = `<p>You're enabling email-based two-factor authentication on your account.</p><p>Your verification code is:</p>${highlightBox(params.code)}<p>This code expires in ${params.ttlMinutes} minutes. If you didn't request this, you can safely ignore this email.</p>`;
  return {
    subject: 'Your two-factor setup code',
    html: wrapEmailLayout({ headline: 'Set up two-factor authentication', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Set up two-factor authentication', bodyText }),
  };
}

export function loginVerificationCodeEmail(params: { code: string; ttlMinutes: number }): { subject: string; html: string; text: string } {
  // Same "Your verification code is: " constraint as twoFactorSetupCodeEmail.
  const bodyText = `We received a sign-in attempt that requires email verification.\n\nYour verification code is: ${params.code}\n\nThis code expires in ${params.ttlMinutes} minutes. If this wasn't you, please change your password immediately.`;
  const bodyHtml = `<p>We received a sign-in attempt that requires email verification.</p><p>Your verification code is:</p>${highlightBox(params.code)}<p>This code expires in ${params.ttlMinutes} minutes. If this wasn't you, please change your password immediately.</p>`;
  return {
    subject: 'Your login verification code',
    html: wrapEmailLayout({ headline: "Verify it's you", bodyHtml }),
    text: wrapEmailLayoutText({ headline: "Verify it's you", bodyText }),
  };
}

export function agentRecruitmentVerificationCodeEmail(params: { code: string; ttlMinutes: number }): { subject: string; html: string; text: string } {
  // Same "Your verification code is: " constraint — test/agent-recruitment.e2e-spec.ts
  // and test/admin-agent-recruitment-review.e2e-spec.ts both regex-match it.
  const bodyText = `Thanks for starting your agent application with Moneyfield Microfinance Bank.\n\nYour verification code is: ${params.code}\n\nThis code expires in ${params.ttlMinutes} minutes.`;
  const bodyHtml = `<p>Thanks for starting your agent application with Moneyfield Microfinance Bank.</p><p>Your verification code is:</p>${highlightBox(params.code)}<p>This code expires in ${params.ttlMinutes} minutes.</p>`;
  return {
    subject: 'Verify your email to continue your application',
    html: wrapEmailLayout({ headline: 'Verify your email', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Verify your email', bodyText }),
  };
}

export function clientOtpCodeEmail(params: { code: string; ttlMinutes: number }): { subject: string; html: string; text: string } {
  // src/otp/otp.service.spec.ts:243 asserts `html` contains "verification code".
  const bodyText = `Use this verification code to log in to your Moneyfield account:\n\n${params.code}\n\nThis code expires in ${params.ttlMinutes} minutes. This is a backup copy — you should also have received it by SMS.`;
  const bodyHtml = `<p>Use this verification code to log in to your Moneyfield account:</p>${highlightBox(params.code)}<p>This code expires in ${params.ttlMinutes} minutes. This is a backup copy — you should also have received it by SMS.</p>`;
  return {
    subject: 'Your login code',
    html: wrapEmailLayout({ headline: 'Your one-time login code', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Your one-time login code', bodyText }),
  };
}
```

- [ ] **Step 2: Write the spec**

```typescript
// src/email/templates/verification-code-emails.spec.ts
import {
  twoFactorSetupCodeEmail,
  loginVerificationCodeEmail,
  agentRecruitmentVerificationCodeEmail,
  clientOtpCodeEmail,
} from './verification-code-emails';

describe('twoFactorSetupCodeEmail', () => {
  it('includes the exact phrase and code on one line in text', () => {
    const result = twoFactorSetupCodeEmail({ code: '123456', ttlMinutes: 10 });
    expect(result.subject).toBe('Your two-factor setup code');
    expect(result.text).toContain('Your verification code is: 123456');
    expect(result.html).toContain('123456');
    expect(result.text).toContain('10 minutes');
  });
});

describe('loginVerificationCodeEmail', () => {
  it('includes the exact phrase and code on one line in text', () => {
    const result = loginVerificationCodeEmail({ code: '654321', ttlMinutes: 10 });
    expect(result.subject).toBe('Your login verification code');
    expect(result.text).toContain('Your verification code is: 654321');
    expect(result.html).toContain('654321');
  });
});

describe('agentRecruitmentVerificationCodeEmail', () => {
  it('includes the exact phrase and code on one line in text', () => {
    const result = agentRecruitmentVerificationCodeEmail({ code: '111222', ttlMinutes: 10 });
    expect(result.subject).toBe('Verify your email to continue your application');
    expect(result.text).toContain('Your verification code is: 111222');
    expect(result.html).toContain('111222');
  });
});

describe('clientOtpCodeEmail', () => {
  it('includes "verification code" and the code', () => {
    const result = clientOtpCodeEmail({ code: '4321', ttlMinutes: 5 });
    expect(result.subject).toBe('Your login code');
    expect(result.html).toContain('verification code');
    expect(result.text).toContain('4321');
    expect(result.text).toContain('5 minutes');
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest src/email/templates/verification-code-emails.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 4: Commit**

```bash
git add src/email/templates/verification-code-emails.ts src/email/templates/verification-code-emails.spec.ts
git commit -m "feat(email): add verification-code email templates"
```

---

### Task 3: Token templates

**Files:**
- Create: `src/email/templates/token-emails.ts`
- Create: `src/email/templates/token-emails.spec.ts`

**Interfaces:**
- Consumes: `wrapEmailLayout`, `wrapEmailLayoutText`, `highlightBox` (Task 1).
- Produces: `adminPasswordResetEmail`, `agentPasswordResetEmail`, `adminInviteEmail`, `adminInviteResentEmail` — consumed by Task 5 (auth services) and Task 6 (admin-invite controller).

- [ ] **Step 1: Write the templates**

```typescript
// src/email/templates/token-emails.ts
import { wrapEmailLayout, wrapEmailLayoutText, highlightBox } from './layout';

export function adminPasswordResetEmail(params: { token: string }): { subject: string; html: string; text: string } {
  // "reset your password: " must stay immediately before the token, on
  // one line, in `text` — test/admin-password-self-service.e2e-spec.ts
  // regex-matches this exact phrase.
  const bodyText = `We received a request to reset your admin account password.\n\nUse this token to reset your password: ${params.token}\n\nThis token expires in 1 hour. If you didn't request this, you can safely ignore this email — your password won't change.`;
  const bodyHtml = `<p>We received a request to reset your admin account password. Enter this token in the reset form:</p>${highlightBox(params.token)}<p>This token expires in 1 hour. If you didn't request this, you can safely ignore this email — your password won't change.</p>`;
  return {
    subject: 'Reset your password',
    html: wrapEmailLayout({ headline: 'Reset your password', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Reset your password', bodyText }),
  };
}

export function agentPasswordResetEmail(params: { token: string; code: string }): { subject: string; html: string; text: string } {
  // Both "reset your password: " and "enter this code: " must stay
  // immediately before their value, on one line, in `text` —
  // test/agent-password-self-service.e2e-spec.ts and
  // src/auth/agent/agent-auth.service.spec.ts:233-235 regex-match both.
  const bodyText = `We received a request to reset your password. Use either of the following to continue:\n\nUse this token to reset your password: ${params.token}\nOr enter this code: ${params.code}\n\nBoth expire in 1 hour. If you didn't request this, you can safely ignore this email.`;
  const bodyHtml = `<p>We received a request to reset your password. Use either of the following to continue:</p><p><strong>Token:</strong></p>${highlightBox(params.token)}<p><strong>Code:</strong></p>${highlightBox(params.code)}<p>Both expire in 1 hour. If you didn't request this, you can safely ignore this email.</p>`;
  return {
    subject: 'Reset your password',
    html: wrapEmailLayout({ headline: 'Reset your password', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Reset your password', bodyText }),
  };
}

export function adminInviteEmail(params: { token: string }): { subject: string; html: string; text: string } {
  // "accept: " must stay immediately before the token, on one line, in
  // `text` — test/admin-invite.e2e-spec.ts regex-matches this exact phrase.
  const bodyText = `You've been invited to join Moneyfield Microfinance Bank's admin team.\n\nUse this token to accept: ${params.token}`;
  const bodyHtml = `<p>You've been invited to join Moneyfield Microfinance Bank's admin team. Use this token to accept your invitation and set up your account:</p>${highlightBox(params.token)}`;
  return {
    subject: "You've been invited to Moneyfield Admin",
    html: wrapEmailLayout({ headline: "You're invited", bodyHtml }),
    text: wrapEmailLayoutText({ headline: "You're invited", bodyText }),
  };
}

export function adminInviteResentEmail(params: { token: string }): { subject: string; html: string; text: string } {
  // Same "accept: " constraint as adminInviteEmail.
  const bodyText = `You've been invited to join Moneyfield Microfinance Bank's admin team.\n\nUse this token to accept: ${params.token}`;
  const bodyHtml = `<p>You've been invited to join Moneyfield Microfinance Bank's admin team. Use this token to accept your invitation and set up your account:</p>${highlightBox(params.token)}`;
  return {
    subject: 'Your admin invitation (resent)',
    html: wrapEmailLayout({ headline: 'Your invitation, resent', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Your invitation, resent', bodyText }),
  };
}
```

- [ ] **Step 2: Write the spec**

```typescript
// src/email/templates/token-emails.spec.ts
import { adminPasswordResetEmail, agentPasswordResetEmail, adminInviteEmail, adminInviteResentEmail } from './token-emails';

describe('adminPasswordResetEmail', () => {
  it('includes the exact phrase and token on one line in text', () => {
    const result = adminPasswordResetEmail({ token: 'abc123tok' });
    expect(result.subject).toBe('Reset your password');
    expect(result.text).toContain('reset your password: abc123tok');
    expect(result.html).toContain('abc123tok');
  });
});

describe('agentPasswordResetEmail', () => {
  it('includes both exact phrases with their values on their own lines in text', () => {
    const result = agentPasswordResetEmail({ token: 'tok456', code: '998877' });
    expect(result.text).toMatch(/reset your password: tok456/);
    expect(result.text).toMatch(/enter this code: 998877/);
    expect(result.html).toContain('tok456');
    expect(result.html).toContain('998877');
  });
});

describe('adminInviteEmail', () => {
  it('includes the exact phrase and token on one line in text', () => {
    const result = adminInviteEmail({ token: 'invite-tok' });
    expect(result.subject).toBe("You've been invited to Moneyfield Admin");
    expect(result.text).toContain('accept: invite-tok');
    expect(result.html).toContain('invite-tok');
  });
});

describe('adminInviteResentEmail', () => {
  it('includes the exact phrase and token on one line in text', () => {
    const result = adminInviteResentEmail({ token: 'invite-tok-2' });
    expect(result.subject).toBe('Your admin invitation (resent)');
    expect(result.text).toContain('accept: invite-tok-2');
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest src/email/templates/token-emails.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 4: Commit**

```bash
git add src/email/templates/token-emails.ts src/email/templates/token-emails.spec.ts
git commit -m "feat(email): add token email templates"
```

---

### Task 4: Action templates

**Files:**
- Create: `src/email/templates/action-emails.ts`
- Create: `src/email/templates/action-emails.spec.ts`

**Interfaces:**
- Consumes: `wrapEmailLayout`, `wrapEmailLayoutText`, `highlightBox` (Task 1).
- Produces: `agentApplicationRejectedEmail`, `agentCredentialsEmail`, `loanRequestConfirmationEmail` — consumed by Task 6 (admin-agent-review service) and Task 7 (loan-request service).

- [ ] **Step 1: Write the templates**

```typescript
// src/email/templates/action-emails.ts
import { wrapEmailLayout, wrapEmailLayoutText, highlightBox } from './layout';

export function agentApplicationRejectedEmail(params: { fullName: string; reason: string }): { subject: string; html: string; text: string } {
  // "Reason: " must stay immediately before the reason text — src/admin-agent-review/admin-agent-review.service.spec.ts
  // asserts `text` contains the reason string.
  const bodyText = `Hi ${params.fullName}, thank you for applying to become a Moneyfield agent. After review, we're unable to approve your application at this time.\n\nReason: ${params.reason}\n\nIf you believe this was a mistake or have questions, please contact support.`;
  const bodyHtml = `<p>Hi ${params.fullName}, thank you for applying to become a Moneyfield agent. After review, we're unable to approve your application at this time.</p><p><strong>Reason:</strong> ${params.reason}</p><p>If you believe this was a mistake or have questions, please contact support.</p>`;
  return {
    subject: 'An update on your agent application',
    html: wrapEmailLayout({ headline: 'Application update', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Application update', bodyText }),
  };
}

export function agentCredentialsEmail(params: { fullName: string; email: string; temporaryPassword: string; downloadUrl?: string }): { subject: string; html: string; text: string } {
  // "Download the app: " must stay present/absent exactly as before —
  // src/admin-agent-review/admin-agent-review.service.spec.ts asserts
  // both the absence (no downloadUrl) and presence+URL (with downloadUrl) cases.
  const downloadText = params.downloadUrl ? `\n\nDownload the app: ${params.downloadUrl}` : '';
  const downloadHtml = params.downloadUrl ? `<p>Download the app: <a href="${params.downloadUrl}">${params.downloadUrl}</a></p>` : '';
  const bodyText = `Hi ${params.fullName}, your agent account has been approved. Here are your login details:\n\nEmail: ${params.email}\nTemporary password: ${params.temporaryPassword}${downloadText}\n\nYou'll be asked to set a new password the first time you log in.`;
  const bodyHtml = `<p>Hi ${params.fullName}, your agent account has been approved. Here are your login details:</p><p>Email: ${params.email}</p>${highlightBox(params.temporaryPassword)}${downloadHtml}<p>You'll be asked to set a new password the first time you log in.</p>`;
  return {
    subject: 'Welcome to Moneyfield — your account is ready',
    html: wrapEmailLayout({ headline: 'Your account is ready', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Your account is ready', bodyText }),
  };
}

export function loanRequestConfirmationEmail(params: { amount: number; type: 'ORIGINATION' | 'TOPUP' }): { subject: string; html: string; text: string } {
  // src/loan-request/loan-request.service.spec.ts asserts `text` contains
  // the amount (e.g. "5000") and, for topups, the substring "top-up".
  const kind = params.type === 'TOPUP' ? 'loan top-up' : 'loan';
  const bodyText = `We've received your ${kind} request for ₦${params.amount}. To confirm it, reply YES to the SMS we sent to your registered phone number. This email is a copy of that message for your records.`;
  const bodyHtml = `<p>We've received your ${kind} request for ₦${params.amount}. To confirm it, reply YES to the SMS we sent to your registered phone number. This email is a copy of that message for your records.</p>`;
  return {
    subject: 'Confirm your loan request',
    html: wrapEmailLayout({ headline: 'Confirm your loan request', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Confirm your loan request', bodyText }),
  };
}
```

- [ ] **Step 2: Write the spec**

```typescript
// src/email/templates/action-emails.spec.ts
import { agentApplicationRejectedEmail, agentCredentialsEmail, loanRequestConfirmationEmail } from './action-emails';

describe('agentApplicationRejectedEmail', () => {
  it('includes the fullName and reason', () => {
    const result = agentApplicationRejectedEmail({ fullName: 'Jane Doe', reason: 'Incomplete CV' });
    expect(result.subject).toBe('An update on your agent application');
    expect(result.text).toContain('Jane Doe');
    expect(result.text).toContain('Incomplete CV');
  });
});

describe('agentCredentialsEmail', () => {
  it('omits the download line when no downloadUrl is given', () => {
    const result = agentCredentialsEmail({ fullName: 'Jane Doe', email: 'jane@example.com', temporaryPassword: 'temp123' });
    expect(result.text).not.toMatch(/Download the app/);
    expect(result.text).toContain('temp123');
  });

  it('includes the download line and URL when downloadUrl is given', () => {
    const result = agentCredentialsEmail({
      fullName: 'Jane Doe',
      email: 'jane@example.com',
      temporaryPassword: 'temp123',
      downloadUrl: 'https://example.com/download',
    });
    expect(result.text).toContain('Download the app: https://example.com/download');
    expect(result.html).toContain('https://example.com/download');
  });
});

describe('loanRequestConfirmationEmail', () => {
  it('includes the amount for an origination request', () => {
    const result = loanRequestConfirmationEmail({ amount: 5000, type: 'ORIGINATION' });
    expect(result.subject).toBe('Confirm your loan request');
    expect(result.text).toContain('5000');
    expect(result.text).not.toContain('top-up');
  });

  it('includes "top-up" for a topup request', () => {
    const result = loanRequestConfirmationEmail({ amount: 5000, type: 'TOPUP' });
    expect(result.text).toContain('top-up');
    expect(result.text).toContain('5000');
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest src/email/templates/action-emails.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 4: Commit**

```bash
git add src/email/templates/action-emails.ts src/email/templates/action-emails.spec.ts
git commit -m "feat(email): add action/credential email templates"
```

---

### Task 5: Wire admin-auth and agent-auth services

**Files:**
- Modify: `src/auth/admin/admin-auth.service.ts`
- Modify: `src/auth/agent/agent-auth.service.ts`

**Interfaces:**
- Consumes: `adminPasswordResetEmail`, `twoFactorSetupCodeEmail`, `loginVerificationCodeEmail` (Tasks 2, 3) for admin; `agentPasswordResetEmail`, `twoFactorSetupCodeEmail`, `loginVerificationCodeEmail` for agent.

- [ ] **Step 1: Wire `admin-auth.service.ts`**

Add the import near the other imports:

```typescript
import { adminPasswordResetEmail } from '../../email/templates/token-emails';
import { twoFactorSetupCodeEmail, loginVerificationCodeEmail } from '../../email/templates/verification-code-emails';
```

Change the forgot-password send from:

```typescript
    await this.emailService.send({
      to: admin.email,
      subject: 'Reset your password',
      html: `<p>Use this token to reset your password: ${token}</p>`,
      text: `Use this token to reset your password: ${token}`,
    });
```

to:

```typescript
    await this.emailService.send({ to: admin.email, ...adminPasswordResetEmail({ token }) });
```

Change the 2FA setup send from:

```typescript
    await this.emailService.send({
      to: admin.email,
      subject: 'Your two-factor setup code',
      html: `<p>Your verification code is: ${code}</p>`,
      text: `Your verification code is: ${code}`,
    });
```

to:

```typescript
    await this.emailService.send({ to: admin.email, ...twoFactorSetupCodeEmail({ code, ttlMinutes: 10 }) });
```

Change the login-challenge send from:

```typescript
      await this.emailService.send({
        to: admin.email,
        subject: 'Your login verification code',
        html: `<p>Your verification code is: ${code}</p>`,
        text: `Your verification code is: ${code}`,
      });
```

to:

```typescript
      await this.emailService.send({ to: admin.email, ...loginVerificationCodeEmail({ code, ttlMinutes: 10 }) });
```

- [ ] **Step 2: Run `admin-auth.service.spec.ts` to verify it still passes**

Run: `npx jest src/auth/admin/admin-auth.service.spec.ts`
Expected: PASS (all existing tests, no test changes needed — the exact phrases are preserved by the template functions themselves)

- [ ] **Step 3: Wire `agent-auth.service.ts`**

Add the import near the other imports:

```typescript
import { agentPasswordResetEmail } from '../../email/templates/token-emails';
import { twoFactorSetupCodeEmail, loginVerificationCodeEmail } from '../../email/templates/verification-code-emails';
```

Change the forgot-password send from:

```typescript
    await this.emailService.send({
      to: agent.email,
      subject: 'Reset your password',
      html: `<p>Use this link to reset your password: ${token}</p><p>Or enter this code: ${code}</p>`,
      text: `Use this token to reset your password: ${token}\nOr enter this code: ${code}`,
    });
```

to:

```typescript
    await this.emailService.send({ to: agent.email, ...agentPasswordResetEmail({ token, code }) });
```

Change the 2FA setup send from:

```typescript
    await this.emailService.send({
      to: agent.email,
      subject: 'Your two-factor setup code',
      html: `<p>Your verification code is: ${code}</p>`,
      text: `Your verification code is: ${code}`,
    });
```

to:

```typescript
    await this.emailService.send({ to: agent.email, ...twoFactorSetupCodeEmail({ code, ttlMinutes: 10 }) });
```

Change the login-challenge send from:

```typescript
      await this.emailService.send({
        to: agent.email,
        subject: 'Your login verification code',
        html: `<p>Your verification code is: ${code}</p>`,
        text: `Your verification code is: ${code}`,
      });
```

to:

```typescript
      await this.emailService.send({ to: agent.email, ...loginVerificationCodeEmail({ code, ttlMinutes: 10 }) });
```

- [ ] **Step 4: Run `agent-auth.service.spec.ts` to verify it still passes**

Run: `npx jest src/auth/agent/agent-auth.service.spec.ts`
Expected: PASS (all existing tests, no test changes needed)

- [ ] **Step 5: Commit**

```bash
git add src/auth/admin/admin-auth.service.ts src/auth/agent/agent-auth.service.ts
git commit -m "feat(auth): wire admin/agent auth emails to the new templates"
```

---

### Task 6: Wire admin-agent-review service and admin-invite controller

**Files:**
- Modify: `src/admin-agent-review/admin-agent-review.service.ts`
- Modify: `src/admin-invite/admin-invite.controller.ts`

**Interfaces:**
- Consumes: `agentApplicationRejectedEmail`, `agentCredentialsEmail` (Task 4); `adminInviteEmail`, `adminInviteResentEmail` (Task 3).

- [ ] **Step 1: Wire `admin-agent-review.service.ts`**

Add the import near the other imports:

```typescript
import { agentApplicationRejectedEmail, agentCredentialsEmail } from '../email/templates/action-emails';
```

Change the `reject()` send from:

```typescript
    await this.emailService.send({
      to: agent.email,
      subject: 'Your agent application was not approved',
      html: `<p>Your application was not approved.</p><p>Reason: ${reason}</p>`,
      text: `Your application was not approved.\nReason: ${reason}`,
    });
```

to:

```typescript
    await this.emailService.send({ to: agent.email, ...agentApplicationRejectedEmail({ fullName: agent.fullName, reason }) });
```

Change the `issueCredentials()` send — remove the now-unused `downloadHtml`/`downloadText` local variables and change:

```typescript
    const downloadUrl = this.configService.get<string>('AGENT_APP_DOWNLOAD_URL');
    const downloadHtml = downloadUrl ? `<p>Download the app: ${downloadUrl}</p>` : '';
    const downloadText = downloadUrl ? `Download the app: ${downloadUrl}\n` : '';

    await this.emailService.send({
      to: agent.email,
      subject: 'Your agent account has been approved',
      html: `<p>Email: ${agent.email}</p><p>Temporary password: ${temporaryPassword}</p>${downloadHtml}<p>You will be required to change this password on first login.</p>`,
      text: `Email: ${agent.email}\nTemporary password: ${temporaryPassword}\n${downloadText}You will be required to change this password on first login.`,
    });
```

to:

```typescript
    const downloadUrl = this.configService.get<string>('AGENT_APP_DOWNLOAD_URL');

    await this.emailService.send({
      to: agent.email,
      ...agentCredentialsEmail({ fullName: agent.fullName, email: agent.email, temporaryPassword, downloadUrl }),
    });
```

- [ ] **Step 2: Run its spec to verify it still passes**

Run: `npx jest src/admin-agent-review/admin-agent-review.service.spec.ts`
Expected: PASS (all existing tests, no test changes needed — the "Reason:"/"Download the app"/URL-presence assertions are preserved by the template functions)

- [ ] **Step 3: Wire `admin-invite.controller.ts`**

Add the import near the other imports:

```typescript
import { adminInviteEmail, adminInviteResentEmail } from '../email/templates/token-emails';
```

Change the `create()` send from:

```typescript
    await this.emailService.send({
      to: dto.email,
      subject: 'You have been invited as an admin',
      html: `<p>You have been invited. Use this token to accept: ${token}</p>`,
      text: `You have been invited. Use this token to accept: ${token}`,
    });
```

to:

```typescript
    await this.emailService.send({ to: dto.email, ...adminInviteEmail({ token }) });
```

Change the `resend()` send from:

```typescript
    await this.emailService.send({
      to: invite.email,
      subject: 'Your admin invitation (resent)',
      html: `<p>Use this token to accept: ${token}</p>`,
      text: `Use this token to accept: ${token}`,
    });
```

to:

```typescript
    await this.emailService.send({ to: invite.email, ...adminInviteResentEmail({ token }) });
```

- [ ] **Step 4: Confirm no existing unit test needs updating**

Run: `find src/admin-invite -name "*.spec.ts"` — if a spec file exists, run it; the plan's research found none at `src/admin-invite/admin-invite.controller.spec.ts`, so this step may find nothing to run — in that case, confirm via `npx jest src/admin-invite` that no spec breaks (passes trivially with "No tests found" or runs any spec that does exist).

- [ ] **Step 5: Commit**

```bash
git add src/admin-agent-review/admin-agent-review.service.ts src/admin-invite/admin-invite.controller.ts
git commit -m "feat(admin-agent-review,admin-invite): wire emails to the new templates"
```

---

### Task 7: Wire agent-recruitment, otp, and loan-request services

**Files:**
- Modify: `src/agent-recruitment/agent-recruitment.service.ts`
- Modify: `src/otp/otp.service.ts`
- Modify: `src/loan-request/loan-request.service.ts`

**Interfaces:**
- Consumes: `agentRecruitmentVerificationCodeEmail`, `clientOtpCodeEmail` (Task 2); `loanRequestConfirmationEmail` (Task 4).

- [ ] **Step 1: Wire `agent-recruitment.service.ts`**

Add the import near the other imports:

```typescript
import { agentRecruitmentVerificationCodeEmail } from '../email/templates/verification-code-emails';
```

Change the `requestCode()` send from:

```typescript
    await this.emailService.send({
      to: email,
      subject: 'Your agent application verification code',
      html: `<p>Your verification code is: ${code}</p>`,
      text: `Your verification code is: ${code}`,
    });
```

to:

```typescript
    await this.emailService.send({
      to: email,
      ...agentRecruitmentVerificationCodeEmail({ code, ttlMinutes: EMAIL_CODE_TTL_MS / 60000 }),
    });
```

(`EMAIL_CODE_TTL_MS` is already the module-level constant `10 * 60 * 1000` defined at the top of this file — `/ 60000` converts it to minutes, i.e. `10`.)

- [ ] **Step 2: Run its spec to verify it still passes**

Run: `npx jest src/agent-recruitment/agent-recruitment.service.spec.ts`
Expected: PASS (all existing tests, no test changes needed)

- [ ] **Step 3: Wire `otp.service.ts`**

Add the import near the other imports:

```typescript
import { clientOtpCodeEmail } from '../email/templates/verification-code-emails';
```

Change `sendEmailCopy()` from:

```typescript
  private async sendEmailCopy(email: string, code: string): Promise<void> {
    const minutes = Math.round(this.ttlSeconds() / 60);
    try {
      await this.emailService?.send({
        to: email,
        subject: 'Your login code',
        html: `<p>Your verification code is <strong>${code}</strong>. It expires in ${minutes} minutes.</p>`,
        text: `Your verification code is ${code}. It expires in ${minutes} minutes.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`OTP email copy to ${email} failed: ${message}`);
    }
  }
```

to:

```typescript
  private async sendEmailCopy(email: string, code: string): Promise<void> {
    const ttlMinutes = Math.round(this.ttlSeconds() / 60);
    try {
      await this.emailService?.send({ to: email, ...clientOtpCodeEmail({ code, ttlMinutes }) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`OTP email copy to ${email} failed: ${message}`);
    }
  }
```

- [ ] **Step 4: Run its spec to verify it still passes**

Run: `npx jest src/otp/otp.service.spec.ts`
Expected: PASS (all existing tests, including the "verification code" substring assertion, no test changes needed)

- [ ] **Step 5: Wire `loan-request.service.ts`**

Add the import near the other imports:

```typescript
import { loanRequestConfirmationEmail } from '../email/templates/action-emails';
```

Change `sendEmailCopy()` from:

```typescript
  private async sendEmailCopy(email: string | null, message: string): Promise<void> {
    if (!email) return;
    try {
      await this.emailService?.send({
        to: email,
        subject: 'Confirm your loan request',
        html: `<p>${message}</p>`,
        text: message,
      });
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Loan-request confirmation email to ${email} failed: ${err}`);
    }
  }
```

to:

```typescript
  private async sendEmailCopy(email: string | null, amount: number, type: LoanRequestType): Promise<void> {
    if (!email) return;
    try {
      await this.emailService?.send({ to: email, ...loanRequestConfirmationEmail({ amount, type }) });
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Loan-request confirmation email to ${email} failed: ${err}`);
    }
  }
```

Update its 3 call sites. Change:

```typescript
    await this.smsProvider.send(client.phone, this.confirmationMessage(amount));
    await this.sendEmailCopy(client.email, this.confirmationMessage(amount));
```

(the first occurrence, inside `create()`) to:

```typescript
    await this.smsProvider.send(client.phone, this.confirmationMessage(amount));
    await this.sendEmailCopy(client.email, amount, LoanRequestType.ORIGINATION);
```

Change:

```typescript
    await this.smsProvider.send(client.phone, this.confirmationMessage(amount, LoanRequestType.TOPUP));
    await this.sendEmailCopy(client.email, this.confirmationMessage(amount, LoanRequestType.TOPUP));
```

(inside `createTopup()`) to:

```typescript
    await this.smsProvider.send(client.phone, this.confirmationMessage(amount, LoanRequestType.TOPUP));
    await this.sendEmailCopy(client.email, amount, LoanRequestType.TOPUP);
```

Change:

```typescript
    await this.smsProvider.send(client.phone, this.confirmationMessage(Number(loanRequest.amount)));
    await this.sendEmailCopy(client.email, this.confirmationMessage(Number(loanRequest.amount)));
```

(inside `resend()`) to:

```typescript
    await this.smsProvider.send(client.phone, this.confirmationMessage(Number(loanRequest.amount)));
    await this.sendEmailCopy(client.email, Number(loanRequest.amount), LoanRequestType.ORIGINATION);
```

(`resend()` only re-sends the original confirmation, never a topup one, matching `this.confirmationMessage(Number(loanRequest.amount))`'s own default-type call with no explicit type argument today.)

- [ ] **Step 6: Run its spec to verify it still passes**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: PASS (all existing tests, including the amount/"top-up" substring assertions, no test changes needed)

- [ ] **Step 7: Commit**

```bash
git add src/agent-recruitment/agent-recruitment.service.ts src/otp/otp.service.ts src/loan-request/loan-request.service.ts
git commit -m "feat(agent-recruitment,otp,loan-request): wire emails to the new templates"
```

---

### Task 8: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit test suite**

Run: `npx jest`
Expected: PASS — every spec touched in Tasks 5-7 passes unchanged, plus the 4 new template spec files.

- [ ] **Step 2: Relevant e2e suites**

Run: `npx jest --config ./test/jest-e2e.json admin-two-factor-auth agent-two-factor-auth agent-recruitment admin-agent-recruitment-review admin-password-self-service agent-password-self-service admin-invite`
Expected: PASS. Re-run any failing suite in isolation before treating it as a regression (known pre-existing DB-contention flakiness under concurrent load).

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit` — expect clean.
Run: `npx eslint "{src,apps,libs,test}/**/*.ts" --rule '{"prettier/prettier":"off"}'` (note: **without** `--fix`) — expect no new errors beyond the established pre-existing baseline.

- [ ] **Step 4: Visual sanity check via the console provider**

Run `npm run start:dev`, trigger one email (e.g. `POST /agents/recruitment/email/request-code` with a test email) with `EMAIL_PROVIDER` unset (defaults to console), and confirm the logged `text` output reads correctly end-to-end. A true visual check of the HTML layout requires pointing `EMAIL_PROVIDER=smtp` at a real inbox — out of scope for this automated verification step, per the spec's §9.

- [ ] **Step 5: Confirm no stray debug artifacts remain**

Run: `git status --short` — expect clean.
