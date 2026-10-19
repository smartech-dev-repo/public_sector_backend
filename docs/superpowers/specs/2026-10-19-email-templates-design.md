# Email Templates Design

## 1. Purpose

Every email this app sends today is a bare, inline-built `<p>...</p>` string
constructed separately at each of 13 call sites, with no shared layout, no
branding, no colors, and no consistent tone — e.g. `` `<p>Your verification
code is: ${code}</p>` `` is the entire body of 6 different emails across
admin/agent/client flows. This replaces all 13 with a shared branded layout
(Moneyfield Microfinance Bank Limited's logo/colors) and proper, warm,
context-appropriate copy for each, without introducing a templating
dependency or changing the existing `EmailService`/`EmailProvider`
interfaces.

## 2. Architecture

A new `src/email/templates/` directory holds:

- `layout.ts` — the shared branded shell. Exports `wrapEmailLayout({
  headline, bodyHtml }): string` (HTML) and `wrapEmailLayoutText({
  headline, bodyText }): string` (plain-text equivalent — same content,
  no markup, so every template still produces a sensible `text` fallback).
  Also exports a shared `highlightBox(value: string): string` HTML helper
  (the bordered, monospace, light-green-tinted box used for both
  verification codes and opaque tokens).
- `verification-code-emails.ts` — 4 functions, one per verification-code
  email.
- `token-emails.ts` — 4 functions, one per token/invite email.
- `action-emails.ts` — 3 functions, one per action/credential email.

Each exported function has the signature `(params): { subject: string;
html: string; text: string }` — i.e. everything `EmailMessage` needs
except `to`. A call site changes from building its own object to:

```typescript
await this.emailService.send({ to: agent.email, ...twoFactorSetupCodeEmail({ code, ttlMinutes: 10 }) });
```

No change to `EmailMessage`, `EmailProvider`, `EmailService`, or any of
the 3 provider implementations (console/SMTP/SendGrid) — they keep
receiving the same `{ to, subject, html, text }` shape they do today.

## 3. Brand

- Logo: hosted at `https://res.cloudinary.com/dwfedg8uv/image/upload/f_auto,q_auto:best/moneyfield-logo_vcfhhn` (already live on Cloudinary — no upload step needed). Referenced via a new env var `EMAIL_LOGO_URL` (so it's swappable without a code change), defaulting to that URL in `.env.example`.
- Company name in the footer reuses the existing `EMAIL_FROM_NAME` env var (already the semantic "display name of the sender") rather than introducing a second company-name setting.
- RC number ("RC: 903524") is a fixed legal registration number, hardcoded as a constant in `layout.ts` — not environment-specific configuration.
- Support contact is a new env var `SUPPORT_EMAIL`, defaulting to the placeholder `support@moneyfieldmfb.com` in `.env.example` — swappable later by just changing the env var, no code change.
- Palette (hardcoded constants in `layout.ts`, not configurable — these are the actual Moneyfield brand colors): primary deep green `#2B6830`, secondary leaf green `#7AC142`, olive-gold `#96874A`, body text `#2D2D2D`, page background `#F4F6F4`, content card `#FFFFFF`.

## 4. Layout shell (exact structure)

Single centered 600px-wide HTML table (the standard email-safe layout
pattern — renders consistently across Gmail/Outlook/Apple Mail, which
strip `<style>` blocks and modern CSS, so everything is inline `style=`
attributes on table-based markup, no flexbox/grid):

1. **Outer wrapper**: `background-color: #F4F6F4`, full width, centers
   the 600px table.
2. **Header row**: white background, the logo `<img>` (from
   `EMAIL_LOGO_URL`) centered, `max-width: 240px`, with a 2px solid
   `#7AC142` border on its bottom edge as the divider.
3. **Body row**: white background, 32px padding. Headline in `#2B6830`,
   `font-size: 20px`, `font-weight: 600`. Body copy in `#2D2D2D`,
   `font-size: 15px`, `line-height: 1.6`. Any code/token rendered via
   `highlightBox()`: `background-color: #EAF5EA`, `border: 2px solid
   #2B6830`, `border-radius: 6px`, `font-family: monospace`,
   `font-size: 22px`, `font-weight: 700`, centered, letter-spacing for
   codes.
4. **Footer row**: `background-color: #F4F6F4`, 24px padding, centered,
   `font-size: 12px`, color `#6B6B6B`. Three lines: `{EMAIL_FROM_NAME}`
   in `#96874A`, `RC: 903524`, and `Need help? Contact {SUPPORT_EMAIL}`.

`wrapEmailLayoutText()` produces the plain-text equivalent: headline,
blank line, body text (already plain since each template's `bodyText`
param is itself plain), blank line, `—`, footer lines without HTML.

## 5. The 11 templates (exact copy)

Each template function takes a typed params object and returns
`{ subject, html, text }` by calling `wrapEmailLayout`/
`wrapEmailLayoutText` with its own headline + body, and `highlightBox()`
for any code/token.

**Important constraint found during self-review**: 7 existing e2e specs
extract a code/token out of a captured email by regex-matching the
*exact old phrase* immediately before the value in `text` (e.g.
`/verification code is: (\d+)/`, `/reset your password: (\S+)/`,
`/accept: (\S+)/` — see `test/admin-two-factor-auth.e2e-spec.ts`,
`agent-two-factor-auth.e2e-spec.ts`, `agent-recruitment.e2e-spec.ts`,
`admin-agent-recruitment-review.e2e-spec.ts`,
`admin-password-self-service.e2e-spec.ts`,
`agent-password-self-service.e2e-spec.ts`, `admin-invite.e2e-spec.ts`).
Rather than rewrite 7 test files' regexes (and accept the risk of a
looser regex false-matching other digits in the email, e.g. the
footer's "RC: 903524"), the 6 templates those 7 specs exercise
(`twoFactorSetupCodeEmail`, `loginVerificationCodeEmail`,
`agentRecruitmentVerificationCodeEmail`, `adminPasswordResetEmail`,
`agentPasswordResetEmail`, `adminInviteEmail` — `adminInviteResentEmail`
is kept consistent with it too, as a 7th, though no current test
exercises the resend path's body) keep the value inline on the same
line immediately after the original exact phrase, byte-for-byte, in
`text` — only `html` uses the nicer boxed/multi-line layout. Confirmed
by direct grep against every `test/*.e2e-spec.ts` file for `.match(`
calls against a captured email body: no test parses `clientOtpCodeEmail`,
`agentApplicationRejectedEmail`, `agentCredentialsEmail`, or
`loanRequestConfirmationEmail`'s body content at all, so those 4 are
free to read however reads best with no exact-phrase constraint.

### `verification-code-emails.ts`

```typescript
export function twoFactorSetupCodeEmail(params: { code: string; ttlMinutes: number }): { subject: string; html: string; text: string } {
  // "Your verification code is: " must stay immediately before the code,
  // on one line, in `text` — test/admin-two-factor-auth.e2e-spec.ts and
  // agent-two-factor-auth.e2e-spec.ts regex-match this exact phrase.
  const bodyText = `You're enabling email-based two-factor authentication on your account.\n\nYour verification code is: ${params.code}\n\nThis code expires in ${params.ttlMinutes} minutes. If you didn't request this, you can safely ignore this email.`;
  const bodyHtml = `<p>You're enabling email-based two-factor authentication on your account.</p><p>Your verification code is:</p>${highlightBox(params.code)}<p>This code expires in ${params.ttlMinutes} minutes. If you didn't request this, you can safely ignore this email.</p>`;
  return {
    subject: 'Your two-factor setup code',
    html: wrapEmailLayout({ headline: 'Set up two-factor authentication', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Set up two-factor authentication', bodyText }),
  };
}

export function loginVerificationCodeEmail(params: { code: string; ttlMinutes: number }): { subject: string; html: string; text: string } {
  // Same "Your verification code is: " constraint as above — both
  // e2e two-factor-auth specs test the setup code AND the login code
  // with the identical regex.
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
  // and admin-agent-recruitment-review.e2e-spec.ts both regex-match it.
  const bodyText = `Thanks for starting your agent application with Moneyfield Microfinance Bank.\n\nYour verification code is: ${params.code}\n\nThis code expires in ${params.ttlMinutes} minutes.`;
  const bodyHtml = `<p>Thanks for starting your agent application with Moneyfield Microfinance Bank.</p><p>Your verification code is:</p>${highlightBox(params.code)}<p>This code expires in ${params.ttlMinutes} minutes.</p>`;
  return {
    subject: 'Verify your email to continue your application',
    html: wrapEmailLayout({ headline: 'Verify your email', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Verify your email', bodyText }),
  };
}

export function clientOtpCodeEmail(params: { code: string; ttlMinutes: number }): { subject: string; html: string; text: string } {
  // No e2e test parses this body (confirmed by grep) — free to word
  // however reads best, no exact-phrase constraint.
  const bodyText = `Use this code to log in to your Moneyfield account:\n\n${params.code}\n\nThis code expires in ${params.ttlMinutes} minutes. This is a backup copy — you should also have received it by SMS.`;
  const bodyHtml = `<p>Use this code to log in to your Moneyfield account:</p>${highlightBox(params.code)}<p>This code expires in ${params.ttlMinutes} minutes. This is a backup copy — you should also have received it by SMS.</p>`;
  return {
    subject: 'Your login code',
    html: wrapEmailLayout({ headline: 'Your one-time login code', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Your one-time login code', bodyText }),
  };
}
```

### `token-emails.ts`

```typescript
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
  // test/agent-password-self-service.e2e-spec.ts regex-matches both.
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
  // Same "accept: " constraint as adminInviteEmail, kept consistent even
  // though no current test exercises the resend path's email body.
  const bodyText = `You've been invited to join Moneyfield Microfinance Bank's admin team.\n\nUse this token to accept: ${params.token}`;
  const bodyHtml = `<p>You've been invited to join Moneyfield Microfinance Bank's admin team. Use this token to accept your invitation and set up your account:</p>${highlightBox(params.token)}`;
  return {
    subject: 'Your admin invitation (resent)',
    html: wrapEmailLayout({ headline: 'Your invitation, resent', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Your invitation, resent', bodyText }),
  };
}
```

Note: `invite.expiresAt` is actually already available at both call sites
(`AdminInviteController.create`/`.resend` both destructure `{ invite,
token }`) — this spec deliberately still doesn't thread it into the
email, to keep this plan scoped to "better copy for existing data," not
"add new data to emails." The original catalogued copy's "This
invitation expires in {ttl}" idea is dropped for that reason, not
because the value is unavailable.

### `action-emails.ts`

```typescript
export function agentApplicationRejectedEmail(params: { fullName: string; reason: string }): { subject: string; html: string; text: string } {
  const bodyText = `Hi ${params.fullName}, thank you for applying to become a Moneyfield agent. After review, we're unable to approve your application at this time.\n\nReason: ${params.reason}\n\nIf you believe this was a mistake or have questions, please contact support.`;
  const bodyHtml = `<p>Hi ${params.fullName}, thank you for applying to become a Moneyfield agent. After review, we're unable to approve your application at this time.</p><p><strong>Reason:</strong> ${params.reason}</p><p>If you believe this was a mistake or have questions, please contact support.</p>`;
  return {
    subject: 'An update on your agent application',
    html: wrapEmailLayout({ headline: 'Application update', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Application update', bodyText }),
  };
}

export function agentCredentialsEmail(params: { fullName: string; email: string; temporaryPassword: string; downloadUrl?: string }): { subject: string; html: string; text: string } {
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

export function loanRequestConfirmationEmail(params: { amount: string; type: 'ORIGINATION' | 'TOPUP' }): { subject: string; html: string; text: string } {
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

## 6. Call-site changes (all 13, mapped to the 11 templates)

| # | File | Change |
|---|---|---|
| 1 | `admin-auth.service.ts:107` (forgotPassword) | → `adminPasswordResetEmail({ token })` |
| 2 | `admin-auth.service.ts:178` (setupTwoFactor EMAIL) | → `twoFactorSetupCodeEmail({ code, ttlMinutes: 10 })` |
| 3 | `admin-auth.service.ts:271` (beginTwoFactorLogin) | → `loginVerificationCodeEmail({ code, ttlMinutes: 10 })` |
| 4 | `agent-auth.service.ts:94` (forgotPassword) | → `agentPasswordResetEmail({ token, code })` |
| 5 | `agent-auth.service.ts:182` (setupTwoFactor EMAIL) | → `twoFactorSetupCodeEmail({ code, ttlMinutes: 10 })` |
| 6 | `agent-auth.service.ts:275` (beginTwoFactorLogin) | → `loginVerificationCodeEmail({ code, ttlMinutes: 10 })` |
| 7 | `admin-agent-review.service.ts:106` (reject) | → `agentApplicationRejectedEmail({ fullName: agent.fullName, reason })` |
| 8 | `admin-agent-review.service.ts:158` (issueCredentials) | → `agentCredentialsEmail({ fullName: agent.fullName, email: agent.email, temporaryPassword, downloadUrl })` |
| 9 | `admin-invite.controller.ts:33` (create) | → `adminInviteEmail({ token })` |
| 10 | `admin-invite.controller.ts:63` (resend) | → `adminInviteResentEmail({ token })` |
| 11 | `agent-recruitment.service.ts:62` (requestCode) | → `agentRecruitmentVerificationCodeEmail({ code, ttlMinutes: EMAIL_CODE_TTL_MS / 60000 })` |
| 12 | `otp.service.ts:81` (sendEmailCopy) | → `clientOtpCodeEmail({ code, ttlMinutes: Math.round(ttlSeconds() / 60) })` |
| 13 | `loan-request.service.ts:70` (sendEmailCopy) | → `loanRequestConfirmationEmail({ amount, type })` — note: this changes the email's *content* from an exact copy of the SMS text to its own proper copy (per the approved design), so this call site stops reusing the SMS `confirmationMessage(...)` string for the email and instead passes `{ amount, type }` directly. |

`ttlMinutes: 10` for the two shared 2FA templates (#2/#3/#5/#6) is
hardcoded in the plan since `TWO_FACTOR_EMAIL_CODE_TTL_MS` is already a
fixed 10-minute constant in both services today — no behavior change,
just making the already-fixed number explicit at the call site instead
of re-deriving it.

## 7. Config additions

`.env.example`:
```
EMAIL_LOGO_URL=https://res.cloudinary.com/dwfedg8uv/image/upload/f_auto,q_auto:best/moneyfield-logo_vcfhhn
SUPPORT_EMAIL=support@moneyfieldmfb.com
```

## 8. Testing

- Unit: one test per template function asserting `subject` is exact,
  and that `html`/`text` both contain every interpolated value (code,
  token, reason, amount, etc.) — not snapshot tests of the full HTML
  (too brittle), just presence/correctness assertions on the dynamic
  parts.
- Unit: `wrapEmailLayout`/`wrapEmailLayoutText`/`highlightBox` each get
  their own direct tests (contains the logo URL from config, contains
  the headline, contains the body, contains the footer's RC number and
  support email).
- Existing unit tests at each of the 13 call sites that currently assert
  on the literal `emailService.send` call arguments (several already do,
  per the earlier Agent Recruitment/Admin Agent Review work this
  session) get updated to assert against the new template function's
  output shape instead of a raw inline string.
- No e2e test file needs to change. 6 of the 11 templates deliberately
  keep the exact old phrase-adjacent-to-value substring in `text` (see
  the per-function comments in §5) specifically so every existing
  `EMAIL_PROVIDERS`-capturing e2e spec's regex (`/verification code is:
  (\d+)/`, `/reset your password: (\S+)/`, `/enter this code: (\d+)/`,
  `/accept: (\S+)/`) keeps matching unchanged. This was verified by
  grepping every `test/*.e2e-spec.ts` file for `.match(` calls against a
  captured email body and cross-checking each against its template's
  `text` output.

## 9. Out of scope

- No new templating library/dependency.
- No change to `EmailMessage`/`EmailProvider`/`EmailService` interfaces.
- No attachments, inline images beyond the logo, or a real "reply-to"
  address.
- No admin invite expiry value threaded into the invite emails (not
  available at that call site today — see §5 note).
- No unsubscribe link (these are all transactional, not marketing,
  emails).
- No visual preview/screenshot tooling — review happens via the actual
  rendered email in a real client (console provider logs are
  text-only, so a true visual check needs the SMTP/SendGrid provider
  pointed at a real inbox).
