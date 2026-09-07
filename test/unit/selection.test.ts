import { expect, it } from 'vitest';
import {
  decodeRecordingInfo,
  decodeSelection,
  selectedPosition,
} from '@time-travel-sql/sdk';
import { metadata, transaction } from '../../test-support/storage-fixture.js';

const info = decodeRecordingInfo({
  ...metadata,
  status: 'recording',
  baselinePosition: '0',
  headPosition: '20',
  baselineRowCount: 0,
  baselineChecksum: 'a'.repeat(64),
  transactionCount: 2,
});

it('selects the baseline or a complete commit and its recorded predecessor', () => {
  expect(selectedPosition(info, decodeSelection({ kind: 'baseline' }))).toBe(
    '0',
  );
  expect(
    selectedPosition(
      info,
      decodeSelection({ kind: 'before', position: '20' }),
      transaction('20', '10', '2'),
    ),
  ).toBe('10');
  expect(
    selectedPosition(
      info,
      decodeSelection({ kind: 'after', position: '20' }),
      transaction('20', '10', '2'),
    ),
  ).toBe('20');
});

it('rejects absent, mismatched and out-of-coverage transactions', () => {
  expect(() =>
    selectedPosition(info, decodeSelection({ kind: 'before', position: '10' })),
  ).toThrow();
  expect(() =>
    selectedPosition(
      info,
      decodeSelection({ kind: 'after', position: '10' }),
      transaction('20', '10', '2'),
    ),
  ).toThrow();
  expect(() =>
    selectedPosition(
      info,
      decodeSelection({ kind: 'after', position: '30' }),
      transaction('30', '20', '2'),
    ),
  ).toThrow();
  expect(() => decodeSelection({ kind: 'baseline', position: '0' })).toThrow();
  expect(() =>
    decodeSelection({
      get kind() {
        throw new Error('must not execute');
      },
    }),
  ).toThrow('Accessor');
});
