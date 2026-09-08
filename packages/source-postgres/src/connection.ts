import type pg from 'pg';
import type { ConnectionOptions } from 'node:tls';

export interface PostgresConnection {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly database: string;
  readonly password?: string;
  readonly ssl?: ConnectionOptions;
}

/** Per-client parsers preserve database text; never change pg's global registry. */
export function connectionOptions(
  connection: PostgresConnection,
): pg.ClientConfig & { replication: 'false' } {
  if (
    !connection.host ||
    !connection.user ||
    !connection.database ||
    !Number.isInteger(connection.port) ||
    connection.port < 1 ||
    connection.port > 65535
  ) {
    throw new Error('Explicit host, port, user and database are required.');
  }
  return {
    ...connection,
    // A callback prevents pg from falling back to PGPASSWORD or pgpass.
    password: () => connection.password ?? '',
    replication: 'false',
    client_encoding: 'UTF8',
    sslnegotiation: 'postgres',
    ssl: connection.ssl ?? false,
    application_name: 'time-travel-sql',
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    options: '-c datestyle=ISO,YMD -c timezone=UTC -c bytea_output=hex',
    types: { getTypeParser: () => (value: string) => value },
  };
}

export function textRows(rows: unknown): (string | null)[][] {
  if (!Array.isArray(rows))
    throw new Error('Invalid PostgreSQL response rows.');
  return rows.map((row: unknown) => {
    if (!Array.isArray(row))
      throw new Error('Invalid PostgreSQL response row.');
    return row.map((value: unknown) => {
      if (value !== null && typeof value !== 'string')
        throw new Error('Expected PostgreSQL text format.');
      return value;
    });
  });
}
