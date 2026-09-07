import { decodeTransaction } from '../domain/events.js';
import type { CommittedTransaction } from '../domain/events.js';
import { decodeRecordingSchema } from '../domain/schema.js';
import { identityText } from '../domain/validation.js';
import { HistoryError } from '../domain/errors.js';
import type { SourceStream } from '../ports/source.js';
import type { HistoryWriter } from '../ports/history.js';

/** Success leaves the stream open. Any failed step closes it without a later ack. */
export async function recordNextCommit(
  stream: SourceStream,
  writer: Pick<HistoryWriter, 'append'>,
  recordingId: string,
): Promise<CommittedTransaction> {
  try {
    const id = identityText(recordingId);
    const recording = decodeRecordingSchema(stream.recording);
    const transaction = decodeTransaction(recording, await stream.next());
    await writer.append(id, transaction);
    await stream.acknowledge(transaction.position);
    return transaction;
  } catch (error) {
    try {
      await stream.close();
    } catch (cleanup) {
      throw new HistoryError(
        'STORAGE_FAILURE',
        'Capture failed and its source could not be closed.',
        { cause: new AggregateError([error, cleanup]) },
      );
    }
    throw error;
  }
}
