import { HistoryError } from './errors.js';
import { decimalIdentity, validateNumeric } from './decimal.js';
import { boundedText } from './validation.js';

type JsonNode =
  | null
  | boolean
  | string
  | { readonly number: string }
  | readonly JsonNode[]
  | { readonly object: readonly (readonly [string, JsonNode])[] };

/** Validation and JSONB equality without ever parsing a JSON number as JS number. */
export function canonicalJson(text: string, type: 'json' | 'jsonb'): string {
  let offset = 0;
  let nodes = 0;
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const invalid = (): never => {
    throw new HistoryError('INVALID_VALUE', 'Invalid JSON data.');
  };
  const whitespace = () => {
    while (' \t\r\n'.includes(text[offset] ?? '\0')) offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const token = text[offset++];
      if (token === '\\') offset++;
      else if (token === '"') {
        try {
          const value: unknown = JSON.parse(text.slice(start, offset));
          if (typeof value !== 'string') return invalid();
          if (type === 'jsonb') boundedText(value);
          return value;
        } catch (cause) {
          throw new HistoryError('INVALID_VALUE', 'Invalid JSON string.', {
            cause,
          });
        }
      }
    }
    return invalid();
  };
  const read = (depth: number): JsonNode => {
    if (depth > 64 || ++nodes > 100000)
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'JSON exceeds depth or node limits.',
      );
    whitespace();
    const token = text[offset];
    if (token === '"') return string();
    if (token === '[') {
      offset++;
      const items: JsonNode[] = [];
      whitespace();
      if (text[offset] === ']') {
        offset++;
        return items;
      }
      while (true) {
        items.push(read(depth + 1));
        whitespace();
        const delimiter = text[offset++];
        if (delimiter === ']') return items;
        if (delimiter !== ',') return invalid();
      }
    }
    if (token === '{') {
      offset++;
      const entries = new Map<string, JsonNode>();
      whitespace();
      if (text[offset] === '}') {
        offset++;
        return { object: [] };
      }
      while (true) {
        whitespace();
        if (text[offset] !== '"') return invalid();
        const key = string();
        whitespace();
        if (text[offset++] !== ':') return invalid();
        entries.set(key, read(depth + 1));
        whitespace();
        const delimiter = text[offset++];
        if (delimiter === '}')
          return {
            object: [...entries].sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          };
        if (delimiter !== ',') return invalid();
      }
    }
    for (const [literal, value] of [
      ['null', null],
      ['true', true],
      ['false', false],
    ] as const) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return value;
      }
    }
    number.lastIndex = offset;
    const match = number.exec(text);
    if (!match) return invalid();
    offset = number.lastIndex;
    if (type === 'jsonb') validateNumeric(match[0]);
    return { number: type === 'jsonb' ? decimalIdentity(match[0]) : match[0] };
  };
  const result = read(0);
  whitespace();
  if (offset !== text.length) return invalid();
  return JSON.stringify(result);
}
