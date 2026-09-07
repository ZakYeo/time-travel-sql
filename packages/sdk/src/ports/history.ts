import type {
  RecordingMetadata,
  RecordingInfo,
  RecordingStatus,
  SnapshotRow,
  PageRequest,
  Page,
} from '../domain/recordings.js';
import type { CommittedTransaction } from '../domain/events.js';
import type { Position } from '../domain/position.js';
import type { CheckpointInfo } from '../domain/checkpoints.js';
import type { Selection } from '../domain/selection.js';

export interface HistoryCheckpoints {
  publishCheckpoint(id: string, selection: Selection): Promise<CheckpointInfo>;
  checkpoints(id: string, page: PageRequest): Promise<Page<CheckpointInfo>>;
  checkpointRows(
    id: string,
    position: Position,
    page: PageRequest,
  ): Promise<Page<SnapshotRow>>;
  removeCheckpoint(id: string, position: Position): Promise<void>;
}

export interface HistoryWriter {
  create(metadata: RecordingMetadata): Promise<RecordingInfo>;
  stageBaseline(id: string, rows: readonly SnapshotRow[]): Promise<void>;
  publishBaseline(id: string, position: Position): Promise<RecordingInfo>;
  append(
    id: string,
    transaction: CommittedTransaction,
  ): Promise<'appended' | 'duplicate'>;
  setStatus(id: string, status: RecordingStatus): Promise<RecordingInfo>;
}

export interface HistoryReader {
  info(id: string): Promise<RecordingInfo>;
  list(page: PageRequest): Promise<Page<RecordingInfo>>;
  baseline(id: string, page: PageRequest): Promise<Page<SnapshotRow>>;
  transactions(
    id: string,
    page: PageRequest,
  ): Promise<Page<CommittedTransaction>>;
  transaction(id: string, position: Position): Promise<CommittedTransaction>;
}

export interface RecordingManagement {
  rename(id: string, name: string): Promise<RecordingInfo>;
  remove(id: string): Promise<void>;
  close(): Promise<void>;
}
