import {
  HistoryError,
  decodeRecordingName,
  decodeDataFields,
  decodePageRequest,
  decodePosition,
  decodeQueryRequest,
  decodeSelection,
  decodeStableId,
} from '@time-travel-sql/sdk';
import type {
  CommittedTransaction,
  Page,
  PageRequest,
  Position,
  QueryRequest,
  QueryResult,
  RecordingInfo,
  Selection,
} from '@time-travel-sql/sdk';

export const API_VERSION = 1;
export const API_PATH = '/api/v1/operations';
export const API_LIMITS = Object.freeze({
  requestBytes: 131072,
  responseBytes: 16 * 1048576,
  activeRequests: 2,
  connections: 16,
  timeoutMs: 30000,
});

export type ApiRequest = { readonly version: 1 } & (
  | { readonly operation: 'sample' }
  | { readonly operation: 'list'; readonly page: PageRequest }
  | { readonly operation: 'inspect' | 'remove'; readonly recordingId: string }
  | {
      readonly operation: 'rename';
      readonly recordingId: string;
      readonly name: string;
    }
  | {
      readonly operation: 'transactions';
      readonly recordingId: string;
      readonly page: PageRequest;
    }
  | {
      readonly operation: 'transaction';
      readonly recordingId: string;
      readonly position: Position;
    }
  | {
      readonly operation: 'query';
      readonly recordingId: string;
      readonly selection: Selection;
      readonly query: QueryRequest;
    }
);

/** Stable transport projection; storage bookkeeping is not an HTTP contract. */
export interface RecordingView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly sourceId: string;
  readonly epochId: string;
  readonly schema: RecordingInfo['recording']['schema'];
  readonly status: RecordingInfo['status'];
  readonly derivation: RecordingInfo['recording']['derivation'] | null;
  readonly baselinePosition: Position | null;
  readonly headPosition: Position | null;
  readonly transactionCount: number;
}
export interface ApiResults {
  readonly sample: RecordingView;
  readonly list: Page<RecordingView>;
  readonly inspect: RecordingView;
  readonly rename: RecordingView;
  readonly remove: { readonly recordingId: string; readonly removed: true };
  readonly transactions: {
    readonly recordingId: string;
    readonly page: Page<CommittedTransaction>;
  };
  readonly transaction: {
    readonly recordingId: string;
    readonly transaction: CommittedTransaction;
  };
  readonly query: QueryResult & {
    readonly recordingId: string;
    readonly selection: Selection;
    readonly position: Position;
    readonly elapsedMs: number;
    readonly limits: QueryRequest['limits'];
  };
}
export type ApiSuccess = {
  [K in keyof ApiResults]: {
    readonly version: 1;
    readonly ok: true;
    readonly operation: K;
    readonly data: ApiResults[K];
  };
}[keyof ApiResults];
export interface ApiFailure {
  readonly version: 1;
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

export function recordingView(info: RecordingInfo): RecordingView {
  return Object.freeze({
    id: info.id,
    name: info.name,
    createdAt: info.createdAt,
    sourceId: info.recording.sourceId,
    epochId: info.recording.epochId,
    schema: info.recording.schema,
    status: info.status,
    derivation: info.recording.derivation ?? null,
    baselinePosition: info.baselinePosition,
    headPosition: info.headPosition,
    transactionCount: info.transactionCount,
  });
}

export function decodeApiRequest(input: unknown): ApiRequest {
  const envelope = decodeDataFields(input, [
    'version',
    'operation',
    'recordingId',
    'name',
    'page',
    'position',
    'selection',
    'query',
  ]);
  if (envelope.version !== API_VERSION)
    throw new HistoryError('INVALID_VALUE', 'Unsupported API version.');
  const version = API_VERSION;
  const fields = (...names: string[]) =>
    decodeDataFields(input, ['version', 'operation', ...names]);
  switch (envelope.operation) {
    case 'sample':
      fields();
      return { version, operation: 'sample' };
    case 'list':
      return {
        version,
        operation: 'list',
        page: decodePageRequest(fields('page').page),
      };
    case 'inspect':
    case 'remove':
      return {
        version,
        operation: envelope.operation,
        recordingId: decodeStableId(fields('recordingId').recordingId),
      };
    case 'rename': {
      const data = fields('recordingId', 'name');
      return {
        version,
        operation: 'rename',
        recordingId: decodeStableId(data.recordingId),
        name: decodeRecordingName(data.name),
      };
    }
    case 'transactions': {
      const data = fields('recordingId', 'page');
      return {
        version,
        operation: 'transactions',
        recordingId: decodeStableId(data.recordingId),
        page: decodePageRequest(data.page),
      };
    }
    case 'transaction': {
      const data = fields('recordingId', 'position');
      return {
        version,
        operation: 'transaction',
        recordingId: decodeStableId(data.recordingId),
        position: decodePosition(data.position),
      };
    }
    case 'query': {
      const data = fields('recordingId', 'selection', 'query');
      return {
        version,
        operation: 'query',
        recordingId: decodeStableId(data.recordingId),
        selection: decodeSelection(data.selection),
        query: decodeQueryRequest(data.query),
      };
    }
    default:
      throw new HistoryError('INVALID_VALUE', 'Unsupported API operation.');
  }
}
