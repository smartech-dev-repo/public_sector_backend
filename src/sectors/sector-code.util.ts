// A sheet still named after an old code lands on the current one.
const SECTOR_ALIASES: Record<string, string> = { CUSTOM: 'CUSTOMS' };

const MAX_TYPO_DISTANCE = 2;

/** One spelling per sector, however a sheet name is typed: " lagos  state " is "LAGOS STATE". */
export function normalizeSectorCode(raw: string): string {
  const code = raw.trim().replace(/\s+/g, ' ').toUpperCase();
  return SECTOR_ALIASES[code] ?? code;
}

// Names a spreadsheet gets by default or for housekeeping, which say nothing about a sector.
const GENERIC_SHEET_NAME = /^(SHEET|TABLE|DATA|EXPORT|REPORT|SUMMARY|TEMPLATE|NOTES?|INSTRUCTIONS?|COPY)( ?\(?\d+\)?)?$/;

/** Whether a sheet's name could be a sector, rather than Excel's "Sheet1" or similar. */
export function canBeSectorName(raw: string): boolean {
  const code = normalizeSectorCode(raw);
  return code.length > 0 && !GENERIC_SHEET_NAME.test(code);
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}

/** The existing sector a new name is probably a typo of, if any. */
export function closestSector(code: string, existing: string[]): string | null {
  // Short codes differ by a letter or two anyway, so a distance of 2 would flag LASG as NPF.
  const tolerance = code.length <= 4 ? 1 : MAX_TYPO_DISTANCE;
  const letters = (value: string) => [...value].sort().join('');
  // Swapped letters count as two edits, so NFP needs its own check against NPF.
  return existing.find((known) => letters(known) === letters(code) || editDistance(code, known) <= tolerance) ?? null;
}
