import { applyColumnPolicy, recordedColumnPolicy } from '@time-travel-sql/sdk';
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
  if (command === 'source-plan')
    return { ...config.plan, columnPolicy: config.columnPolicy };
  const connection = sourceConnection(config, env);
  const { publication, slot, ownershipToken, tables } = config.plan;
  const setup = { publication, slot, ownershipToken, tables };
  switch (command) {
    case 'source-setup':
      return applyPostgresSetup(
        connection,
        setup,
        config.schemaId,
        signal,
        config.columnPolicy,
      );
    case 'source-inspect': {
      const receipt = await inspectPostgresSetup(
        connection,
        setup,
        config.schemaId,
        signal,
      );
      applyColumnPolicy(receipt.schema, config.columnPolicy);
      return receipt;
    }
    case 'source-doctor': {
      await inspectPostgresSetup(connection, setup, config.schemaId, signal);
      const inspection = await inspectPostgresCapture({
        connection,
        publication,
        newSlot: slot,
        tables,
        schemaId: config.schemaId,
        columnPolicy: config.columnPolicy,
        signal,
      });
      return {
        ready: true,
        lossy: recordedColumnPolicy(inspection.schema).rules.length > 0,
        assessment: 'point-in-time',
        ...inspection,
      };
    }
  }
}
