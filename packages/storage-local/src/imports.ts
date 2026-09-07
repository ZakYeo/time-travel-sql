import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  HistoryError,
  decodeRecordingMetadata,
  decodeRecordingInfo,
  decodeDataArray,
  decodeSnapshotRow,
  decodeTransaction,
} from '@time-travel-sql/sdk';
import type {
  RecordingInfo,
  RecordingMetadata,
  SnapshotRow,
  Position,
  CommittedTransaction,
  ReplayLimits,
} from '@time-travel-sql/sdk';
import { atomic, openDatabase } from './database.js';
import type { LocalStoreOptions } from './database.js';
import { Reader } from './reader.js';
import { Writer } from './writer.js';
import { Checkpoints } from './checkpoints.js';
import { RecordingOwners } from './recording-owners.js';
import { ReplayWork } from './replay-work.js';

interface Staging {
  published: boolean;
  readonly token: string;
  readonly reader: Reader;
  readonly writer: Writer;
  readonly id: string;
  readonly cancelled: Int32Array;
  readonly work: ReplayWork;
}

/** One owned import per store worker. Separate SQLite staging is never listed. */
export class Imports {
  #stage: Staging | undefined;

  constructor(
    readonly options: LocalStoreOptions,
    readonly limits: ReplayLimits,
  ) {}

  begin(
    metadataInput: RecordingMetadata,
    cancellation: SharedArrayBuffer,
    root: string,
  ): string {
    if (this.#stage)
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'This store already owns an import session.',
      );
    const metadata = decodeRecordingMetadata(metadataInput);
    if (
      !(cancellation instanceof SharedArrayBuffer) ||
      cancellation.byteLength !== 4
    )
      throw new HistoryError(
        'INVALID_VALUE',
        'Invalid import cancellation state.',
      );
    const cancelled = new Int32Array(cancellation);
    this.checkCancellation(cancelled);
    const db = openDatabase({
      ...this.options,
      path: join(root, 'staging.sqlite'),
    });
    try {
      const reader = new Reader(db);
      const writer = new Writer(
        reader,
        new Checkpoints(reader, this.limits),
        new RecordingOwners(reader),
      );
      atomic(db, () => writer.create(metadata));
      const token = randomUUID();
      this.#stage = {
        token,
        published: false,
        reader,
        writer,
        id: metadata.id,
        cancelled,
        work: new ReplayWork(),
      };
      return token;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private checkCancellation(cancelled: Int32Array): void {
    if (Atomics.load(cancelled, 0) !== 0)
      throw new HistoryError('CANCELLED', 'Recording import cancelled.');
  }

  private stage(token: string): Staging {
    const stage = this.#stage;
    if (!stage || stage.token !== token)
      throw new HistoryError(
        'INVALID_HISTORY',
        'Import session is closed or unknown.',
      );
    if (stage.published)
      throw new HistoryError(
        'INVALID_HISTORY',
        'Import session is already published.',
      );
    this.checkCancellation(stage.cancelled);
    return stage;
  }

  baseline(token: string, rows: readonly SnapshotRow[]): void {
    const stage = this.stage(token);
    const recording = stage.reader.info(stage.id).recording;
    const valid = decodeDataArray(rows, 100).map((row) =>
      decodeSnapshotRow(recording, row),
    );
    stage.work.charge(Buffer.byteLength(JSON.stringify(valid)));
    for (let index = 0; index < valid.length; index++) stage.work.row();
    atomic(stage.reader.db, () => stage.writer.stageBaseline(stage.id, valid));
  }

  baselineComplete(token: string, position: Position): void {
    const stage = this.stage(token);
    atomic(stage.reader.db, () =>
      stage.writer.publishBaseline(stage.id, position, () =>
        this.checkCancellation(stage.cancelled),
      ),
    );
  }

  append(token: string, transaction: CommittedTransaction): void {
    const stage = this.stage(token);
    const valid = decodeTransaction(
      stage.reader.info(stage.id).recording,
      transaction,
    );
    stage.work.charge(Buffer.byteLength(JSON.stringify(valid)));
    stage.work.transaction(valid.events.length);
    atomic(stage.reader.db, () => {
      if (stage.writer.append(stage.id, valid) !== 'appended')
        throw new HistoryError(
          'INVALID_HISTORY',
          'Imported transactions cannot be duplicated.',
        );
    });
  }

  /** Called inside the destination's single transaction. Copies through Writer,
   * reusing canonical integrity, key, predecessor and replay enforcement.
   */
  publish(
    token: string,
    expectedInput: RecordingInfo,
    destination: Writer,
  ): RecordingInfo {
    const stage = this.stage(token);
    return atomic(
      stage.reader.db,
      () => this.publishSnapshot(stage, expectedInput, destination),
      'read',
    );
  }

  private publishSnapshot(
    stage: Staging,
    expectedInput: RecordingInfo,
    destination: Writer,
  ): RecordingInfo {
    const expected = decodeRecordingInfo(expectedInput);
    if (
      expected.status === 'bootstrapping' ||
      expected.status === 'recording' ||
      expected.baselinePosition === null
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Imported recordings require closed published coverage.',
      );
    const staged = stage.reader.published(stage.id);
    if (
      JSON.stringify({ ...staged, status: expected.status }) !==
      JSON.stringify(expected)
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Imported history does not match its declared coverage.',
      );
    const { id, name, createdAt, recording } = expected;
    destination.create({ id, name, createdAt, recording });
    const work = new ReplayWork();
    for (const row of stage.reader.allBaseline(staged, work, () =>
      this.checkCancellation(stage.cancelled),
    )) {
      this.checkCancellation(stage.cancelled);
      work.row();
      destination.stageBaseline(stage.id, [row]);
    }
    destination.publishBaseline(stage.id, expected.baselinePosition, () =>
      this.checkCancellation(stage.cancelled),
    );
    for (const transaction of stage.reader.allTransactions(
      staged,
      null,
      null,
      work,
    )) {
      this.checkCancellation(stage.cancelled);
      work.transaction(transaction.events.length);
      destination.append(stage.id, transaction);
    }
    const published = destination.setStatus(stage.id, expected.status);
    if (JSON.stringify(published) !== JSON.stringify(expected))
      throw new HistoryError(
        'INVALID_HISTORY',
        'Imported history changed during verification.',
      );
    this.checkCancellation(stage.cancelled);
    return published;
  }

  /** Worker calls only after the destination transaction commits. */
  publicationCommitted(token: string): void {
    if (this.#stage?.token === token) this.#stage.published = true;
  }

  close(token?: string): void {
    const stage = this.#stage;
    if (!stage || (token !== undefined && stage.token !== token)) return;
    if (stage.reader.db.isOpen) stage.reader.db.close();
    this.#stage = undefined;
  }
}
