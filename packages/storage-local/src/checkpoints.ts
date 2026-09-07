import { createHash } from 'node:crypto';
import {
  HistoryError,
  HistoryState,
  decodeCheckpointInfo,
  decodePageRequest,
  decodePosition,
  decodeSelection,
  selectedPosition,
  rowKey,
} from '@time-travel-sql/sdk';
import type {
  CheckpointInfo,
  RecordingInfo,
  ReplayLimits,
  Position,
  Selection,
  SnapshotRow,
  Page,
  PageRequest,
} from '@time-travel-sql/sdk';
import { readRecord, encode } from './integrity.js';
import { collect } from './reader.js';
import type { Reader } from './reader.js';
import { HistoryScan } from './history-scan.js';
import { ReplayWork } from './replay-work.js';
import type { SQLOutputValue } from 'node:sqlite';

/** Derived artifacts only: publication always reconstructs authoritative history. */
export class Checkpoints {
  #verified:
    | { signature: string; version: SQLOutputValue | undefined }
    | undefined;
  constructor(
    readonly reader: Reader,
    readonly limits: ReplayLimits,
  ) {}

  private info(
    recording: RecordingInfo,
    position: Position,
    work?: ReplayWork,
  ): CheckpointInfo {
    const stored = this.reader.db
      .prepare('SELECT * FROM checkpoints WHERE recording_id=? AND position=?')
      .get(recording.id, position.padStart(40, '0'));
    const info = decodeCheckpointInfo(recording, readRecord(stored, work));
    if (info.position !== position)
      throw new HistoryError(
        'INVALID_HISTORY',
        'Checkpoint position does not match its index.',
      );
    return info;
  }

  private *rows(
    recording: RecordingInfo,
    checkpoint: CheckpointInfo,
    work: ReplayWork,
  ): Iterable<SnapshotRow> {
    const hash = createHash('sha256');
    let count = 0;
    for (const stored of this.reader.db
      .prepare(
        'SELECT * FROM checkpoint_rows WHERE recording_id=? AND position=? ORDER BY key',
      )
      .iterate(recording.id, checkpoint.position.padStart(40, '0'))) {
      work.row();
      const row = this.reader.snapshotRow(recording, stored, work);
      hash.update(JSON.stringify([stored.key, stored.digest]) + '\n');
      count++;
      yield row;
    }
    if (
      count !== checkpoint.rowCount ||
      hash.digest('hex') !== checkpoint.checksum
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Checkpoint completeness check failed.',
      );
  }

  private baseline(
    recording: RecordingInfo,
    position: Position,
    work: ReplayWork = new ReplayWork(),
  ): { state: HistoryState; scan: HistoryScan } {
    const scan = new HistoryScan(this.reader, recording, work);
    let state = HistoryState.fromSnapshot(
      recording.recording,
      recording.baselinePosition,
      scan.baseline(),
      this.limits,
    );
    for (const transaction of scan.commitsThrough(position))
      state = state.apply(transaction);
    return { state, scan };
  }

  restore(recording: RecordingInfo, position: Position): HistoryState {
    const work = new ReplayWork();
    const candidates = this.reader.db
      .prepare(
        'SELECT position FROM checkpoints WHERE recording_id=? AND position<=? ORDER BY position DESC',
      )
      .iterate(recording.id, position.padStart(40, '0'));
    for (const candidate of candidates) {
      work.candidate();
      let checkpoint: CheckpointInfo;
      let state: HistoryState;
      try {
        if (typeof candidate.position !== 'string')
          throw new HistoryError(
            'INVALID_HISTORY',
            'Invalid checkpoint index.',
          );
        checkpoint = this.info(
          recording,
          decodePosition(candidate.position.replace(/^0+(?=.)/, '')),
          work,
        );
        state = HistoryState.fromSnapshot(
          recording.recording,
          checkpoint.position,
          this.rows(recording, checkpoint, work),
          this.limits,
        );
      } catch (error) {
        if (
          !(error instanceof HistoryError) ||
          error.code === 'LIMIT_EXCEEDED' ||
          error.code === 'STORAGE_FAILURE' ||
          error.code === 'CANCELLED'
        )
          throw error;
        continue;
      }
      const scan = this.authority(recording, checkpoint, work);
      if (!scan) continue;
      for (const transaction of scan.commitsThrough(position))
        state = state.apply(transaction);
      return state;
    }
    return this.baseline(recording, position, work).state;
  }

  private authority(
    recording: RecordingInfo,
    checkpoint: CheckpointInfo,
    work: ReplayWork,
  ): HistoryScan | null {
    const scan = new HistoryScan(this.reader, recording, work);
    scan.verifyPrefix(checkpoint.position);
    return scan.count === checkpoint.transactionCount &&
      scan.checksum === checkpoint.historyChecksum
      ? scan
      : null;
  }

