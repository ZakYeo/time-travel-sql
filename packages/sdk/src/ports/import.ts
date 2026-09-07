import type {
  RecordingInfo,
  RecordingMetadata,
  SnapshotRow,
} from '../domain/recordings.js';
import type { CommittedTransaction } from '../domain/events.js';
import type { Position } from '../domain/position.js';
import type { CancellationSignal } from './reconstruction.js';

/** Private, bounded staging. No staged data is visible through HistoryReader. */
export interface RecordingImport {
  stageBaseline(rows: readonly SnapshotRow[]): Promise<void>;
  publishBaseline(position: Position): Promise<void>;
  append(transaction: CommittedTransaction): Promise<void>;
  /** Revalidates complete authoritative history and exact expected coverage before
   * atomic publication. Existing IDs must be rejected, never replaced. The signal
   * is checked through preparation, up to the publication commit boundary.
   */
  publish(expected: RecordingInfo): Promise<RecordingInfo>;
  /** Discards staging only. Idempotent; never removes a published recording. */
  close(): Promise<void>;
}

export interface HistoryImports {
  beginImport(
    metadata: RecordingMetadata,
    signal: CancellationSignal,
  ): Promise<RecordingImport>;
}
