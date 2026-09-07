import { createHash } from 'node:crypto';
import {
  decodeDataFields,
  decodeSnapshotRow,
  decodeTransaction,
  findTable,
  rowKey,
  HistoryError,
  HISTORY_WORK_LIMITS,
} from '@time-travel-sql/sdk';
import type {
  RecordingManifest,
  SnapshotRow,
  CommittedTransaction,
  Position,
} from '@time-travel-sql/sdk';

type DataRecord =
  | { readonly kind: 'baseline'; readonly row: SnapshotRow }
  | {
      readonly kind: 'transaction';
      readonly transaction: CommittedTransaction;
    };

/** Streaming completeness/order/integrity checks; the staging writer owns replay. */
export class RecordingValidation {
  #rows = 0;
  #transactions = 0;
  #events = 0;
  #lastKey: Buffer | undefined;
  #position: Position;
  #baselineDone = false;
  readonly #baselineHash = createHash('sha256');

  constructor(readonly manifest: RecordingManifest) {
    this.#position = manifest.info.baselinePosition;
  }

  accept(input: unknown): DataRecord {
    const envelope = decodeDataFields(input, ['kind', 'row', 'transaction']);
    if (
      envelope.kind === 'baseline' &&
      Object.keys(envelope).length === 2 &&
      'row' in envelope
    ) {
      if (
        this.#baselineDone ||
        ++this.#rows > this.manifest.info.baselineRowCount
      )
        throw new HistoryError('INVALID_HISTORY', 'Unexpected baseline row.');
      const row = decodeSnapshotRow(this.manifest.info.recording, envelope.row);
      const table = findTable(this.manifest.info.recording.schema, row.tableId);
      const key = rowKey(this.manifest.info.recording, table, row.row);
      const keyBytes = Buffer.from(key, 'utf8');
      if (this.#lastKey && Buffer.compare(this.#lastKey, keyBytes) >= 0)
        throw new HistoryError(
          'INVALID_HISTORY',
          'Baseline keys are duplicated or unordered.',
        );
      this.#lastKey = keyBytes;
      const digest = createHash('sha256')
        .update(JSON.stringify(row))
        .digest('hex');
      this.#baselineHash.update(JSON.stringify([key, digest]) + '\n');
      return { kind: 'baseline', row };
    }
    if (
      envelope.kind === 'transaction' &&
      Object.keys(envelope).length === 2 &&
      'transaction' in envelope
    ) {
      this.finishBaseline();
      const transaction = decodeTransaction(
        this.manifest.info.recording,
        envelope.transaction,
      );
      if (
        ++this.#transactions > this.manifest.info.transactionCount ||
        transaction.previousPosition !== this.#position
      )
        throw new HistoryError(
          'INVALID_HISTORY',
          'Transaction count or predecessor mismatch.',
        );
      this.#events += transaction.events.length;
      if (this.#events > HISTORY_WORK_LIMITS.maxEvents)
        throw new HistoryError(
          'LIMIT_EXCEEDED',
          'Imported events exceed the work budget.',
        );
      this.#position = transaction.position;
      return { kind: 'transaction', transaction };
    }
    throw new HistoryError('INVALID_HISTORY', 'Unexpected recording record.');
  }

  finishBaseline(): void {
    if (this.#baselineDone) return;
    this.#baselineDone = true;
    if (
      this.#rows !== this.manifest.info.baselineRowCount ||
      this.#baselineHash.digest('hex') !== this.manifest.info.baselineChecksum
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Baseline count or checksum mismatch.',
      );
  }

  finish(): void {
    this.finishBaseline();
    if (
      this.#transactions !== this.manifest.info.transactionCount ||
      this.#position !== this.manifest.info.headPosition
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Recording does not reach its declared head.',
      );
  }
}
