import { HistoryError } from './errors.js';
import { boundedText, objectFields } from './validation.js';
import { decimalIdentity, validateNumeric } from './decimal.js';
import { canonicalJson } from './lossless-json.js';
import { canonicalDate, canonicalTimestamp } from './temporal.js';

export const scalarTypes = [
  'bool',
  'int2',
  'int4',
  'int8',
  'numeric',
  'text',
  'varchar',
  'uuid',
  'date',
  'timestamp',
  'timestamptz',
  'json',
  'jsonb',
  'bytea',
] as const;
export type ScalarType = (typeof scalarTypes)[number];
export type ScalarValue = Readonly<{
  kind: 'scalar';
  type: ScalarType;
  value: string;
}>;
export type Value =
  | ScalarValue
  | Readonly<{ kind: 'null' }>
  | Readonly<{ kind: 'unavailable'; reason: 'redacted' | 'excluded' }>;

export function decodeScalarType(input: unknown): ScalarType {
  for (const type of scalarTypes) if (type === input) return type;
  throw new HistoryError('INVALID_VALUE', 'Unsupported scalar type.');
}

const integerBounds = {
  int2: [-32768n, 32767n],
  int4: [-2147483648n, 2147483647n],
  int8: [-9223372036854775808n, 9223372036854775807n],
} as const;

export function scalarValue(type: ScalarType, input: string): ScalarValue {
  decodeScalarType(type);
  let value = boundedText(input);
  switch (type) {
    case 'int2':
    case 'int4':
    case 'int8': {
      if (!/^-?(0|[1-9][0-9]{0,18})$/.test(value))
        throw new HistoryError('INVALID_VALUE', 'Invalid integer value.');
      const integer = BigInt(value);
      const [minimum, maximum] = integerBounds[type];
      if (integer < minimum || integer > maximum)
        throw new HistoryError(
          'INVALID_VALUE',
          'Integer exceeds its type bounds.',
        );
      value = integer.toString();
      break;
    }
    case 'numeric':
      if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value))
        throw new HistoryError(
          'INVALID_VALUE',
          'Expected a finite numeric value without exponent notation.',
        );
      validateNumeric(value);
      break;
    case 'bool':
      if (!['t', 'f', 'true', 'false'].includes(value))
        throw new HistoryError('INVALID_VALUE', 'Invalid boolean value.');
      value = value === 't' || value === 'true' ? 'true' : 'false';
      break;
    case 'uuid':
      if (
        !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
          value,
        )
      )
        throw new HistoryError('INVALID_VALUE', 'Invalid UUID.');
      value = value.toLowerCase();
      break;
    case 'date':
      value = canonicalDate(value);
      break;
    case 'timestamp':
      value = canonicalTimestamp(value, false);
      break;
    case 'timestamptz':
      value = canonicalTimestamp(value, true);
      break;
    case 'json':
    case 'jsonb':
      canonicalJson(value, type);
      break;
    case 'bytea':
      if (!/^\\x(?:[0-9a-fA-F]{2})*$/.test(value))
        throw new HistoryError('INVALID_VALUE', 'Expected hexadecimal bytea.');
      value = value.toLowerCase();
      break;
    case 'text':
    case 'varchar':
      break;
  }
  return Object.freeze({ kind: 'scalar', type, value });
}

export function decodeValue(input: unknown): Value {
  const data = objectFields(input, ['kind', 'type', 'value', 'reason']);
  if (data.kind === 'null' && Object.keys(data).length === 1)
    return Object.freeze({ kind: 'null' });
  if (
    data.kind === 'unavailable' &&
    Object.keys(data).length === 2 &&
    (data.reason === 'redacted' || data.reason === 'excluded')
  )
    return Object.freeze({ kind: 'unavailable', reason: data.reason });
  if (data.kind === 'scalar' && Object.keys(data).length === 3)
    return scalarValue(decodeScalarType(data.type), boundedText(data.value));
  throw new HistoryError('INVALID_VALUE', 'Invalid canonical value.');
}

/** Typed SQL equality identity, distinct from the preserved display representation. */
export function valueIdentity(value: ScalarValue): string {
  const canonical =
    value.type === 'numeric'
      ? decimalIdentity(value.value)
      : value.type === 'jsonb'
        ? canonicalJson(value.value, 'jsonb')
        : value.value;
  return JSON.stringify([value.type, canonical]);
}
