import type { RecordingSchema } from '../domain/schema.js';
import type { Position } from '../domain/position.js';
import type { CommittedTransaction } from '../domain/events.js';

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
  status(): SourceStreamStatus;
  /** Cancels pending reads, discards unconfirmed work and releases connections. */
  close(): Promise<void>;
}
