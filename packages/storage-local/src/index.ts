import { Client } from './client.js';
import { prepareRecording } from './prepare-recording.js';
import { beginImport } from './begin-import.js';
import { ImportDirectories } from './import-directories.js';
import type { LocalStoreOptions } from './database.js';
import type { LocalStore } from './protocol.js';

export type { LocalStoreOptions } from './database.js';
export type { LocalStore } from './protocol.js';
export {
  createLocalReconstructor,
  createLocalStatePairs,
} from './reconstructor.js';
export type { LocalReconstructionOptions } from './reconstructor.js';

/** Owns a SQLite worker until close(), which drains accepted requests. */
export async function openLocalStore(
  options: LocalStoreOptions,
): Promise<LocalStore> {
  const client = new Client({ kind: 'store', options });
  try {
    await client.ready;
  } catch (error) {
    await client.close();
    throw error;
  }
  const directories = new ImportDirectories(options.path);
  return {
    saveCheck: (...args) => client.request({ method: 'saveCheck', args }),
    savedCheck: (...args) => client.request({ method: 'savedCheck', args }),
    savedChecks: (...args) => client.request({ method: 'savedChecks', args }),
    removeCheck: (...args) => client.request({ method: 'removeCheck', args }),
    beginImport: (metadata, signal) =>
      beginImport(client, directories, metadata, signal),
    prepareRecording: (id) => prepareRecording(client, id),
    bindCapture: (...args) => client.request({ method: 'bindCapture', args }),
    captureBinding: (...args) =>
      client.request({ method: 'captureBinding', args }),
    publishCheckpoint: (...args) =>
      client.request({ method: 'publishCheckpoint', args }),
    checkpoints: (...args) => client.request({ method: 'checkpoints', args }),
    checkpointRows: (...args) =>
      client.request({ method: 'checkpointRows', args }),
    removeCheckpoint: (...args) =>
      client.request({ method: 'removeCheckpoint', args }),
    create: (...args) => client.request({ method: 'create', args }),
    stageBaseline: (...args) =>
      client.request({ method: 'stageBaseline', args }),
    publishBaseline: (...args) =>
      client.request({ method: 'publishBaseline', args }),
    append: (...args) => client.request({ method: 'append', args }),
    setStatus: (...args) => client.request({ method: 'setStatus', args }),
    rename: (...args) => client.request({ method: 'rename', args }),
    remove: (...args) => client.request({ method: 'remove', args }),
    info: (...args) => client.request({ method: 'info', args }),
    list: (...args) => client.request({ method: 'list', args }),
    baseline: (...args) => client.request({ method: 'baseline', args }),
    transactions: (...args) => client.request({ method: 'transactions', args }),
    transaction: (...args) => client.request({ method: 'transaction', args }),
    close: async () => {
      const errors: unknown[] = [];
      try {
        await client.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await directories.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length)
        throw new AggregateError(errors, 'Local store cleanup failed.');
    },
  };
}
export { createLocalExporter } from './exporter.js';
export type { LocalExportOptions } from './exporter.js';
