import {
  decodeRecordingMetadata,
  decodeRecordingInfo,
  decodeSnapshotRow,
  decodeTransaction,
  decodePosition,
  HistoryError,
  HistoryState,
  rowKey,
  validateStatusChange,
} from '@time-travel-sql/sdk';
import type {
  RecordingMetadata,
  RecordingInfo,
  RecordingStatus,
  SnapshotRow,
  Position,
  CommittedTransaction,
} from '@time-travel-sql/sdk';
import { encode } from './integrity.js';
import type { Reader } from './reader.js';
import { ReplayCache } from './replay-cache.js';
import type { Checkpoints } from './checkpoints.js';
import type { RecordingOwners } from './recording-owners.js';

/** Every method runs inside the worker's single SQLite transaction. */
export class Writer {
  readonly #cache: ReplayCache;
  constructor(
    readonly reader: Reader,
    readonly checkpoints: Checkpoints,
    readonly owners: RecordingOwners,
  ) {
    this.#cache = new ReplayCache(reader, checkpoints);
  }

  save(info: RecordingInfo): RecordingInfo {
    const valid = decodeRecordingInfo(info);
    const { data, digest } = encode(valid);
    this.reader.db
      .prepare('UPDATE recordings SET data=?, digest=? WHERE id=?')
      .run(data, digest, valid.id);
    return valid;
  }

  create(input: RecordingMetadata): RecordingInfo {
    const metadata = decodeRecordingMetadata(input);
    const info = decodeRecordingInfo({
      ...metadata,
      status: 'bootstrapping',
      baselinePosition: null,
      baselineRowCount: null,
      baselineChecksum: null,
      headPosition: null,
      transactionCount: 0,
    });
    const { data, digest } = encode(info);
    this.reader.db
      .prepare('INSERT INTO recordings(id,data,digest) VALUES(?,?,?)')
      .run(info.id, data, digest);
    return info;
  }

  stageBaseline(id: string, inputs: readonly SnapshotRow[]): void {
    const info = this.reader.info(id);
    if (info.status !== 'bootstrapping')
      throw new HistoryError(
        'INVALID_HISTORY',
        'Baseline staging requires a bootstrapping recording.',
      );
    if (!Array.isArray(inputs) || inputs.length > 100)
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Baseline batch must contain at most 100 rows.',
      );
    for (const input of inputs) {
      const value = decodeSnapshotRow(info.recording, input);
      const table = info.recording.schema.tables.find(
        (entry) => entry.id === value.tableId,
      );
      if (!table)
        throw new HistoryError('INVALID_SCHEMA', 'Unknown baseline table.');
      const key = rowKey(info.recording, table, value.row);
      const { data, digest } = encode(value);
      this.reader.db
        .prepare(
          'INSERT INTO baseline(recording_id,key,data,digest) VALUES(?,?,?,?)',
        )
        .run(id, key, data, digest);
    }
  }

  publishBaseline(id: string, input: Position): RecordingInfo {
    const info = this.reader.info(id);
    if (info.status !== 'bootstrapping')
      throw new HistoryError(
        'INVALID_HISTORY',
        'Baseline has already been published or invalidated.',
      );
    const position = decodePosition(input);
    const state = HistoryState.fromSnapshot(
      info.recording,
      position,
      this.reader.allBaseline(info),
      this.checkpoints.limits,
    );
    const published = this.save({
      ...info,
      status: 'recording',
      baselinePosition: position,
      ...this.reader.baselineCommitment(id),
      headPosition: position,
    });
    this.#cache.remember(published, state);
    return published;
  }

  append(
    id: string,
    input: CommittedTransaction,
    token?: string,
  ): 'appended' | 'duplicate' {
    this.owners.assertWrite(id, token);
    const info = this.reader.published(id);
    if (info.status !== 'recording')
      throw new HistoryError(
        'INVALID_HISTORY',
        'Appending requires an active recording.',
      );
    const transaction = decodeTransaction(info.recording, input);
    const state = this.#cache.load(info);
    const key = transaction.position.padStart(40, '0');
    const prior = this.reader.db
      .prepare('SELECT * FROM transactions WHERE recording_id=? AND position=?')
      .get(id, key);
    if (prior) {
      if (
        JSON.stringify(this.reader.committed(info, prior)) !==
        JSON.stringify(transaction)
      )
        throw new HistoryError(
          'INVALID_HISTORY',
          'Divergent transaction redelivery.',
        );
      return 'duplicate';
    }
    const nextState = state.apply(transaction);
    const { data, digest } = encode(transaction);
    this.reader.db
      .prepare(
        'INSERT INTO transactions(recording_id,position,data,digest) VALUES(?,?,?,?)',
      )
      .run(id, key, data, digest);
    const next = this.save({
      ...info,
      headPosition: transaction.position,
      transactionCount: info.transactionCount + 1,
    });
    this.#cache.remember(next, nextState);
    return 'appended';
  }

  setStatus(
    id: string,
    status: RecordingStatus,
    token?: string,
  ): RecordingInfo {
    this.owners.assertWrite(id, token);
    const info = this.reader.info(id);
    // Decode first: callers from JS and worker messages need the same validation.
    const next = decodeRecordingInfo({ ...info, status });
    validateStatusChange(info.status, next.status);
    return this.save(next);
  }

  rename(id: string, name: string): RecordingInfo {
    return this.save({ ...this.reader.info(id), name });
  }

  remove(id: string): void {
    this.reader.info(id);
    this.reader.db.prepare('DELETE FROM recordings WHERE id=?').run(id);
    this.#cache.clear();
  }
}
