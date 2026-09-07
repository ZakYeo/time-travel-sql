import {
  HistoryError,
  decodeDataFields,
  decodeDataArray,
} from '@time-travel-sql/sdk';
import { qualifiedName } from './catalog.js';
import type { TableSelection } from './catalog.js';
import { quoteIdentifier, validateSlotName } from './identifiers.js';

export function decodeOwnershipToken(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{32}$/.test(input))
    throw new HistoryError(
      'INVALID_VALUE',
      'Setup requires a 128-bit lowercase hexadecimal ownership token.',
    );
  return input;
}

export function publicationOwnershipComment(
  token: string,
  slot: string,
): string {
  return `time-travel-sql:publication:v1:${token}:${slot}`;
}

export interface PostgresSetupOptions {
  readonly publication: string;
  readonly slot: string;
  /** A fresh 128-bit lowercase hexadecimal ownership token supplied by composition. */
  readonly ownershipToken: string;
  readonly tables: readonly TableSelection[];
}

export interface PostgresSetupPlan {
  readonly publication: string;
  readonly slot: string;
  readonly ownershipToken: string;
  readonly ownershipComment: string;
  readonly tables: readonly TableSelection[];
  /** Transaction body; the explicit apply operation owns BEGIN/COMMIT/rollback. */
  readonly statements: readonly string[];
  /** Inspectable SQL script. Requires an operator-selected database connection. */
  readonly sql: string;
  /** Replication-protocol command used by bootstrap, not part of setup SQL. */
  readonly bootstrapCommand: string;
}

/** Pure generation: no connection, inspection, resource creation or random IDs. */
export function planPostgresSetup(input: unknown): PostgresSetupPlan {
  const options = decodeDataFields(input, [
    'publication',
    'slot',
    'ownershipToken',
    'tables',
  ]);
  const publication = validateSlotName(options.publication);
  const slot = validateSlotName(options.slot);
  const ownershipToken = decodeOwnershipToken(options.ownershipToken);
  const selected = decodeDataArray(options.tables, 64);
  if (!selected.length)
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Select 1–64 distinct tables explicitly.',
    );
  const tables = selected.map((inputTable) => {
    const table = decodeDataFields(inputTable, ['namespace', 'name']);
    if (typeof table.namespace !== 'string' || typeof table.name !== 'string')
      throw new HistoryError(
        'INVALID_SCHEMA',
        'Table namespace and name must be strings.',
      );
    return Object.freeze({ namespace: table.namespace, name: table.name });
  });
  const names = tables.map(qualifiedName);
  if (new Set(names).size !== names.length)
    throw new HistoryError('INVALID_SCHEMA', 'Setup tables must be distinct.');
  const ownershipComment = publicationOwnershipComment(ownershipToken, slot);
  const statements = Object.freeze([
    "SET LOCAL lock_timeout = '5s'",
    "SET LOCAL statement_timeout = '30s'",
    ...names.map((name) => `ALTER TABLE ONLY ${name} REPLICA IDENTITY FULL`),
    `CREATE PUBLICATION ${quoteIdentifier(publication)} FOR TABLE ${names.map((name) => `ONLY ${name}`).join(', ')} WITH (publish = 'insert, update, delete, truncate', publish_via_partition_root = false)`,
    `COMMENT ON PUBLICATION ${quoteIdentifier(publication)} IS '${ownershipComment}'`,
  ]);
  return Object.freeze({
    publication,
    slot,
    ownershipToken,
    ownershipComment,
    tables: Object.freeze(tables),
    statements,
    sql: [
      'BEGIN;',
      ...statements.map((statement) => `${statement};`),
      'COMMIT;',
    ].join('\n'),
    bootstrapCommand: `CREATE_REPLICATION_SLOT ${slot} LOGICAL pgoutput (SNAPSHOT 'export')`,
  });
}
