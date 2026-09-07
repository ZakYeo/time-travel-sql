import { decodeStableId, HistoryError } from '@time-travel-sql/sdk';
import type {
  RecordingWriteClaim,
  RecordingWriteLease,
} from '@time-travel-sql/sdk';
import type { Client } from './client.js';

export async function prepareRecording(
  client: Client,
  input: string,
): Promise<RecordingWriteClaim> {
  const recordingId = decodeStableId(input);
  const token = await client.request({
    method: 'prepareRecording',
    args: [recordingId],
  });
  let activated: Promise<RecordingWriteLease> | undefined;
  return Object.freeze({
    recordingId,
    activate() {
      activated ??= client
        .request({ method: 'activateRecording', args: [recordingId, token] })
        .then(() => writer(client, recordingId, token));
      return activated;
    },
  });
}

function writer(
  client: Client,
  recordingId: string,
  token: string,
): RecordingWriteLease {
  let closing: Promise<void> | undefined;
  const assertOpen = (id: string): void => {
    if (closing || id !== recordingId)
      throw new HistoryError(
        'INVALID_HISTORY',
        'Recording writer is closed or belongs to another recording.',
      );
  };
  return Object.freeze({
    recordingId,
    async append(id, transaction) {
      assertOpen(id);
      return client.request({
        method: 'fencedAppend',
        args: [id, token, transaction],
      });
    },
    async setStatus(id, status) {
      assertOpen(id);
      return client.request({
        method: 'fencedSetStatus',
        args: [id, token, status],
      });
    },
    close() {
      closing ??= client.request({
        method: 'releaseRecording',
        args: [recordingId, token],
      });
      return closing;
    },
  } satisfies RecordingWriteLease);
}
