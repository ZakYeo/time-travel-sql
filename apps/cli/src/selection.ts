import { decodePosition } from '@time-travel-sql/sdk';
import type { Selection } from '@time-travel-sql/sdk';
import { UsageError } from './arguments.js';

export function selection(value: string): Selection {
  if (value === 'baseline') return { kind: 'baseline' };
  const match = /^(before|after):([0-9]+)$/.exec(value);
  if (!match || (match[1] !== 'before' && match[1] !== 'after'))
    throw new UsageError('Select baseline, before:POSITION or after:POSITION.');
  return { kind: match[1], position: decodePosition(match[2]) };
}
