import type {
  RecordingInfo,
  SnapshotRow,
  Page,
  PageRequest,
} from '../domain/recordings.js';
import type { CancellationSignal } from './reconstruction.js';
import type { CommittedTransaction } from '../domain/events.js';
import type { Position } from '../domain/position.js';

/** One immutable view of authoritative history until close. No source connections. */
export interface RecordingExportView {
  readonly info: RecordingInfo;
  /** Strictly ascending UTF-8 rowKey byte order; cursor belongs to this session. */
  baseline(page: PageRequest): Promise<Page<SnapshotRow>>;
  /** Strictly ascending committed positions; cursor belongs to this session. */
  transactions(page: PageRequest): Promise<Page<CommittedTransaction>>;
  /** Exact committed boundary in this snapshot; missing positions reject. */
  transaction(position: Position): Promise<CommittedTransaction>;
}

export interface RecordingExport extends RecordingExportView {
  close(): Promise<void>;
}

export interface HistoryExports {
  open(
    recordingId: string,
    signal?: CancellationSignal,
  ): Promise<RecordingExport>;
  close(): Promise<void>;
}
