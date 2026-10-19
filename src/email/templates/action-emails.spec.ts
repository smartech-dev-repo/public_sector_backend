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

  it('shows email and password together in one credentials block', () => {
    const result = agentCredentialsEmail({ fullName: 'Jane Doe', email: 'jane@example.com', temporaryPassword: 'temp123' });
    expect(result.text).toContain('Email: jane@example.com');
    expect(result.text).toContain('Password: temp123');
    expect(result.html).toContain('jane@example.com');
    expect(result.html).toContain('temp123');
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
