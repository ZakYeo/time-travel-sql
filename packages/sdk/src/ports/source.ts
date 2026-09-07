import type { RecordingSchema } from '../domain/schema.js';
import type { Position } from '../domain/position.js';
import type { CommittedTransaction } from '../domain/events.js';
import type { SnapshotRow } from '../domain/recordings.js';
import type { CaptureBinding } from '../domain/capture-binding.js';

/** Read-only preparation; opening may allocate persistent source resources.
 * A rejected open must close its connections; persistent resources remain explicit.
 */
export interface SourceCapturePlan {
  readonly recording: RecordingSchema;
  readonly binding: CaptureBinding;
  openBaseline(): Promise<SourceBaseline>;
}

/** A consistent baseline at one source boundary; the consumer owns close(). */
export interface SourceBaseline {
  readonly recording: RecordingSchema;
  readonly position: Position;
  /** One outstanding read. Nonempty batches contain at most 100 rows/16 MiB.
   * null certifies complete capture, including successful source-side cleanup.
   * Cancellation/failure rejects; it must never be represented by null.
   */
  next(): Promise<readonly SnapshotRow[] | null>;
  /** Idempotent, cancels pending reads and releases owned source resources. */
  close(): Promise<void>;
}

export interface SourceStreamStatus {
  readonly state: 'streaming' | 'waiting-for-durable' | 'closed' | 'failed';
  readonly durablePosition: Position;
  readonly receivedPosition: Position;
}

/** One owned ordered stream starting from verified durable recording state. */
export interface SourceStream {
  readonly recording: RecordingSchema;
  /** One outstanding next call; acknowledge its result before requesting another. */
  next(): Promise<CommittedTransaction>;
  /** Call only after this exact transaction has been durably appended. */
  acknowledge(position: Position): Promise<void>;
  /** Terminal failures must be reflected here before pending operations reject. */
  status(): SourceStreamStatus;
  /** Cancels pending reads, discards unconfirmed work and releases connections. */
  close(): Promise<void>;
}
