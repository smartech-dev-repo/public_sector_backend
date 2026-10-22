// src/email/templates/token-emails.spec.ts
import { adminPasswordResetEmail, agentPasswordResetEmail, adminInviteEmail, adminInviteResentEmail } from './token-emails';

describe('adminPasswordResetEmail', () => {
  it('includes the exact phrase and token on one line in text', () => {
    const result = adminPasswordResetEmail({ token: 'abc123tok' });
    expect(result.subject).toBe('Reset your password');
    expect(result.text).toContain('reset your password: abc123tok');
    expect(result.html).toContain('abc123tok');
  });

  it('omits the reset button and link when no resetUrl is given (token only)', () => {
    const result = adminPasswordResetEmail({ token: 'abc123tok' });
    expect(result.text).not.toContain('Reset it here:');
    expect(result.html).not.toContain('Reset Password');
  });

  it('includes a clickable reset button and the link as plain text when resetUrl is given, alongside the token', () => {
    const result = adminPasswordResetEmail({
      token: 'abc123tok',
      resetUrl: 'https://admin.moneyfieldmfb.com/reset-password?token=abc123tok',
    });
    expect(result.text).toContain('Reset it here: https://admin.moneyfieldmfb.com/reset-password?token=abc123tok');
    expect(result.text).toContain('reset your password: abc123tok');
    expect(result.html).toContain('href="https://admin.moneyfieldmfb.com/reset-password?token=abc123tok"');
    expect(result.html).toContain('Reset Password');
    expect(result.html).toContain('copy and paste this link into your browser');
    expect(result.html).toContain('abc123tok');
  });

  it('shows the link as visible text in the HTML, not just inside the button href', () => {
    const result = adminPasswordResetEmail({
      token: 'abc123tok',
      resetUrl: 'https://admin.moneyfieldmfb.com/reset-password?token=abc123tok',
    });
    const htmlWithoutHrefs = result.html.replace(/href="[^"]*"/g, '');
    expect(htmlWithoutHrefs).toContain('https://admin.moneyfieldmfb.com/reset-password?token=abc123tok');
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

describe('adminPasswordResetEmail and agentPasswordResetEmail', () => {
  it('both open with a greeting and close with a sign-off', () => {
    const admin = adminPasswordResetEmail({ token: 'abc123tok' });
    const agent = agentPasswordResetEmail({ token: 'tok456', code: '998877' });
    for (const result of [admin, agent]) {
      expect(result.text).toContain('Hello,');
      expect(result.text).toContain('Warm regards,\nThe Moneyfield Team');
      expect(result.html).toContain('Warm regards');
    }
  });
});

describe('adminInviteEmail', () => {
  it('has a greeting and sign-off, and falls back to the token when no acceptUrl is given', () => {
    const result = adminInviteEmail({ token: 'invite-tok' });
    expect(result.subject).toBe("You've been invited to Moneyfield Admin");
    expect(result.text).toContain('Hello,');
    expect(result.text).toContain('Warm regards,\nThe Moneyfield Team');
    expect(result.text).toContain('invite-tok');
    expect(result.html).toContain('invite-tok');
  });

  it('omits the CTA button and token box when no acceptUrl is given (button only)', () => {
    const result = adminInviteEmail({ token: 'invite-tok' });
    expect(result.text).not.toContain('Accept your invitation here:');
    expect(result.html).not.toContain('Accept Invitation');
  });

  it('includes a clickable button and the link as plain text in a sentence when acceptUrl is given, with no separate token section', () => {
    const result = adminInviteEmail({ token: 'invite-tok', acceptUrl: 'https://admin.moneyfieldmfb.com/accept-invite?token=invite-tok' });
    expect(result.text).toContain('Accept your invitation here: https://admin.moneyfieldmfb.com/accept-invite?token=invite-tok');
    expect(result.html).toContain('href="https://admin.moneyfieldmfb.com/accept-invite?token=invite-tok"');
    expect(result.html).toContain('Accept Invitation');
    expect(result.html).toContain('copy and paste this link into your browser');
    // the link already carries the token — no separate "use this code" section when it's present
    expect(result.text).not.toContain('Use this invitation code');
    expect(result.text).toContain('Warm regards,\nThe Moneyfield Team');
  });

  it('shows the link as visible text in the HTML, not just inside the button href', () => {
    const result = adminInviteEmail({ token: 'invite-tok', acceptUrl: 'https://admin.moneyfieldmfb.com/accept-invite?token=invite-tok' });
    const htmlWithoutHrefs = result.html.replace(/href="[^"]*"/g, '');
    expect(htmlWithoutHrefs).toContain('https://admin.moneyfieldmfb.com/accept-invite?token=invite-tok');
  });
});

describe('adminInviteResentEmail', () => {
  it('has a greeting, acknowledges the resend, and falls back to the token when no acceptUrl is given', () => {
    const result = adminInviteResentEmail({ token: 'invite-tok-2' });
    expect(result.subject).toBe('Your admin invitation (resent)');
    expect(result.text).toContain('Hello,');
    expect(result.text).toContain('As requested');
    expect(result.text).toContain('invite-tok-2');
  });

  it('includes a clickable button and the link in a sentence when acceptUrl is given', () => {
    const result = adminInviteResentEmail({ token: 'invite-tok-2', acceptUrl: 'https://admin.moneyfieldmfb.com/accept-invite?token=invite-tok-2' });
    expect(result.text).toContain('Accept your invitation here: https://admin.moneyfieldmfb.com/accept-invite?token=invite-tok-2');
    expect(result.html).toContain('Accept Invitation');
  });
});
