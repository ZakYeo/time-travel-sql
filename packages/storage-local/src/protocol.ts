import type {
  HistoryReader,
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
  HistoryWriter &
  RecordingManagement &
  HistoryCheckpoints;
export type Method = Exclude<keyof LocalStore, 'close'>;
interface ReconstructionOperations {
  reconstructionRows(tableId: string, page: PageRequest): Promise<Page<Row>>;
}
export type WorkerOperations = Omit<LocalStore, 'close'> &
  ReconstructionOperations;
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
