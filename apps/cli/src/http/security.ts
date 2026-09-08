import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function authorize(
  request: IncomingMessage,
  origin: string,
  token: string,
): void {
  if (request.rawHeaders.length > 80)
    throw new HttpError(400, 'INVALID_REQUEST', 'Too many request headers.');
  const authority = new URL(origin).host;
  if (
    request.headers.host !== authority ||
    (request.headers.origin !== undefined &&
      request.headers.origin !== origin) ||
    (request.headers['sec-fetch-site'] !== undefined &&
      !['same-origin', 'none'].includes(
        String(request.headers['sec-fetch-site']),
      ))
  )
    throw new HttpError(
      403,
      'ORIGIN_REJECTED',
      'Use the local application address.',
    );
  // Duplicate security headers are invalid even when the HTTP parser selects one.
  for (const name of ['host', 'origin', 'authorization', 'content-type']) {
    let count = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2)
      if (request.rawHeaders[index]?.toLowerCase() === name) count++;
    if (count > 1)
      throw new HttpError(400, 'INVALID_REQUEST', 'Repeated security header.');
  }
  const expected = Buffer.from('Bearer ' + token);
  const supplied = Buffer.from(request.headers.authorization ?? '');
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    throw new HttpError(
      401,
      'SESSION_REQUIRED',
      'Open the current local session.',
    );
}
