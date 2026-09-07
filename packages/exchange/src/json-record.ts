import { HistoryError } from '@time-travel-sql/sdk';
import type { ExchangeLimits } from './limits.js';

/** Bound parser work before JSON.parse allocates the object graph. */
export function parseRecord(text: string, limits: ExchangeLimits): unknown {
  let depth = 0;
  let tokens = 0;
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if ('[{:,'.includes(character)) {
      if (character === '[' || character === '{') depth++;
      if (++tokens > limits.maxStructuralTokens || depth > limits.maxDepth)
        throw new HistoryError(
          'LIMIT_EXCEEDED',
          'Recording JSON exceeds its structural budget.',
        );
    } else if (character === ']' || character === '}') depth--;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new HistoryError('INVALID_HISTORY', 'Invalid recording JSON.', {
      cause,
    });
  }
  // Strict JSON.stringify spelling rejects duplicate keys, whitespace, unsafe
  // number rounding and alternate escapes. Ordinary member order is preserved.
  if (JSON.stringify(value) !== text)
    throw new HistoryError(
      'INVALID_HISTORY',
      'Recording JSON is not canonically encoded.',
    );
  return value;
}
