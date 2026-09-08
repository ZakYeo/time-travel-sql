import { expect, it } from 'vitest';
import {
  createPostgresCaptureBinding,
  createPostgresResumeProvider,
} from '@time-travel-sql/source-postgres';
import { metadata } from '../../test-support/storage-fixture.js';

it('rejects a changed source binding at acquisition before opening any connection', async () => {
  const receipt = {
    systemId: '1',
    timeline: '1',
    databaseOid: '1',
    publicationOid: '1',
    publication: 'tts_expected',
    slot: 'tts_expected',
    ownershipToken: 'a'.repeat(32),
    schema: metadata.recording.schema,
  };
  const expected = createPostgresCaptureBinding(metadata.recording, receipt);
  const provider = createPostgresResumeProvider(
    {
      host: 'must-not-connect.invalid',
      port: 1,
      database: 'source',
      user: 'operator',
    },
    expected,
  );
  for (const changed of [
    {
      recording: metadata.recording,
      receipt: { ...receipt, slot: 'tts_other' },
    },
    {
      recording: { ...metadata.recording, epochId: 'replacement-epoch' },
      receipt,
    },
  ]) {
    await expect(
      provider.acquire(
        changed.recording,
        createPostgresCaptureBinding(changed.recording, changed.receipt),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_HISTORY',
      message: 'Capture binding differs from the explicitly selected source.',
    });
  }
});
