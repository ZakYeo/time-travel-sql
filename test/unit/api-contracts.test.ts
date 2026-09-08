import { expect, it } from 'vitest';
import { decodeApiRequest, recordingView } from '@time-travel-sql/contracts';
import {
  decodeRecordingInfo,
  DERIVED_CAPABILITIES,
} from '@time-travel-sql/sdk';
import { metadata } from '../../test-support/storage-fixture.js';

it('retains derived capabilities and provenance in transport projections', () => {
  const derivation = {
    kind: 'column-policy',
    parentConfigurationFingerprint: 'a'.repeat(64),
    capabilities: DERIVED_CAPABILITIES,
    liveResume: false,
  };
  const info = decodeRecordingInfo({
    ...metadata,
    recording: { ...metadata.recording, derivation },
    status: 'bootstrapping',
    baselinePosition: null,
    baselineRowCount: null,
    baselineChecksum: null,
    headPosition: null,
    transactionCount: 0,
  });
  expect(recordingView(info)).toMatchObject({
    sourceId: info.recording.sourceId,
    derivation,
  });
  expect(recordingView(info)).not.toHaveProperty('baselineChecksum');
});

it('uses canonical bounds and rejects extra fields without evaluating accessors', () => {
  let accessed = false;
  for (const input of [
    { version: 1, operation: 'sample', recordingId: 'ignored' },
    { version: 1, operation: 'rename', recordingId: 'recording', name: ' ' },
    {
      version: 1,
      operation: 'transaction',
      recordingId: 'recording',
      position: '01',
    },
    { version: 1, operation: 'list', page: { limit: 101, cursor: null } },
    {
      version: 1,
      operation: 'query',
      recordingId: 'recording',
      selection: { kind: 'latest' },
      query: { sql: 'SELECT 1' },
    },
    Object.defineProperty({}, 'operation', {
      get() {
        accessed = true;
        return 'sample';
      },
    }),
  ])
    expect(() => decodeApiRequest(input)).toThrow();
  expect(accessed).toBe(false);
  expect(
    decodeApiRequest({
      version: 1,
      operation: 'query',
      recordingId: 'recording',
      selection: { kind: 'before', position: '10' },
      query: { sql: 'SELECT 1' },
    }),
  ).toMatchObject({
    operation: 'query',
    selection: { kind: 'before', position: '10' },
    query: { limits: { maxRows: 1000 } },
  });
});
