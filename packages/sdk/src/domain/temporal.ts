import { HistoryError } from './errors.js';

export function canonicalDate(value: string): string {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (!match)
    throw new HistoryError(
      'INVALID_VALUE',
      'Dates must use YYYY-MM-DD within years 0001–9999.',
    );
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days =
    [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ??
    0;
  if (!year || day < 1 || day > days)
    throw new HistoryError('INVALID_VALUE', 'Invalid calendar date.');
  return value;
}

export function canonicalTimestamp(value: string, timezone: boolean): string {
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|\+00(?::00)?)?$/.exec(
      value,
    );
  if (
    !match ||
    !match[1] ||
    Boolean(match[6]) !== timezone ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59
  )
    throw new HistoryError(
      'INVALID_VALUE',
      'Expected a finite microsecond timestamp; timezone values must be normalized to UTC.',
    );
  canonicalDate(match[1]);
  return `${match[1]} ${match[2]}:${match[3]}:${match[4]}.${(match[5] ?? '').padEnd(6, '0')}${timezone ? 'Z' : ''}`;
}
