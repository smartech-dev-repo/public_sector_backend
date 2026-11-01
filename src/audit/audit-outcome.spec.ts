import { describeOutcome, errorReason } from './audit-outcome';

describe('describeOutcome', () => {
  it.each([
    ['role.created', null, 'success', null],
    ['POST /admin/roles (200)', null, 'success', null],
    ['admin.login.failed', { reason: 'wrong_password' }, 'failed', 'Wrong password'],
    ['admin.login.denied', { reason: 'inactive_account' }, 'blocked', 'Account is deactivated'],
    ['agent.client_access.denied', {}, 'blocked', 'Client belongs to another agent'],
    ['access.denied', { error: 'Insufficient permissions' }, 'blocked', 'Insufficient permissions'],
    ['PATCH /admin/roles/1 (409)', { error: 'A role named "X" already exists' }, 'failed', 'A role named "X" already exists'],
    ['PATCH /admin/roles/1 (409)', null, 'failed', 'Conflicted with existing data'],
    ['POST /admin/roles (403)', null, 'blocked', 'Did not have permission'],
    ['POST /admin/x (500)', null, 'failed', 'Server error'],
    ['loan-request.created.failed', { status: 422 }, 'failed', 'Could not be processed'],
    ['admin.password.change_failed', null, 'failed', 'Wrong current password'],
    ['session.reuse_detected', null, 'blocked', 'An old sign-in token was reused'],
  ])('%s', (action, metadata, outcome, reason) => {
    expect(describeOutcome(action, metadata)).toEqual({ outcome, reason });
  });
});

describe('errorReason', () => {
  it('joins validation messages', () => {
    expect(errorReason({ status: 400, response: { message: ['a is bad', 'b is bad'] } })).toBe('a is bad; b is bad');
  });

  it('never exposes the text of a server error', () => {
    expect(errorReason({ status: 500, message: 'connection string leaked' })).toBeUndefined();
    expect(errorReason(new Error('no status'))).toBeUndefined();
  });
});
