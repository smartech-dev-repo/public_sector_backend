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

  it('omits the CTA link/button when no acceptUrl is given', () => {
    const result = adminInviteEmail({ token: 'invite-tok' });
    expect(result.text).not.toContain('Accept your invitation:');
    expect(result.html).not.toContain('Accept Invitation');
  });

  it('includes a clickable CTA link/button when acceptUrl is given', () => {
    const result = adminInviteEmail({ token: 'invite-tok', acceptUrl: 'https://admin.moneyfieldmfb.com/accept-invite?token=invite-tok' });
    expect(result.text).toContain('Accept your invitation: https://admin.moneyfieldmfb.com/accept-invite?token=invite-tok');
    expect(result.html).toContain('href="https://admin.moneyfieldmfb.com/accept-invite?token=invite-tok"');
    expect(result.html).toContain('Accept Invitation');
    // the token fallback must still be present and copiable alongside the link
    expect(result.text).toContain('accept: invite-tok');
  });
});

describe('adminInviteResentEmail', () => {
  it('includes the exact phrase and token on one line in text', () => {
    const result = adminInviteResentEmail({ token: 'invite-tok-2' });
    expect(result.subject).toBe('Your admin invitation (resent)');
    expect(result.text).toContain('accept: invite-tok-2');
  });

  it('includes a clickable CTA link/button when acceptUrl is given', () => {
    const result = adminInviteResentEmail({ token: 'invite-tok-2', acceptUrl: 'https://admin.moneyfieldmfb.com/accept-invite?token=invite-tok-2' });
    expect(result.text).toContain('Accept your invitation: https://admin.moneyfieldmfb.com/accept-invite?token=invite-tok-2');
    expect(result.html).toContain('Accept Invitation');
  });
});
