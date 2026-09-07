import { HistoryError } from './errors.js';

export function objectFields(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new HistoryError('INVALID_VALUE', 'Expected an object.');
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new HistoryError('INVALID_VALUE', 'Expected a plain data object.');
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !fields.includes(key))
      throw new HistoryError('INVALID_VALUE', 'Unexpected data field.');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor))
      throw new HistoryError(
        'INVALID_VALUE',
        'Accessor properties are not data.',
      );
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
    });
  }
  return result;
}

export function utf8Bytes(input: string, maxBytes = 1048576): number {
  if (input.length > maxBytes)
    throw new HistoryError(
      'LIMIT_EXCEEDED',
      'Text exceeds its encoded byte limit.',
    );
  let bytes = 0;
  for (const character of input) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0 || (code >= 0xd800 && code <= 0xdfff))
      throw new HistoryError(
        'INVALID_VALUE',
        'Text contains unsupported Unicode or NUL.',
      );
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > maxBytes)
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Text exceeds its encoded byte limit.',
      );
  }
  return bytes;
}

export function boundedText(input: unknown, maxBytes = 1048576): string {
  if (typeof input !== 'string')
    throw new HistoryError('INVALID_VALUE', 'Expected bounded text.');
  utf8Bytes(input, maxBytes);
  return input;
}

export function boundedArray(
  input: unknown,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(input) || input.length > maximum)
    throw new HistoryError('INVALID_VALUE', 'Expected a bounded array.');
  if (Reflect.ownKeys(input).length !== input.length + 1)
    throw new HistoryError(
      'INVALID_VALUE',
      'Arrays must contain only dense data elements.',
    );
  const values: unknown[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !('value' in descriptor))
      throw new HistoryError(
        'INVALID_VALUE',
        'Array accessors and sparse entries are not data.',
      );
    values.push(descriptor.value);
  }
  return values;
}

export function identityText(input: unknown): string {
  const value = boundedText(input, 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(value))
    throw new HistoryError('INVALID_VALUE', 'Invalid stable identity.');
  return value;
}
