import { createHash } from 'node:crypto';
import { findTable, rowKey } from '@time-travel-sql/sdk';
import type { RecordingSchema, SnapshotRow } from '@time-travel-sql/sdk';

/** Portable baseline commitment over canonical ordered key/row digests. */
export class BaselineCommitment {
  readonly #hash = createHash('sha256');
  constructor(readonly recording: RecordingSchema) {}

  add(row: SnapshotRow): void {
    const key = rowKey(
      this.recording,
      findTable(this.recording.schema, row.tableId),
      row.row,
    );
    const digest = createHash('sha256')
      .update(JSON.stringify(row))
      .digest('hex');
    this.#hash.update(JSON.stringify([key, digest]) + '\n');
  }

  finish(): string {
    return this.#hash.digest('hex');
  }
}
