import {
  HistoryError,
  decodeDataFields,
  decodeSchema,
} from '@time-travel-sql/sdk';
import type { Schema } from '@time-travel-sql/sdk';
import { validateSlotName } from './identifiers.js';
import { decodeOwnershipToken } from './setup-plan.js';

/** Setup observations may come from separate replication and SQL connections.
 * Destructive consumers must verify identity on their actual connection.
 */
export interface PostgresSetupReceipt {
  readonly systemId: string;
  readonly timeline: string;
  readonly databaseOid: string;
  readonly publication: string;
  readonly publicationOid: string;
  readonly ownershipToken: string;
  readonly slot: string;
  readonly schema: Schema;
}

function unsignedIdentity(input: unknown, maximum: bigint): string {
  if (
    typeof input !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(input) ||
    BigInt(input) > maximum
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Invalid PostgreSQL setup identity.',
    );
  return input;
}

export function decodePostgresSetupReceipt(
  input: unknown,
): PostgresSetupReceipt {
  const data = decodeDataFields(input, [
    'systemId',
    'timeline',
    'databaseOid',
    'publication',
    'publicationOid',
    'ownershipToken',
    'slot',
    'schema',
  ]);
  return Object.freeze({
    systemId: unsignedIdentity(data.systemId, 18446744073709551615n),
    timeline: unsignedIdentity(data.timeline, 4294967295n),
    databaseOid: unsignedIdentity(data.databaseOid, 4294967295n),
    publication: validateSlotName(data.publication),
    publicationOid: unsignedIdentity(data.publicationOid, 4294967295n),
    ownershipToken: decodeOwnershipToken(data.ownershipToken),
    slot: validateSlotName(data.slot),
    schema: decodeSchema(data.schema),
  });
}
