import type {
  HistoryReader,
  HistoryImports,
  RecordingMetadata,
  RecordingInfo,
  SnapshotRow,
  CommittedTransaction,
  Position,
  HistoryCaptureBindings,
  HistoryRecordingOwnership,
  HistoryWriter,
  RecordingManagement,
  ErrorCode,
  HistoryCheckpoints,
  PageRequest,
  Page,
  Row,
  ReconstructionRequest,
} from '@time-travel-sql/sdk';
import type { LocalStoreOptions } from './database.js';
import { HistoryError } from '@time-travel-sql/sdk';

export type LocalStore = HistoryReader &
  HistoryImports &
  HistoryRecordingOwnership &
  HistoryCaptureBindings &
  HistoryWriter &
  RecordingManagement &
  HistoryCheckpoints;
interface OwnershipOperations {
  prepareRecording(id: string): Promise<string>;
  activateRecording(id: string, token: string): Promise<void>;
  releaseRecording(id: string, token: string): Promise<void>;
  fencedAppend(
    id: string,
    token: string,
    transaction: Parameters<HistoryWriter['append']>[1],
  ): ReturnType<HistoryWriter['append']>;
  fencedSetStatus(
    id: string,
    token: string,
    status: Parameters<HistoryWriter['setStatus']>[1],
  ): ReturnType<HistoryWriter['setStatus']>;
}
interface ImportOperations {
  beginImport(
    metadata: RecordingMetadata,
    cancellation: SharedArrayBuffer,
    root: string,
  ): Promise<string>;
  importBaseline(token: string, rows: readonly SnapshotRow[]): Promise<void>;
  importBaselineComplete(token: string, position: Position): Promise<void>;
  importAppend(token: string, transaction: CommittedTransaction): Promise<void>;
  publishImport(token: string, expected: RecordingInfo): Promise<RecordingInfo>;
  closeImport(token: string): Promise<void>;
}
type StoreOperations = Omit<
  LocalStore,
  'close' | 'prepareRecording' | 'beginImport'
> &
  OwnershipOperations &
  ImportOperations;
export type Method = keyof StoreOperations;
interface ReconstructionOperations {
  reconstructionRows(tableId: string, page: PageRequest): Promise<Page<Row>>;
}
export type WorkerOperations = StoreOperations & ReconstructionOperations;
export type Command = {
  [K in keyof WorkerOperations]: {
    readonly method: K;
    readonly args: Parameters<WorkerOperations[K]>;
  };
}[keyof WorkerOperations];
export type StoreCommand = Extract<Command, { readonly method: Method }>;
export type ReconstructionCommand = Extract<
  Command,
  { readonly method: keyof ReconstructionOperations }
>;
export type Startup =
  | { readonly kind: 'store'; readonly options: LocalStoreOptions }
  | {
      readonly kind: 'reconstruction';
      readonly options: LocalStoreOptions;
      readonly request: ReconstructionRequest;
    };
export interface Request {
  readonly id: number;
  readonly command: Command | { readonly method: 'close' };
}
export type Response =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | {
      readonly id: number;
      readonly ok: false;
      readonly code: ErrorCode;
      readonly message: string;
    };

export function failureResponse(id: number, error: unknown): Response {
  return {
    id,
    ok: false,
    code: error instanceof HistoryError ? error.code : 'STORAGE_FAILURE',
    message:
      error instanceof HistoryError
        ? error.message
        : 'Local history operation failed.',
  };
}
