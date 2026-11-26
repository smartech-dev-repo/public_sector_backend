/**
 * Picks the salary to lend against from the last three monthly payments (oldest first).
 *
 * Each month is given a letter by how its pay ranks against the other two: A is the
 * lowest level, B the next, C the highest. Months that differ by less than ₦1 are the
 * same level, so kobo never changes the pattern.
 *
 * Only 13 patterns can occur. "A A C" and "B B C" both mean "two equal lower months, then
 * a higher one", which is "A A B" here: with only two levels there is no C. The admin sets
 * an outcome for each of the 13 from the back office.
 */

export const SALARY_PATTERNS = [
  'AAA',
  'AAB',
  'ABA',
  'ABB',
  'BAA',
  'BAB',
  'BBA',
  'ABC',
  'ACB',
  'BAC',
  'BCA',
  'CAB',
  'CBA',
] as const;
export type SalaryPattern = (typeof SALARY_PATTERNS)[number];

export const SALARY_OUTCOMES = [
  'A',
  'B',
  'C',
  'AVG_AB',
  'AVG_AC',
  'AVG_BC',
  'AVG_ABC',
] as const;
export type SalaryOutcome = (typeof SALARY_OUTCOMES)[number];

export type SalaryPatternOutcomes = Record<SalaryPattern, SalaryOutcome>;

/**
 * The model the business supplied, with ABC and ACB set to B (confirmed 2026-11-03): pay
 * that rose after the first month and stayed at or above a level in both later months
 * counts at that level; any other pattern uses the lowest month.
 */
export const DEFAULT_SALARY_PATTERN_OUTCOMES: SalaryPatternOutcomes = {
  AAA: 'A',
  AAB: 'A',
  ABA: 'A',
  ABB: 'B',
  BAA: 'A',
  BAB: 'A',
  BBA: 'A',
  ABC: 'B',
  ACB: 'B',
  BAC: 'A',
  BCA: 'A',
  CAB: 'A',
  CBA: 'A',
};

/** The other ways the business wrote each pattern in its 27-row table. */
export const SALARY_PATTERN_ALIASES: Record<SalaryPattern, string[]> = {
  AAA: ['BBB', 'CCC'],
  AAB: ['AAC', 'BBC'],
  ABA: ['ACA', 'BCB'],
  ABB: ['ACC', 'BCC'],
  BAA: ['CAA', 'CBB'],
  BAB: ['CAC', 'CBC'],
  BBA: ['CCA', 'CCB'],
  ABC: [],
  ACB: [],
  BAC: [],
  BCA: [],
  CAB: [],
  CBA: [],
};

/** Months whose pay differs by less than this are treated as equal. */
export const EQUAL_PAY_TOLERANCE = 1;

const LETTERS = ['A', 'B', 'C'] as const;

/** Which letters a pattern uses, so an outcome can be checked against it. */
export function lettersIn(pattern: SalaryPattern): string[] {
  return LETTERS.filter((letter) => pattern.includes(letter));
}

/** Outcomes that only use letters the pattern has. "AAA" can only be A. */
export function allowedOutcomes(pattern: SalaryPattern): SalaryOutcome[] {
  const letters = lettersIn(pattern);
  return SALARY_OUTCOMES.filter((outcome) => {
    const used = outcome.startsWith('AVG_')
      ? outcome.slice(4).split('')
      : [outcome];
    if (outcome.startsWith('AVG_') && letters.length < 2) return false;
    return used.every((letter) => letters.includes(letter as 'A'));
  });
}

/** Merges stored outcomes over the defaults, ignoring anything a pattern can't use. */
export function resolveOutcomes(stored: unknown): SalaryPatternOutcomes {
  const merged = { ...DEFAULT_SALARY_PATTERN_OUTCOMES };
  if (stored && typeof stored === 'object') {
    for (const pattern of SALARY_PATTERNS) {
      const value = (stored as Record<string, unknown>)[pattern];
      if (
        typeof value === 'string' &&
        allowedOutcomes(pattern).includes(value as SalaryOutcome)
      ) {
        merged[pattern] = value as SalaryOutcome;
      }
    }
  }
  return merged;
}

export interface SalaryPick {
  pattern: SalaryPattern;
  outcome: SalaryOutcome;
  /** The pay for each level, lowest first. Equal months share the lowest of their amounts. */
  levels: Partial<Record<'A' | 'B' | 'C', number>>;
  salary: number;
}

/**
 * Returns null when a month is missing or zero: the salary history is incomplete,
 * and the client can't be assessed.
 */
export function pickSalary(
  payments: [number | null, number | null, number | null],
  outcomes: SalaryPatternOutcomes = DEFAULT_SALARY_PATTERN_OUTCOMES,
): SalaryPick | null {
  if (
    payments.some(
      (amount) => amount === null || !Number.isFinite(amount) || amount <= 0,
    )
  )
    return null;
  const months = payments as [number, number, number];

  // Group into levels, lowest first: a month joins the level below when within the tolerance.
  const sorted = [...months].sort((a, b) => a - b);
  const levelFloors: number[] = [];
  for (const amount of sorted) {
    const last = levelFloors[levelFloors.length - 1];
    if (last === undefined || amount - last >= EQUAL_PAY_TOLERANCE)
      levelFloors.push(amount);
  }
  const levelOf = (amount: number): number => {
    for (let i = levelFloors.length - 1; i >= 0; i -= 1) {
      if (amount >= levelFloors[i]) return i;
    }
    return 0;
  };

  const pattern = months
    .map((amount) => LETTERS[levelOf(amount)])
    .join('') as SalaryPattern;
  const levels: SalaryPick['levels'] = {};
  levelFloors.forEach((amount, i) => (levels[LETTERS[i]] = amount));

  const outcome = outcomes[pattern] ?? DEFAULT_SALARY_PATTERN_OUTCOMES[pattern];
  const used = outcome.startsWith('AVG_')
    ? outcome.slice(4).split('')
    : [outcome];
  const values = used
    .map((letter) => levels[letter as 'A'])
    .filter((v): v is number => v !== undefined);
  const salary = values.length
    ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) /
      100
    : levelFloors[0];

  return { pattern, outcome, levels, salary };
}
