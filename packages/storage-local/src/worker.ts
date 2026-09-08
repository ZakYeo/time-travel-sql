import { parentPort, workerData } from 'node:worker_threads';
import {
  HistoryError,
  decodeStableId,
  decodeReplayLimits,
  DEFAULT_REPLAY_LIMITS,
} from '@time-travel-sql/sdk';
import { atomic, openDatabase } from './database.js';
import type { StoreCommand, Request, Response, Startup } from './protocol.js';
import { failureResponse } from './protocol.js';
import { Reader } from './reader.js';
import { Writer } from './writer.js';
import { Checkpoints } from './checkpoints.js';
import { CaptureBindings } from './capture-bindings.js';
import { RecordingOwners } from './recording-owners.js';
import { encode } from './integrity.js';
import { Imports } from './imports.js';
import { CheckDefinitions } from './saved-checks.js';

// Both ends of this private worker protocol are shipped together. All data is
// validated by the canonical decoders before it can affect durable history.
const startup: Extract<Startup, { kind: 'store' }> = workerData;
const options = startup.options;
const port = parentPort;
if (!port) throw new Error('Storage worker requires an owned parent port.');
const db = openDatabase(options);
const reader = new Reader(db);
const checks = new CheckDefinitions(reader);
const checkpoints = new Checkpoints(
  reader,
  decodeReplayLimits(options.replayLimits ?? DEFAULT_REPLAY_LIMITS),
);
const owners = new RecordingOwners(reader);
const writer = new Writer(reader, checkpoints, owners);
const bindings = new CaptureBindings(reader);
const imports = new Imports(options, checkpoints.limits);
const privateStaging = new Set<StoreCommand['method']>([
  'beginImport',
  'importBaseline',
  'importBaselineComplete',
  'importAppend',
  'closeImport',
]);
const reads = new Set<StoreCommand['method']>([
  'savedCheck',
  'savedChecks',
  'info',
  'captureBinding',
  'list',
  'baseline',
  'transactions',
  'transaction',
  'checkpoints',
  'checkpointRows',
]);

function dispatch(command: StoreCommand): unknown {
  if (
    command.method !== 'create' &&
    command.method !== 'list' &&
    command.method !== 'beginImport'
  )
    decodeStableId(command.args[0]);
  switch (command.method) {
    case 'saveCheck':
      return checks.saveCheck(...command.args);
    case 'savedCheck':
      return checks.savedCheck(...command.args);
    case 'savedChecks':
      return checks.savedChecks(...command.args);
    case 'removeCheck':
      return checks.removeCheck(...command.args);
    case 'beginImport':
      return imports.begin(...command.args);
    case 'importBaseline':
      return imports.baseline(...command.args);
    case 'importBaselineComplete':
      return imports.baselineComplete(...command.args);
    case 'importAppend':
      return imports.append(...command.args);
    case 'publishImport':
      return imports.publish(command.args[0], command.args[1], writer);
    case 'closeImport':
      return imports.close(...command.args);
    case 'prepareRecording':
      return owners.prepare(...command.args);
    case 'activateRecording':
      return owners.activate(...command.args);
    case 'releaseRecording':
      return owners.release(...command.args);
    case 'fencedAppend':
      return writer.append(command.args[0], command.args[2], command.args[1]);
    case 'fencedSetStatus':
      return writer.setStatus(
        command.args[0],
        command.args[2],
        command.args[1],
      );
    case 'captureBinding':
      return bindings.captureBinding(...command.args);
    case 'bindCapture':
      return bindings.bindCapture(...command.args);
    case 'publishCheckpoint':
      return checkpoints.publishCheckpoint(...command.args);
    case 'checkpoints':
      return checkpoints.checkpoints(...command.args);
    case 'checkpointRows':
      return checkpoints.checkpointRows(...command.args);
    case 'removeCheckpoint':
      return checkpoints.removeCheckpoint(...command.args);
    case 'create':
      return writer.create(...command.args);
    case 'stageBaseline':
      return writer.stageBaseline(...command.args);
    case 'publishBaseline':
      return writer.publishBaseline(...command.args);
    case 'append':
      return writer.append(...command.args);
    case 'setStatus':
      return writer.setStatus(...command.args);
    case 'rename':
      return writer.rename(...command.args);
    case 'remove':
      return writer.remove(...command.args);
    case 'info':
      return reader.info(...command.args);
    case 'list':
      return reader.list(...command.args);
    case 'baseline':
      return reader.baseline(...command.args);
    case 'transactions':
      return reader.transactions(...command.args);
    case 'transaction':
      return reader.transaction(...command.args);
  }
}

port.on('message', (request: Request) => {
  let response: Response;
  try {
    if (request.command.method === 'close') {
      imports.close();
      db.close();
      port.postMessage({
        id: request.id,
        ok: true,
        value: null,
      } satisfies Response);
      port.close();
      return;
    }
    encode(request);
    const command = request.command;
    if (command.method === 'reconstructionRows')
      throw new HistoryError('INVALID_VALUE', 'Unsupported storage command.');
    const execute = () => {
      const value = dispatch(command);
      const result = { id: request.id, ok: true, value } satisfies Response;
      encode(result);
      return result;
    };
    response = privateStaging.has(command.method)
      ? execute()
      : atomic(db, execute, reads.has(command.method) ? 'read' : 'write');
    if (command.method === 'publishImport')
      imports.publicationCommitted(command.args[0]);
  } catch (error) {
    response = failureResponse(request.id, error);
  }
  port.postMessage(response);
});
port.postMessage({ id: 0, ok: true, value: null } satisfies Response);
