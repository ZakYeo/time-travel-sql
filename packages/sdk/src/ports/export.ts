import type {
  RecordingInfo,
  SnapshotRow,
  Page,
  PageRequest,
} from '../domain/recordings.js';
import type { CancellationSignal } from './reconstruction.js';
import type { CommittedTransaction } from '../domain/events.js';

/** One immutable view of authoritative history until close. No source connections. */
export interface RecordingExport {
  readonly info: RecordingInfo;
  /** Strictly ascending UTF-8 rowKey byte order; cursor belongs to this session. */
  baseline(page: PageRequest): Promise<Page<SnapshotRow>>;
  /** Strictly ascending committed positions; cursor belongs to this session. */
  transactions(page: PageRequest): Promise<Page<CommittedTransaction>>;
  close(): Promise<void>;
}

export interface HistoryExports {
  open(
    recordingId: string,
    signal?: CancellationSignal,
  ): Promise<RecordingExport>;
  close(): Promise<void>;
}
