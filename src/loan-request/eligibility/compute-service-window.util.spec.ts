// src/loan-request/eligibility/compute-service-window.util.spec.ts
import { computeServiceWindow } from './compute-service-window.util';

describe('computeServiceWindow', () => {
  it('uses whichever retirement date (age-based or service-based) is earlier when both are present', () => {
    const now = new Date();
    const dateOfBirth = new Date(now.getFullYear() - 59, now.getMonth(), now.getDate());
    const hireDate = new Date(now.getFullYear() - 34, now.getMonth(), now.getDate());
    const result = computeServiceWindow(dateOfBirth, hireDate, 60, 35);
    expect(result.monthsLeft).toBe(12);
    expect(result.monthsServed).toBe(34 * 12);
  });

  it('uses the age-based retirement date alone when only dateOfBirth is on file', () => {
    const now = new Date();
    const dateOfBirth = new Date(now.getFullYear() - 59, now.getMonth(), now.getDate());
    const result = computeServiceWindow(dateOfBirth, null, 60, 35);
    expect(result.monthsLeft).toBe(12);
    expect(result.monthsServed).toBeNull();
  });

  it('uses the service-based retirement date alone when only hireDate is on file', () => {
    const now = new Date();
    const hireDate = new Date(now.getFullYear() - 34, now.getMonth(), now.getDate());
    const result = computeServiceWindow(null, hireDate, 60, 35);
    expect(result.monthsLeft).toBe(12);
    expect(result.monthsServed).toBe(34 * 12);
  });

  it('returns both fields null when neither date is on file', () => {
    const result = computeServiceWindow(null, null, 60, 35);
    expect(result.monthsLeft).toBeNull();
    expect(result.monthsServed).toBeNull();
  });
});
