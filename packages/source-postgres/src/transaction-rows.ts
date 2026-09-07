import { rowKey } from '@time-travel-sql/sdk';
import type { HistoryState, Row, RowEvent } from '@time-travel-sql/sdk';

/** Lookup overlay only. Canonical HistoryState.apply validates the complete commit. */
export class TransactionRows {
  readonly #changed = new Map<string, Row | null>();
  constructor(private readonly base: HistoryState) {}

  read(tableId: string, key: string): Row | undefined {
    return this.#changed.has(key)
      ? (this.#changed.get(key) ?? undefined)
      : this.base.row(tableId, key);
  }

  record(event: RowEvent): void {
    const recording = this.base.recording;
    const table = recording.schema.tables.find(
      (table) => table.id === event.tableId,
    );
    if (!table) throw new Error('Normalized event has no recorded table.');
    if (event.kind !== 'insert')
      this.#changed.set(rowKey(recording, table, event.before), null);
    if (event.kind !== 'delete')
      this.#changed.set(rowKey(recording, table, event.after), event.after);
  }
}
