import { expect, it } from 'vitest';
import {
  decodeRecordingInfo,
  decodeRecordingMetadata,
  decodePageRequest,
  validateStatusChange,
} from '@time-travel-sql/sdk';
import { metadata } from '../../test-support/storage-fixture.js';

const unpublished = {
  ...metadata,
  status: 'bootstrapping',
  baselinePosition: null,
  headPosition: null,
  baselineRowCount: null,
  baselineChecksum: null,
  transactionCount: 0,
};
const published = {
  ...unpublished,
  status: 'recording',
  baselinePosition: '0',
  headPosition: '0',
  baselineRowCount: 0,
  baselineChecksum: 'a'.repeat(64),
};

it('validates lifecycle coverage and baseline integrity metadata together', () => {
  expect(decodeRecordingInfo(unpublished).status).toBe('bootstrapping');
  expect(decodeRecordingInfo(published).status).toBe('recording');
  expect(
    decodeRecordingInfo({ ...unpublished, status: 'invalid' }).status,
  ).toBe('invalid');
  for (const invalid of [
    { ...unpublished, transactionCount: 1 },
    { ...unpublished, status: 'recording' },
    { ...unpublished, baselineRowCount: 0 },
    { ...published, baselineChecksum: null },
    { ...published, baselineRowCount: -1 },
    { ...published, baselineChecksum: 'not-a-digest' },
    { ...published, status: 'bootstrapping' },
    { ...published, headPosition: '1' },
    { ...published, transactionCount: 1 },
  ])
    expect(() => decodeRecordingInfo(invalid)).toThrow();
});

it('allows explicit stop and resume, but never revives invalid coverage', () => {
  expect(() => validateStatusChange('recording', 'stopped')).not.toThrow();
  expect(() => validateStatusChange('stopped', 'recording')).not.toThrow();
  expect(() => validateStatusChange('invalid', 'recording')).toThrow();
  expect(() => validateStatusChange('bootstrapping', 'recording')).toThrow();
});

it('bounds recording names and indexed page requests', () => {
  expect(() => decodeRecordingMetadata({ ...metadata, name: '  ' })).toThrow();
  expect(() =>
    decodeRecordingMetadata({ ...metadata, name: 'x'.repeat(257) }),
  ).toThrow();
  expect(() => decodePageRequest({ cursor: null, limit: 101 })).toThrow();
  expect(() => decodePageRequest({ cursor: null, limit: 0 })).toThrow();
  expect(() =>
    decodePageRequest({ cursor: 'x'.repeat(65537), limit: 1 }),
  ).toThrow();
});
