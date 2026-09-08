import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  API_LIMITS,
  API_PATH,
  API_VERSION,
  decodeApiRequest,
} from '@time-travel-sql/contracts';
import { HistoryError } from '@time-travel-sql/sdk';
import { HttpError } from './security.js';

export async function readRequest(
  request: IncomingMessage,
  signal: AbortSignal,
) {
  if (request.url !== API_PATH)
    throw new HttpError(404, 'NOT_FOUND', 'Unknown API resource.');
  if (request.method !== 'POST')
    throw new HttpError(
      405,
      'METHOD_NOT_ALLOWED',
      'Use POST for API operations.',
    );
  if (
    request.headers['content-type'] !== 'application/json' ||
    request.headers['content-encoding'] !== undefined
  )
    throw new HttpError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Use uncompressed application/json.',
    );
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    signal.throwIfAborted();
    if (!Buffer.isBuffer(chunk))
      throw new HttpError(400, 'INVALID_REQUEST', 'Expected request bytes.');
    bytes += chunk.length;
    if (bytes > API_LIMITS.requestBytes)
      throw new HttpError(
        413,
        'LIMIT_EXCEEDED',
        'Request body exceeds the API limit.',
      );
    chunks.push(chunk);
  }
  signal.throwIfAborted();
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new HttpError(400, 'INVALID_REQUEST', 'Expected valid UTF-8 JSON.');
  }
  return decodeApiRequest(value);
}

export function respond(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > API_LIMITS.responseBytes)
    throw new HttpError(
      413,
      'LIMIT_EXCEEDED',
      'Response exceeds the API limit; request a smaller page or query.',
    );
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    Connection: 'close',
  });
  response.end(body);
}

export function failure(response: ServerResponse, error: unknown): void {
  if (response.destroyed || response.headersSent) return;
  const known = error instanceof HttpError || error instanceof HistoryError;
  respond(
    response,
    error instanceof HttpError
      ? error.status
      : error instanceof HistoryError
        ? 422
        : 500,
    {
      version: API_VERSION,
      ok: false,
      error: {
        code: known ? error.code : 'INTERNAL_ERROR',
        message: known
          ? error.message
          : 'Local operation failed; inspect the workspace and retry.',
      },
    },
  );
}
