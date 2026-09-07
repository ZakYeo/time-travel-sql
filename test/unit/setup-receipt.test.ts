import { expect, it } from 'vitest';
import { decodePostgresSetupReceipt } from '@time-travel-sql/source-postgres';
import { metadata } from '../../test-support/storage-fixture.js';

const receipt = {
  systemId: '18446744073709551615',
  timeline: '4294967295',
  databaseOid: '5',
  publication: 'tts_setup',
  publicationOid: '123',
  ownershipToken: '0123456789abcdef0123456789abcdef',
  slot: 'tts_setup',
  schema: metadata.recording.schema,
};

it('preserves exact maximum unsigned identity values and freezes the decoded receipt', () => {
  const decoded = decodePostgresSetupReceipt(receipt);
  expect(decoded).toEqual(receipt);
  expect(Object.isFrozen(decoded)).toBe(true);
});

it.each([
  { ...receipt, systemId: '18446744073709551616' },
  { ...receipt, timeline: '4294967296' },
  { ...receipt, publicationOid: '123; DROP TABLE items' },
  { ...receipt, databaseOid: '05' },
  { ...receipt, ownershipToken: 'x'.repeat(32) },
  { ...receipt, slot: 'foreign' },
  { ...receipt, unknown: true },
])('rejects malformed receipt %#', (input) => {
  expect(() => decodePostgresSetupReceipt(input)).toThrow();
});
