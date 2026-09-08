import {
  decodeSavedCheck,
  decodeStableId,
  decodePageRequest,
  decodeDataFields,
  HistoryError,
} from '@time-travel-sql/sdk';
import type { SavedCheck, PageRequest } from '@time-travel-sql/sdk';
import type { SQLOutputValue } from 'node:sqlite';
import { collect } from './reader.js';
import type { Reader } from './reader.js';
import { encode, readRecord } from './integrity.js';

/** Recording-scoped local definitions. All methods run in the owning worker transaction. */
export class CheckDefinitions {
  constructor(readonly reader: Reader) {}
  #decode(
    recordingId: string,
    row: Record<string, SQLOutputValue> | undefined,
  ): SavedCheck {
    const data = decodeDataFields(readRecord(row), ['recordingId', 'check']);
    const check = decodeSavedCheck(data.check);
    if (data.recordingId !== recordingId || check.id !== row?.id)
      throw new HistoryError(
        'INVALID_HISTORY',
        'Saved check identity does not match its recording.',
      );
    return check;
  }
  savedCheck(recordingId: string, checkInput: string): SavedCheck {
    this.reader.published(recordingId);
    const id = decodeStableId(checkInput);
    return this.#decode(
      recordingId,
      this.reader.db
        .prepare(
          'SELECT id,data,digest FROM saved_checks WHERE recording_id=? AND id=?',
        )
        .get(recordingId, id),
    );
  }
  savedChecks(recordingId: string, input: PageRequest) {
    this.reader.published(recordingId);
    const page = decodePageRequest(input);
    const cursor = page.cursor === null ? '' : decodeStableId(page.cursor);
    const rows = this.reader.db
      .prepare(
        'SELECT id,data,digest FROM saved_checks WHERE recording_id=? AND id>? ORDER BY id LIMIT ?',
      )
      .iterate(recordingId, cursor, page.limit + 1);
    return collect(rows, page.limit, (row) => {
      const value = this.#decode(recordingId, row);
      return { value, cursor: value.id };
    });
  }
  saveCheck(recordingId: string, input: SavedCheck): SavedCheck {
    this.reader.published(recordingId);
    const check = decodeSavedCheck(input);
    const existing = this.reader.db
      .prepare('SELECT id FROM saved_checks WHERE recording_id=? AND id=?')
      .get(recordingId, check.id);
    if (!existing) {
      const count = this.reader.db
        .prepare(
          'SELECT count(*) AS count FROM saved_checks WHERE recording_id=?',
        )
        .get(recordingId)?.count;
      if (typeof count !== 'number' || count >= 1000)
        throw new HistoryError(
          'LIMIT_EXCEEDED',
          'Recording exceeds its 1000 saved check limit.',
        );
    }
    const { data, digest } = encode({ recordingId, check });
    this.reader.db
      .prepare(
        'INSERT INTO saved_checks(recording_id,id,data,digest) VALUES(?,?,?,?) ON CONFLICT(recording_id,id) DO UPDATE SET data=excluded.data,digest=excluded.digest',
      )
      .run(recordingId, check.id, data, digest);
    return check;
  }
  removeCheck(recordingId: string, input: string): void {
    this.reader.published(recordingId);
    const id = decodeStableId(input);
    const result = this.reader.db
      .prepare('DELETE FROM saved_checks WHERE recording_id=? AND id=?')
      .run(recordingId, id);
    if (result.changes !== 1)
      throw new HistoryError('INVALID_HISTORY', 'Saved check does not exist.');
  }
}
