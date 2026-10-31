import { randomBytes } from 'crypto';
import { extname, parse } from 'path';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const LAGOS_UTC_OFFSET_MS = 60 * 60 * 1000;
const MAX_SLUG_LENGTH = 60;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

// e.g. "ippis-oct-final_31-oct-2026_22-15-07_9f3a1c.xlsx" -- readable in a bucket
// listing, and the random suffix keeps two uploads in the same second distinct.
// The original name is reduced to [a-z0-9-] so it can never add a path segment
// to the storage key.
export function buildStoredFileName(originalName: string, now: Date = new Date()): string {
  const slug = parse(originalName)
    .name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');

  const lagos = new Date(now.getTime() + LAGOS_UTC_OFFSET_MS);
  const date = `${pad(lagos.getUTCDate())}-${MONTHS[lagos.getUTCMonth()]}-${lagos.getUTCFullYear()}`;
  const time = `${pad(lagos.getUTCHours())}-${pad(lagos.getUTCMinutes())}-${pad(lagos.getUTCSeconds())}`;
  const suffix = randomBytes(3).toString('hex');

  return `${slug || 'upload'}_${date}_${time}_${suffix}${extname(originalName).toLowerCase()}`;
}
