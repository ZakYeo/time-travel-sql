import { HistoryError } from '@time-travel-sql/sdk';
import type { ScalarType } from '@time-travel-sql/sdk';

const scalarTypes = new Map<number, ScalarType>([
  [16, 'bool'],
  [20, 'int8'],
  [21, 'int2'],
  [23, 'int4'],
  [25, 'text'],
  [1043, 'varchar'],
  [1700, 'numeric'],
  [2950, 'uuid'],
  [1082, 'date'],
  [1114, 'timestamp'],
  [1184, 'timestamptz'],
  [114, 'json'],
  [3802, 'jsonb'],
  [17, 'bytea'],
]);

export function postgresScalarType(oid: number): ScalarType {
  const type = scalarTypes.get(oid);
  if (!type)
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Unsupported PostgreSQL type OID.',
    );
  return type;
}
