import { expect, it } from 'vitest';
import {
  quoteIdentifier,
  decodeLsn,
  encodeLsn,
  validateSlotName,
} from '../../packages/source-postgres/src/index.js';

it('quotes identifiers as data, including embedded double quotes', () => {
  expect(quoteIdentifier('odd"table')).toBe('"odd""table"');
  expect(() => quoteIdentifier('')).toThrow();
  expect(() => quoteIdentifier('bad\0name')).toThrow();
});

it('round trips LSNs without number precision loss', () => {
  const value = decodeLsn('FFFFFFFF/FFFFFFFF');
  expect(value).toBe('18446744073709551615');
  expect(encodeLsn(value)).toBe('FFFFFFFF/FFFFFFFF');
  expect(decodeLsn('0/0')).toBe('0');
  expect(() => decodeLsn('100000000/0')).toThrow();
  expect(() => decodeLsn('x/1')).toThrow();
});

it('limits owned slot names to the documented prefix and PostgreSQL grammar', () => {
  expect(validateSlotName('tts_example')).toBe('tts_example');
  for (const name of ['other', 'tts_"bad', 'tts_', 'tts_' + 'a'.repeat(60)]) {
    expect(() => validateSlotName(name)).toThrow();
  }
});
