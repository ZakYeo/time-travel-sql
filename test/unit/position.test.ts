import { describe, expect, it } from 'vitest';
import {
  comparePositions,
  decodePosition,
  HistoryError,
} from '../../packages/sdk/src/index.js';

describe('canonical source positions', () => {
  it('orders exact offsets beyond Number precision', () => {
    expect(
      comparePositions(
        decodePosition('9007199254740993'),
        decodePosition('9007199254740992'),
      ),
    ).toBe(1);
    expect(comparePositions(decodePosition('9'), decodePosition('10'))).toBe(
      -1,
    );
    expect(comparePositions(decodePosition('0'), decodePosition('0'))).toBe(0);
  });

  it.each(['', '01', '-1', '1.5', '1e3', ' 1', 1, null, '1'.repeat(41)])(
    'rejects noncanonical or unbounded offset %j',
    (input) => {
      expect(() => decodePosition(input)).toThrow(HistoryError);
    },
  );
});
