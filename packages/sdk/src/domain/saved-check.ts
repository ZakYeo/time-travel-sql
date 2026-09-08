import { HistoryError } from './errors.js';
import { boundedText, identityText, objectFields } from './validation.js';
import { decodeQueryRequest } from './query.js';
import type { QueryRequest } from './query.js';

export interface SavedCheck {
  readonly id: string;
  readonly name: string;
  readonly query: QueryRequest;
}

/** Saving a definition does not execute it or imply SQL policy approval. */
export function decodeSavedCheck(input: unknown): SavedCheck {
  const data = objectFields(input, ['id', 'name', 'query']);
  const name = boundedText(data.name, 256);
  if (!name.trim())
    throw new HistoryError(
      'INVALID_VALUE',
      'Saved check name must not be empty.',
    );
  return Object.freeze({
    id: identityText(data.id),
    name,
    query: decodeQueryRequest(data.query),
  });
}
