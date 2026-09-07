import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  decodeRecordingInfo,
  decodeSnapshotRow,
  decodeTransaction,
  decodePageRequest,
  decodePosition,
  HistoryError,
  rowKey,
} from '@time-travel-sql/sdk';
import type {
  RecordingInfo,
  SnapshotRow,
  CommittedTransaction,
  Page,
  PageRequest,
  Position,
} from '@time-travel-sql/sdk';
import { MAX_MESSAGE_BYTES, readRecord } from './integrity.js';
import type { ReplayWork } from './replay-work.js';

type StoredRow = Record<string, SQLOutputValue>;

export class Reader {
  constructor(readonly db: DatabaseSync) {}

  info(id: string, work?: ReplayWork): RecordingInfo {
    const result = decodeRecordingInfo(
      readRecord(
        this.db.prepare('SELECT * FROM recordings WHERE id=?').get(id),
        work,
      ),
    );
    if (result.id !== id)
      throw new HistoryError(
        'INVALID_HISTORY',
        'Recording identity does not match its index.',
      );
    return result;
  }

  published(id: string, work?: ReplayWork): RecordingInfo {
    const info = this.info(id, work);
    if (info.baselinePosition === null)
      throw new HistoryError(
        'INVALID_HISTORY',
        'Baseline has not been published.',
      );
    return info;
  }

  snapshotRow(
    info: RecordingInfo,
    stored: StoredRow,
    work?: ReplayWork,
  ): SnapshotRow {
    const value = decodeSnapshotRow(info.recording, readRecord(stored, work));
    const table = info.recording.schema.tables.find(
      (entry) => entry.id === value.tableId,
    );
    if (!table || rowKey(info.recording, table, value.row) !== stored.key)
      throw new HistoryError(
        'INVALID_HISTORY',
        'Baseline row identity does not match its index.',
      );
    return value;
  }

  committed(
    info: RecordingInfo,
    stored: StoredRow | undefined,
    work?: ReplayWork,
  ): CommittedTransaction {
    const value = decodeTransaction(info.recording, readRecord(stored, work));
    if (value.position.padStart(40, '0') !== stored?.position)
      throw new HistoryError(
        'INVALID_HISTORY',
        'Transaction position does not match its index.',
      );
    return value;
  }

  *allBaseline(
    info: RecordingInfo,
    work?: ReplayWork,
    checkCancellation: () => void = () => undefined,
  ): Iterable<SnapshotRow> {
    for (const row of this.db
      .prepare('SELECT * FROM baseline WHERE recording_id=? ORDER BY key')
      .iterate(info.id)) {
      checkCancellation();
      yield this.snapshotRow(info, row, work);
    }
    if (info.baselinePosition !== null) {
      const actual = this.baselineCommitment(info.id, checkCancellation);
      if (
        actual.baselineRowCount !== info.baselineRowCount ||
        actual.baselineChecksum !== info.baselineChecksum
      )
        throw new HistoryError(
          'INVALID_HISTORY',
          'Baseline completeness check failed.',
        );
    }
  }

  baselineCommitment(
    id: string,
    checkCancellation: () => void = () => undefined,
  ): {
    baselineRowCount: number;
    baselineChecksum: string;
  } {
    const hash = createHash('sha256');
    let baselineRowCount = 0;
    for (const row of this.db
      .prepare(
        'SELECT key,digest FROM baseline WHERE recording_id=? ORDER BY key',
      )
      .iterate(id)) {
      checkCancellation();
      hash.update(JSON.stringify([row.key, row.digest]) + '\n');
      baselineRowCount++;
    }
    return { baselineRowCount, baselineChecksum: hash.digest('hex') };
  }

  *allTransactions(
    info: RecordingInfo,
    after: Position | null = null,
    through: Position | null = null,
    work?: ReplayWork,
  ): Iterable<CommittedTransaction> {
    for (const row of this.db
      .prepare(
        'SELECT * FROM transactions WHERE recording_id=? AND position>? AND position<=? ORDER BY position',
      )
      .iterate(
        info.id,
        after?.padStart(40, '0') ?? '',
        through?.padStart(40, '0') ?? '9'.repeat(40),
      ))
      yield this.committed(info, row, work);
  }

  list(input: PageRequest): Page<RecordingInfo> {
    const page = decodePageRequest(input);
    const rows = this.db
      .prepare('SELECT * FROM recordings WHERE id>? ORDER BY id LIMIT ?')
      .iterate(page.cursor ?? '', page.limit + 1);
    return collect(rows, page.limit, (stored) => {
      const info = decodeRecordingInfo(readRecord(stored));
      if (info.id !== stored.id)
        throw new HistoryError(
          'INVALID_HISTORY',
          'Recording identity does not match its index.',
        );
      return { value: info, cursor: info.id };
    });
  }

  baseline(id: string, input: PageRequest): Page<SnapshotRow> {
    const info = this.published(id);
    if (
      this.db
        .prepare('SELECT count(*) AS count FROM baseline WHERE recording_id=?')
        .get(id)?.count !== info.baselineRowCount
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Baseline completeness check failed.',
      );
    const page = decodePageRequest(input);
    const rows = this.db
      .prepare(
        'SELECT * FROM baseline WHERE recording_id=? AND key>? ORDER BY key LIMIT ?',
      )
      .iterate(id, page.cursor ?? '', page.limit + 1);
    return collect(rows, page.limit, (stored) => ({
      value: this.snapshotRow(info, stored),
      cursor: String(stored.key),
    }));
  }

  transactions(id: string, input: PageRequest): Page<CommittedTransaction> {
    const info = this.published(id);
    const page = decodePageRequest(input);
    const cursor =
      page.cursor === null ? '' : decodePosition(page.cursor).padStart(40, '0');
    const rows = this.db
      .prepare(
        'SELECT * FROM transactions WHERE recording_id=? AND position>? ORDER BY position LIMIT ?',
      )
      .iterate(id, cursor, page.limit + 1);
    return collect(rows, page.limit, (stored) => {
      const value = this.committed(info, stored);
      return { value, cursor: value.position };
    });
  }

  transaction(
    id: string,
    position: string,
    work?: ReplayWork,
  ): CommittedTransaction {
    return this.committed(
      this.published(id, work),
      this.db
        .prepare(
          'SELECT * FROM transactions WHERE recording_id=? AND position=?',
        )
        .get(id, decodePosition(position).padStart(40, '0')),
      work,
    );
  }
}

export function collect<T>(
  rows: Iterable<StoredRow>,
  limit: number,
  decode: (row: StoredRow) => { value: T; cursor: string },
): Page<T> {
  const items: T[] = [];
  let bytes = 128;
  let last: string | null = null;
  for (const row of rows) {
    const item = decode(row);
    const size = Buffer.byteLength(JSON.stringify(item));
    if (
      items.length === limit ||
      (items.length > 0 && bytes + size > MAX_MESSAGE_BYTES - 1024)
    )
      return { items, nextCursor: last };
    items.push(item.value);
    bytes += size;
    last = item.cursor;
  }
  return { items, nextCursor: null };
}