  private verifyPublicRead(
    recording: RecordingInfo,
    checkpoint: CheckpointInfo,
    work: ReplayWork,
  ): void {
    const signature = JSON.stringify([recording, checkpoint]);
    const version = this.reader.db
      .prepare('PRAGMA data_version')
      .get()?.data_version;
    if (
      this.#verified?.signature === signature &&
      this.#verified.version === version
    )
      return;
    for (const row of this.rows(recording, checkpoint, work)) void row;
    if (!this.authority(recording, checkpoint, work))
      throw new HistoryError(
        'INVALID_HISTORY',
        'Checkpoint does not match authoritative history.',
      );
    this.#verified = { signature, version };
  }

  publishCheckpoint(id: string, input: Selection): CheckpointInfo {
    const work = new ReplayWork();
    const recording = this.reader.published(id, work);
    const selection = decodeSelection(input);
    const position = selectedPosition(
      recording,
      selection,
      selection.kind === 'baseline'
        ? undefined
        : this.reader.transaction(id, selection.position, work),
    );
    const { state, scan } = this.baseline(recording, position, work);
    const key = position.padStart(40, '0');
    this.reader.db
      .prepare('DELETE FROM checkpoints WHERE recording_id=? AND position=?')
      .run(id, key);
    const placeholder = encode({});
    this.reader.db
      .prepare(
        'INSERT INTO checkpoints(recording_id,position,data,digest) VALUES(?,?,?,?)',
      )
      .run(id, key, placeholder.data, placeholder.digest);
    for (const table of recording.recording.schema.tables) {
      for (const row of state.rows(table.id)) {
        const encoded = encode({ tableId: table.id, row });
        this.reader.db
          .prepare(
            'INSERT INTO checkpoint_rows(recording_id,position,key,data,digest) VALUES(?,?,?,?,?)',
          )
          .run(
            id,
            key,
            rowKey(recording.recording, table, row),
            encoded.data,
            encoded.digest,
          );
      }
    }
    const hash = createHash('sha256');
    for (const row of this.reader.db
      .prepare(
        'SELECT key,digest FROM checkpoint_rows WHERE recording_id=? AND position=? ORDER BY key',
      )
      .iterate(id, key))
      hash.update(JSON.stringify([row.key, row.digest]) + '\n');
    const info = decodeCheckpointInfo(recording, {
      version: 1,
      recordingId: id,
      sourceId: recording.recording.sourceId,
      epochId: recording.recording.epochId,
      schemaId: recording.recording.schema.id,
      position,
      transactionCount: scan.count,
      rowCount: state.rowCount,
      checksum: hash.digest('hex'),
      historyChecksum: scan.checksum,
    });
    const encoded = encode(info);
    this.reader.db
      .prepare(
        'UPDATE checkpoints SET data=?,digest=? WHERE recording_id=? AND position=?',
      )
      .run(encoded.data, encoded.digest, id, key);
    return info;
  }

  checkpoints(id: string, input: PageRequest): Page<CheckpointInfo> {
    const recording = this.reader.published(id);
    const page = decodePageRequest(input);
    const cursor =
      page.cursor === null ? '' : decodePosition(page.cursor).padStart(40, '0');
    const records = this.reader.db
      .prepare(
        'SELECT * FROM checkpoints WHERE recording_id=? AND position>? ORDER BY position LIMIT ?',
      )
      .iterate(id, cursor, page.limit + 1);
    return collect(records, page.limit, (stored) => {
      const value = decodeCheckpointInfo(recording, readRecord(stored));
      if (value.position.padStart(40, '0') !== stored.position)
        throw new HistoryError(
          'INVALID_HISTORY',
          'Checkpoint position does not match its index.',
        );
      return { value, cursor: value.position };
    });
  }

  checkpointRows(
    id: string,
    position: Position,
    input: PageRequest,
  ): Page<SnapshotRow> {
    const work = new ReplayWork();
    const recording = this.reader.published(id, work);
    const checkpoint = this.info(recording, decodePosition(position), work);
    const page = decodePageRequest(input);
    const key = position.padStart(40, '0');
    this.verifyPublicRead(recording, checkpoint, work);
    const records = this.reader.db
      .prepare(
        'SELECT * FROM checkpoint_rows WHERE recording_id=? AND position=? AND key>? ORDER BY key LIMIT ?',
      )
      .iterate(id, key, page.cursor ?? '', page.limit + 1);
    return collect(records, page.limit, (stored) => ({
      value: this.reader.snapshotRow(recording, stored, work),
      cursor: String(stored.key),
    }));
  }

  removeCheckpoint(id: string, position: Position): void {
    this.reader.info(id);
    this.reader.db
      .prepare('DELETE FROM checkpoints WHERE recording_id=? AND position=?')
      .run(id, decodePosition(position).padStart(40, '0'));
  }
}
