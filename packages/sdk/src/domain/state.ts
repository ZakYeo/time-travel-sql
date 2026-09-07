import { HistoryError } from './errors.js';
import { decodePosition } from './position.js';
import type { Position } from './position.js';
import {
  decodeRecordingSchema,
  decodeRow,
  findTable,
  rowKey,
} from './schema.js';
import type { RecordingSchema, Row } from './schema.js';
import { decodeTransaction } from './events.js';
import type { CommittedTransaction } from './events.js';
import { objectFields, identityText } from './validation.js';

type Tables = ReadonlyMap<string, ReadonlyMap<string, Row>>;

/** Immutable committed state. Private maps prevent accidental mutation of predecessors. */
export class HistoryState {
  readonly #tables: Tables;
  readonly #lastCommit: string | undefined;

  private constructor(
    readonly recording: RecordingSchema,
    readonly position: Position,
    tables: Tables,
    lastCommit?: string,
  ) {
    this.#tables = tables;
    this.#lastCommit = lastCommit;
    Object.freeze(this);
  }

  static fromSnapshot(
    recordingInput: unknown,
    positionInput: unknown,
    rows: Iterable<unknown>,
  ): HistoryState {
    const recording = decodeRecordingSchema(recordingInput);
    const schema = recording.schema;
    const position = decodePosition(positionInput);
    const tables = new Map(
      schema.tables.map((table) => [table.id, new Map<string, Row>()]),
    );
    for (const input of rows) {
      const entry = objectFields(input, ['tableId', 'row']);
      const id = identityText(entry.tableId);
      const table = findTable(schema, id);
      const row = decodeRow(table, entry.row);
      const key = rowKey(recording, table, row);
      const target = tables.get(id);
      if (!target || target.has(key))
        throw new HistoryError(
          'INVALID_HISTORY',
          'Duplicate baseline row identity.',
        );
      target.set(key, row);
    }
    return new HistoryState(recording, position, tables);
  }

  rows(tableId: string): readonly Row[] {
    const table = this.#tables.get(tableId);
    if (!table)
      throw new HistoryError('INVALID_SCHEMA', 'Unknown recorded table.');
    return Object.freeze(
      [...table.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, row]) => row),
    );
  }

  apply(input: unknown): HistoryState {
    const transaction = decodeTransaction(this.recording, input);
    const fingerprint = JSON.stringify(transaction);
    if (
      transaction.position === this.position &&
      fingerprint === this.#lastCommit
    )
      return this;
    if (transaction.previousPosition !== this.position)
      throw new HistoryError(
        'INVALID_HISTORY',
        'Missing predecessor or divergent transaction redelivery.',
      );
    const tables = this.applyEvents(transaction);
    return new HistoryState(
      this.recording,
      transaction.position,
      tables,
      fingerprint,
    );
  }

  private applyEvents(transaction: CommittedTransaction): Tables {
    const tables = new Map(this.#tables);
    const changed = new Map<string, Map<string, Row>>();
    for (const event of transaction.events) {
      const table = findTable(this.recording.schema, event.tableId);
      let rows = changed.get(table.id);
      if (!rows) {
        rows = new Map(tables.get(table.id));
        changed.set(table.id, rows);
        tables.set(table.id, rows);
      }
      if (event.kind !== 'insert') {
        const key = rowKey(this.recording, table, event.before);
        if (JSON.stringify(rows.get(key)) !== JSON.stringify(event.before))
          throw new HistoryError(
            'INVALID_HISTORY',
            'Missing row or stale before-image.',
          );
        rows.delete(key);
      }
      if (event.kind !== 'delete') {
        const key = rowKey(this.recording, table, event.after);
        if (rows.has(key))
          throw new HistoryError(
            'INVALID_HISTORY',
            'Insert or key change collides with an existing row.',
          );
        rows.set(key, event.after);
      }
    }
    return tables;
  }
}
