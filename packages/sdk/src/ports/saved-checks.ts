import type { SavedCheck } from '../domain/saved-check.js';
import type { Page, PageRequest } from '../domain/recordings.js';
import type { RecordingExport, HistoryExports } from './export.js';
import type { CancellationSignal } from './reconstruction.js';

export interface SavedCheckHistory extends RecordingExport {
  /** Definition pinned with history; concurrent replacement cannot change it. */
  savedCheck(checkId: string): Promise<SavedCheck>;
}
export interface SavedCheckHistories extends HistoryExports {
  open(
    recordingId: string,
    signal?: CancellationSignal,
  ): Promise<SavedCheckHistory>;
}

export interface SavedChecks {
  /** Explicitly creates or replaces one recording-scoped definition atomically. */
  saveCheck(recordingId: string, check: SavedCheck): Promise<SavedCheck>;
  savedCheck(recordingId: string, checkId: string): Promise<SavedCheck>;
  savedChecks(
    recordingId: string,
    page: PageRequest,
  ): Promise<Page<SavedCheck>>;
  removeCheck(recordingId: string, checkId: string): Promise<void>;
}
