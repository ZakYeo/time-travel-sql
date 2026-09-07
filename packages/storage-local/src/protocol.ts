import type {
  HistoryReader,
  HistoryWriter,
  RecordingManagement,
  ErrorCode,
  HistoryCheckpoints,
} from '@time-travel-sql/sdk';

export type LocalStore = HistoryReader &
  HistoryWriter &
  RecordingManagement &
  HistoryCheckpoints;
export type Method = Exclude<keyof LocalStore, 'close'>;
export type Command = {
  [K in Method]: {
    readonly method: K;
    readonly args: Parameters<LocalStore[K]>;
  };
}[Method];
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
