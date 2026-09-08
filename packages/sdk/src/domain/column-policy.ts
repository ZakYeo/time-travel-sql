import { HistoryError } from './errors.js';
import { objectFields, boundedArray, boundedText } from './validation.js';
import { decodeSchema, decodeRow, findTable } from './schema.js';
import type { Schema, Row } from './schema.js';
import type { RecordingSchema } from './schema.js';
import { decodeTransaction } from './events.js';
import type { CommittedTransaction } from './events.js';

export interface ColumnRule {
  readonly namespace: string;
  readonly table: string;
  readonly column: string;
  readonly action: 'redact' | 'exclude';
}
export interface ColumnPolicy {
  readonly version: 1;
  readonly rules: readonly ColumnRule[];
}

/** Syntax-only validation for offline configuration; schema compatibility is separate. */
export function decodeColumnPolicy(
  input: unknown = { version: 1, rules: [] },
): ColumnPolicy {
  const data = objectFields(input, ['version', 'rules']);
  if (data.version !== 1)
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Unsupported column policy version.',
    );
  const seen = new Set<string>();
  const rules = boundedArray(data.rules, 8192).map((input) => {
    const rule = objectFields(input, [
      'namespace',
      'table',
      'column',
      'action',
    ]);
    const namespace = boundedText(rule.namespace, 63);
    const table = boundedText(rule.table, 63);
    const column = boundedText(rule.column, 63);
    if (
      !namespace ||
      !table ||
      !column ||
      (rule.action !== 'redact' && rule.action !== 'exclude')
    )
      throw new HistoryError('INVALID_SCHEMA', 'Invalid column policy rule.');
    const key = JSON.stringify([namespace, table, column]);
    if (seen.has(key))
      throw new HistoryError(
        'INVALID_SCHEMA',
        'Column policy rules must be unique.',
      );
    seen.add(key);
    return Object.freeze({ namespace, table, column, action: rule.action });
  });
  return Object.freeze({ version: 1, rules: Object.freeze(rules) });
}

/** Add deterministic loss; never removes an existing restriction or changes keys. */
export function applyColumnPolicy(
  input: unknown,
  policyInput?: unknown,
): Schema {
  const schema = decodeSchema(input);
  const policy = decodeColumnPolicy(policyInput);
  const rules = new Map(
    policy.rules.map((rule) => [
      JSON.stringify([rule.namespace, rule.table, rule.column]),
      rule.action,
    ]),
  );
  const result = decodeSchema({
    ...schema,
    tables: schema.tables.map((table) => ({
      ...table,
      columns: table.columns.map((column) => {
        const key = JSON.stringify([table.namespace, table.name, column.name]);
        const action = rules.get(key);
        rules.delete(key);
        return action === undefined
          ? column
          : {
              ...column,
              capture: action === 'redact' ? 'redacted' : 'excluded',
            };
      }),
    })),
  });
  if (rules.size)
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Column policy references an unselected table or missing column.',
    );
  return result;
}

/** Canonical rules follow schema/table/column order, independent of input ordering. */
export function recordedColumnPolicy(input: unknown): ColumnPolicy {
  const schema = decodeSchema(input);
  return decodeColumnPolicy({
    version: 1,
    rules: schema.tables.flatMap((table) =>
      table.columns.flatMap((column) =>
        column.capture === undefined
          ? []
          : [
              {
                namespace: table.namespace,
                table: table.name,
                column: column.name,
                action: column.capture === 'redacted' ? 'redact' : 'exclude',
              },
            ],
      ),
    ),
  });
}

/** Catalog comparison only. Removing policy metadata cannot recover masked values. */
export function schemaWithoutColumnPolicy(input: unknown): Schema {
  const schema = decodeSchema(input);
  return decodeSchema({
    ...schema,
    tables: schema.tables.map((table) => ({
      ...table,
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.type,
        nullable: column.nullable,
        typeModifier: column.typeModifier,
      })),
    })),
  });
}

/** Transform before validation/persistence; protected values never pass into the result. */
export function projectRow(
  schema: Schema,
  tableId: string,
  input: unknown,
): Row {
  const table = findTable(schema, tableId);
  const values = boundedArray(input, table.columns.length);
  if (values.length !== table.columns.length)
    throw new HistoryError(
      'INVALID_VALUE',
      'Projected row width differs from schema.',
    );
  return decodeRow(
    table,
    table.columns.map((column, index) =>
      column.capture === undefined
        ? values[index]
        : { kind: 'unavailable', reason: column.capture },
    ),
  );
}

/** Decode the original first so projection cannot conceal malformed protected values. */
export function projectTransaction(
  original: RecordingSchema,
  projected: RecordingSchema,
  input: unknown,
): CommittedTransaction {
  const transaction = decodeTransaction(original, input);
  const projectedTransaction = { ...transaction };
  if (projected.derivation) delete projectedTransaction.context;
  return decodeTransaction(projected, {
    ...projectedTransaction,
    events: transaction.events.map((event) => ({
      kind: event.kind,
      tableId: event.tableId,
      ...('before' in event
        ? { before: projectRow(projected.schema, event.tableId, event.before) }
        : {}),
      ...('after' in event
        ? { after: projectRow(projected.schema, event.tableId, event.after) }
        : {}),
    })),
  });
}
