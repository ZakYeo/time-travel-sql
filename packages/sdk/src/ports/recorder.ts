import type { RecordingInfo } from '../domain/recordings.js';

/** Owns the supplied source stream; the caller still owns storage and source leases. */
export interface RecordingSession {
  readonly done: Promise<RecordingInfo>;
  /** Cancels reads, drains an accepted append, then persists stopped status.
   * Rejects if capture, persistence or cleanup failed. Idempotent.
   */
  stop(): Promise<RecordingInfo>;
}
