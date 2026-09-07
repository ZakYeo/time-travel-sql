import { HistoryError } from '../domain/errors.js';
import { utf8Bytes } from '../domain/validation.js';
import { findTable, rowKey } from '../domain/schema.js';
import type { ReconstructionInfo } from '../domain/reconstruction.js';
import type {
  InvestigationOptions,
  KeyedRow,
} from '../domain/investigation.js';
import type {
  CancellationSignal,
  ReconstructionView,
} from '../ports/reconstruction.js';
import { reconstructionRows } from './reconstruction-rows.js';

export interface InvestigationControl {
  readonly signal: CancellationSignal;
  /** Yield to the host event loop, allowing timers/UI cancellation to run. */
  readonly cooperate: () => Promise<void>;
}
export class InvestigationWork {
  #steps = 0;
  #characters = 0;
  constructor(
    readonly control: InvestigationControl,
    infos: readonly ReconstructionInfo[],
    options: InvestigationOptions,
  ) {
    this.check();
    if (
      infos.reduce((sum, info) => sum + info.rowCount, 0) >
        options.maxInputRows ||
      infos.reduce((sum, info) => sum + info.retainedBytes, 0) >
        options.maxInputBytes
    )
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Selected states exceed the investigation work budget.',
      );
    if (options.tableId)
      for (const info of infos)
        findTable(info.recording.recording.schema, options.tableId);
  }
  check(): void {
    if (this.control.signal.aborted)
      throw new HistoryError('CANCELLED', 'Investigation cancelled.');
  }
  async step(row: KeyedRow): Promise<void> {
    this.check();
    this.#steps++;
    this.#characters += row.key.length + JSON.stringify(row.row).length;
    if (this.#steps >= 256 || this.#characters >= 16384) {
      this.#steps = 0;
      this.#characters = 0;
      await this.control.cooperate();
      this.check();
    }
  }
}

export async function* keyedRows(
  view: ReconstructionView,
  info: ReconstructionInfo,
  work: InvestigationWork,
): AsyncGenerator<KeyedRow> {
  const recording = info.recording.recording;
  const pinned = {
    info,
    rows: (table: string, page: Parameters<ReconstructionView['rows']>[1]) =>
      view.rows(table, page),
  };
  for await (const value of reconstructionRows(pinned)) {
    const row = Object.freeze({
      ...value,
      key: rowKey(
        recording,
        findTable(recording.schema, value.tableId),
        value.row,
      ),
    });
    await work.step(row);
    yield row;
  }
  work.check();
}

/** Counts every match, retaining only a bounded contiguous result page. */
export class InvestigationPage<T> {
  readonly #items: T[] = [];
  #bytes = 2;
  #full = false;
  #total = 0;
  constructor(readonly options: InvestigationOptions) {}
  add(item: T): void {
    const ordinal = this.#total++;
    if (ordinal < this.options.offset || this.#full) return;
    if (this.#items.length === this.options.limit) {
      this.#full = true;
      return;
    }
    const size =
      utf8Bytes(JSON.stringify(item), 16 * 1024 * 1024) +
      (this.#items.length ? 1 : 0);
    if (this.#bytes + size > this.options.maxResultBytes) {
      if (!this.#items.length)
        throw new HistoryError(
          'LIMIT_EXCEEDED',
          'One investigation result exceeds the output budget.',
        );
      this.#full = true;
      return;
    }
    this.#bytes += size;
    this.#items.push(item);
  }
  result() {
    return Object.freeze({
      items: Object.freeze([...this.#items]),
      total: this.#total,
      nextOffset:
        this.options.offset + this.#items.length < this.#total
          ? this.options.offset + this.#items.length
          : null,
    });
  }
}
