import { resolve } from 'node:path';
import {
  applyPostgresSetup,
  inspectPostgresSetup,
  inspectPostgresCapture,
} from '@time-travel-sql/source-postgres';
import {
  sourceConfiguration,
  sourceConnection,
} from './source-configuration.js';

export async function sourceCommand(
  command: 'source-plan' | 'source-setup' | 'source-inspect' | 'source-doctor',
  file: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal,
) {
  const config = await sourceConfiguration(resolve(cwd, file), signal);
  if (command === 'source-plan') return config.plan;
  const connection = sourceConnection(config, env);
  const { publication, slot, ownershipToken, tables } = config.plan;
  const setup = { publication, slot, ownershipToken, tables };
  switch (command) {
    case 'source-setup':
      return applyPostgresSetup(connection, setup, config.schemaId, signal);
    case 'source-inspect':
      return inspectPostgresSetup(connection, setup, config.schemaId, signal);
    case 'source-doctor':
      await inspectPostgresSetup(connection, setup, config.schemaId, signal);
      return {
        ready: true,
        assessment: 'point-in-time',
        ...(await inspectPostgresCapture({
          connection,
          publication,
          newSlot: slot,
          tables,
          schemaId: config.schemaId,
          signal,
        })),
      };
  }
}
