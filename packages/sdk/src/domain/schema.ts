import { HistoryError } from './errors.js';
import { decodeRecordingDerivation } from './derivation.js';
import type { RecordingDerivation } from './derivation.js';
import {
  objectFields,
  boundedText,
  boundedArray,
  identityText,
  utf8Bytes,
} from './validation.js';
import {
  validateTypeModifier,
  validateModifiedValue,
} from './type-modifiers.js';
import { decodeScalarType, decodeValue, valueIdentity } from './values.js';
import type { ScalarType, Value } from './values.js';

export interface ColumnSchema {
  readonly name: string;
  readonly type: ScalarType;
  readonly nullable: boolean;
  readonly typeModifier: number;
  /** Unavailable by deterministic capture policy, including on empty tables. */
  readonly capture?: 'redacted' | 'excluded';
}
export interface TableSchema {
  readonly id: string;
  readonly namespace: string;
  readonly name: string;
  readonly columns: readonly ColumnSchema[];
  readonly primaryKey: readonly string[];
}
export interface Schema {
  readonly version: 1;
  readonly id: string;
  readonly tables: readonly TableSchema[];
}
export type Row = readonly Value[];

export interface RecordingSchema {
  readonly sourceId: string;
  readonly epochId: string;
  readonly schema: Schema;
  readonly derivation?: RecordingDerivation;
}

export function decodeRecordingSchema(input: unknown): RecordingSchema {
  const data = objectFields(input, [
    'sourceId',
    'epochId',
    'schema',
    'derivation',
  ]);
  return Object.freeze({
    sourceId: identityText(data.sourceId),
    epochId: identityText(data.epochId),
    schema: decodeSchema(data.schema),
    ...(data.derivation === undefined
      ? {}
      : { derivation: decodeRecordingDerivation(data.derivation) }),
  });
}

function name(input: unknown): string {
  const result = boundedText(input, 63);
  if (!result)
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Schema identifiers must not be empty.',
    );
  return result;
}

function column(input: unknown): ColumnSchema {
  const data = objectFields(input, [
    'name',
    'type',
    'nullable',
    'typeModifier',
    'capture',
  ]);
  if (
    typeof data.nullable !== 'boolean' ||
    typeof data.typeModifier !== 'number' ||
    !Number.isInteger(data.typeModifier) ||
    data.typeModifier < -1 ||
    data.typeModifier > 2147483647
  )
    throw new HistoryError('INVALID_SCHEMA', 'Invalid column metadata.');
  if (
    data.capture !== undefined &&
    data.capture !== 'redacted' &&
    data.capture !== 'excluded'
  )
    throw new HistoryError('INVALID_SCHEMA', 'Invalid column capture policy.');
  const type = decodeScalarType(data.type);
  validateTypeModifier(type, data.typeModifier);
  return Object.freeze({
    name: name(data.name),
    type,
    nullable: data.nullable,
    typeModifier: data.typeModifier,
    ...(data.capture === undefined ? {} : { capture: data.capture }),
  });
}

function table(input: unknown): TableSchema {
  const data = objectFields(input, [
    'id',
    'namespace',
    'name',
    'columns',
    'primaryKey',
  ]);
  const columns = boundedArray(data.columns, 128).map(column);
  const keys = boundedArray(data.primaryKey, 32).map(name);
  if (
    !columns.length ||
    !keys.length ||
    new Set(columns.map((item) => item.name)).size !== columns.length ||
    new Set(keys).size !== keys.length
  )
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Tables require unique columns and nonempty unique primary keys.',
    );
  for (const key of keys) {
    const field = columns.find((item) => item.name === key);
    if (
      !field ||
      field.nullable ||
      field.type === 'json' ||
      field.capture !== undefined
    )
      throw new HistoryError(
        'INVALID_SCHEMA',
        'Primary keys must reference available, nonnullable comparable columns.',
      );
  }
  return Object.freeze({
    id: identityText(data.id),
    namespace: name(data.namespace),
    name: name(data.name),
    columns: Object.freeze(columns),
    primaryKey: Object.freeze(keys),
  });
}

export function decodeSchema(input: unknown): Schema {
  const data = objectFields(input, ['version', 'id', 'tables']);
  if (data.version !== 1)
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Unsupported schema format version.',
    );
  const tables = boundedArray(data.tables, 64).map(table);
  if (
    !tables.length ||
    new Set(tables.map((item) => item.id)).size !== tables.length ||
    new Set(tables.map((item) => JSON.stringify([item.namespace, item.name])))
      .size !== tables.length
  )
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Schema requires distinct selected table identities and names.',
    );
  return Object.freeze({
    version: 1,
    id: identityText(data.id),
    tables: Object.freeze(tables),
  });
}

export function findTable(schema: Schema, tableId: string): TableSchema {
  const table = schema.tables.find((item) => item.id === tableId);
  if (!table)
    throw new HistoryError('INVALID_SCHEMA', 'Unknown recorded table.');
  return table;
}

export function decodeRow(table: TableSchema, input: unknown): Row {
  const values = boundedArray(input, table.columns.length);
  if (values.length !== table.columns.length)
    throw new HistoryError(
      'INVALID_VALUE',
      'Row must contain every recorded column.',
    );
  let bytes = 2;
  const row = table.columns.map((column, index) => {
    const value = decodeValue(values[index]);
    if (
      column.capture !== undefined &&
      (value.kind !== 'unavailable' || value.reason !== column.capture)
    )
      throw new HistoryError(
        'INVALID_VALUE',
        'Recorded value violates its declared column policy.',
      );
    if (
      (value.kind === 'null' && !column.nullable) ||
      (value.kind === 'scalar' && value.type !== column.type)
    )
      throw new HistoryError(
        'INVALID_VALUE',
        'Row value is incompatible with its column.',
      );
    if (value.kind === 'scalar')
      validateModifiedValue(value, column.typeModifier);
    bytes +=
      utf8Bytes(JSON.stringify(value), 1048576 - bytes) + (index > 0 ? 1 : 0);
    if (bytes > 1048576)
      throw new HistoryError('LIMIT_EXCEEDED', 'Encoded row exceeds 1 MiB.');
    return value;
  });
  return Object.freeze(row);
}

export function rowKey(
  recording: RecordingSchema,
  table: TableSchema,
  row: Row,
): string {
  const key = table.primaryKey.map((name) => {
    const value =
      row[table.columns.findIndex((column) => column.name === name)];
    if (!value || value.kind !== 'scalar')
      throw new HistoryError(
        'INVALID_VALUE',
        'Primary key values must be available and nonnull.',
      );
    return [name, valueIdentity(value)];
  });
  const encoded = JSON.stringify([
    recording.sourceId,
    recording.epochId,
    recording.schema.id,
    table.id,
    key,
  ]);
  boundedText(encoded, 65536);
  return encoded;
}
