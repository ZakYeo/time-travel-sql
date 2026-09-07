import {
  decodeCaptureBinding,
  decodeDataFields,
  HistoryError,
} from '@time-travel-sql/sdk';
import type { CaptureBinding } from '@time-travel-sql/sdk';
import type { Reader } from './reader.js';
import { encode, readRecord } from './integrity.js';

/** Immutable recording-scoped metadata; methods run in the worker transaction. */
export class CaptureBindings {
  constructor(readonly reader: Reader) {}

  captureBinding(id: string): CaptureBinding | null {
    this.reader.info(id);
    const row = this.reader.db
      .prepare('SELECT data,digest FROM capture_bindings WHERE recording_id=?')
      .get(id);
    if (!row) return null;
    const data = decodeDataFields(readRecord(row), ['recordingId', 'binding']);
    if (data.recordingId !== id)
      throw new HistoryError(
        'INVALID_HISTORY',
        'Capture binding belongs to another recording.',
      );
    return decodeCaptureBinding(data.binding);
  }

  bindCapture(id: string, input: CaptureBinding): void {
    const binding = decodeCaptureBinding(input);
    const prior = this.captureBinding(id);
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(binding))
        throw new HistoryError(
          'INVALID_HISTORY',
          'Capture binding cannot be replaced.',
        );
      return;
    }
    if (this.reader.info(id).status !== 'bootstrapping')
      throw new HistoryError(
        'INVALID_HISTORY',
        'Capture binding requires an unpublished recording.',
      );
    const { data, digest } = encode({ recordingId: id, binding });
    this.reader.db
      .prepare(
        'INSERT INTO capture_bindings(recording_id,data,digest) VALUES(?,?,?)',
      )
      .run(id, data, digest);
  }
}
