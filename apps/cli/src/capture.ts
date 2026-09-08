import type { CaptureBinding } from '@time-travel-sql/sdk';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  bootstrapBoundRecording,
  applyColumnPolicy,
  decodeStableId,
  HistoryError,
} from '@time-travel-sql/sdk';
import {
  createLocalReconstructor,
  openLocalStore,
} from '@time-travel-sql/storage-local';
import {
  inspectPostgresSetup,
  inspectPostgresCapture,
  openPostgresCaptureLease,
  planPostgresCapture,
  readPostgresCaptureBinding,
  createPostgresCaptureBinding,
  resumePostgresRecording,
} from '@time-travel-sql/source-postgres';
import type { argumentsFor } from './arguments.js';
import { boundedInteger } from './arguments.js';
import {
  sourceConfiguration,
  sourceConnection,
} from './source-configuration.js';
import { owned } from './owned.js';
import { captureProgress } from './capture-progress.js';

type Command = Extract<ReturnType<typeof argumentsFor>, { kind: 'command' }>;

export async function captureCommand(
  path: string,
  command: Command,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal,
  output: (text: string, signal: AbortSignal) => Promise<void>,
) {
  const id = decodeStableId(command.operands[0]);
  const config = await sourceConfiguration(
    resolve(cwd, command.operands.at(-1) ?? ''),
    signal,
  );
  const connection = sourceConnection(config, env);
  const { publication, slot, ownershipToken, tables } = config.plan;
  const receipt = await inspectPostgresSetup(
    connection,
    { publication, slot, ownershipToken, tables },
    config.schemaId,
    signal,
  );
  const emit = (
    data: unknown,
    deliverySignal: AbortSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(1000),
    ]),
  ) =>
    output(
      JSON.stringify({
        version: 1,
        event: 'capture-progress',
        recordingId: id,
        data,
      }) + '\n',
      deliverySignal,
    );
  return owned(await openLocalStore({ path }), async (store) => {
    let expectedBinding: CaptureBinding;
    if (command.command === 'record') {
      await inspectPostgresCapture({
        connection,
        publication,
        newSlot: slot,
        tables,
        schemaId: config.schemaId,
        columnPolicy: config.columnPolicy,
        signal,
      });
      await emit({ phase: 'bootstrapping' });
      const baseline = await owned(
        await openPostgresCaptureLease(connection, receipt, signal),
        async (lease) => {
          const plan = planPostgresCapture({
            connection,
            lease,
            sourceId: randomUUID(),
            epochId: randomUUID(),
            columnPolicy: config.columnPolicy,
            signal,
          });
          return bootstrapBoundRecording(plan, store, {
            id,
            name: command.operands[1] ?? '',
            createdAt: new Date().toISOString(),
          });
        },
      );
      expectedBinding = createPostgresCaptureBinding(
        baseline.recording,
        receipt,
      );
    } else {
      const current = await store.info(id);
      const expectedRecording = {
        ...current.recording,
        schema: applyColumnPolicy(receipt.schema, config.columnPolicy),
      };
      expectedBinding = createPostgresCaptureBinding(
        expectedRecording,
        receipt,
      );
      const binding = await store.captureBinding(id);
      readPostgresCaptureBinding(current.recording, binding);
      if (JSON.stringify(binding) !== JSON.stringify(expectedBinding))
        throw new HistoryError(
          'INVALID_HISTORY',
          'Source configuration differs from the stored capture binding.',
        );
    }
    signal.throwIfAborted();
    return owned(createLocalReconstructor({ path }), async (reconstructor) => {
      // The supervisor owns cancellation during acquisition and drains accepted
      // appends on stop. Closing bootstrap's lease first permits canonical resume.
      const session = resumePostgresRecording(
        store,
        reconstructor,
        connection,
        id,
        { expectedBinding },
      );
      return captureProgress(
        session,
        () => store.info(id),
        emit,
        signal,
        command.options['duration-ms'] === undefined
          ? undefined
          : boundedInteger(command.options['duration-ms'], 3600000),
      );
    });
  });
}
