import {
  decodeDataFields,
  decodeStableId,
  decodeColumnPolicy,
} from '@time-travel-sql/sdk';
import { planPostgresSetup } from '@time-travel-sql/source-postgres';
import type { PostgresConnection } from '@time-travel-sql/source-postgres';
import { configurationFile } from './configuration.js';
import { UsageError } from './arguments.js';

function text(input: unknown, maximum = 512): string {
  if (
    typeof input !== 'string' ||
    !input.length ||
    Buffer.byteLength(input) > maximum ||
    input.includes('\0') ||
    !input.isWellFormed()
  )
    throw new UsageError('Source fields must contain bounded nonempty text.');
  return input;
}

export async function sourceConfiguration(path: string, signal: AbortSignal) {
  try {
    const data = await configurationFile(path, signal, [
      'connection',
      'schemaId',
      'publication',
      'slot',
      'ownershipToken',
      'tables',
      'columnPolicy',
    ]);
    const connection = decodeDataFields(data.connection, [
      'host',
      'port',
      'user',
      'database',
      'passwordEnv',
      'sslMode',
    ]);
    const { port, sslMode } = connection;
    if (
      typeof port !== 'number' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new UsageError('Source port must be an integer from 1 to 65535.');
    if (sslMode !== 'verify-full' && sslMode !== 'disable')
      throw new UsageError(
        'Source sslMode must explicitly be verify-full or disable.',
      );
    const passwordEnv =
      connection.passwordEnv === undefined
        ? undefined
        : text(connection.passwordEnv, 128);
    if (
      passwordEnv !== undefined &&
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(passwordEnv)
    )
      throw new UsageError(
        'Source passwordEnv must name one environment variable.',
      );
    const plan = planPostgresSetup({
      publication: data.publication,
      slot: data.slot,
      ownershipToken: data.ownershipToken,
      tables: data.tables,
    });
    const columnPolicy = decodeColumnPolicy(data.columnPolicy);
    if (
      columnPolicy.rules.some(
        (rule) =>
          !plan.tables.some(
            (table) =>
              table.namespace === rule.namespace && table.name === rule.table,
          ),
      )
    )
      throw new UsageError(
        'Column policy must refer to explicitly selected tables.',
      );
    return {
      connection: {
        host: text(connection.host),
        port,
        user: text(connection.user),
        database: text(connection.database),
        sslMode,
        passwordEnv,
      },
      schemaId: decodeStableId(data.schemaId),
      plan,
      columnPolicy,
    };
  } catch (cause) {
    if (signal.aborted && cause === signal.reason) throw cause;
    if (cause instanceof UsageError) throw cause;
    throw new UsageError('Cannot read a valid source configuration.', {
      cause,
    });
  }
}

export function sourceConnection(
  config: Awaited<ReturnType<typeof sourceConfiguration>>,
  env: Readonly<Record<string, string | undefined>>,
): PostgresConnection {
  const { passwordEnv, sslMode, ...connection } = config.connection;
  const password = passwordEnv === undefined ? '' : env[passwordEnv];
  if (
    password === undefined ||
    Buffer.byteLength(password) > 65536 ||
    password.includes('\0') ||
    !password.isWellFormed()
  )
    throw new UsageError(
      'The configured source password environment variable is missing or invalid.',
    );
  return {
    ...connection,
    password,
    ...(sslMode === 'verify-full' ? { ssl: { rejectUnauthorized: true } } : {}),
  };
}
