export type ErrorCode =
  | 'INVALID_POSITION'
  | 'INVALID_VALUE'
  | 'INVALID_SCHEMA'
  | 'INVALID_EVENT'
  | 'INVALID_HISTORY'
  | 'LIMIT_EXCEEDED'
  | 'STORAGE_FAILURE'
  | 'SOURCE_UNAVAILABLE'
  | 'CANCELLED'
  | 'QUERY_REJECTED'
  | 'QUERY_FAILURE';

/** Safe public diagnostic. Never embed raw source values or credentials. */
export class HistoryError extends Error {
  override readonly name = 'HistoryError';

  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
