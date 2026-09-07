import { HistoryError } from './errors.js';

declare const positionBrand: unique symbol;
export type Position = string & { readonly [positionBrand]: true };

/** Canonical unsigned offset; adapters translate their native source positions. */
export function decodePosition(input: unknown): Position {
  if (typeof input !== 'string' || !/^(0|[1-9][0-9]{0,39})$/.test(input)) {
    throw new HistoryError(
      'INVALID_POSITION',
      'Expected a canonical unsigned source position (up to 40 digits).',
    );
  }
  return input as Position;
}

export function comparePositions(left: Position, right: Position): -1 | 0 | 1 {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
