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
import { encode } from './integrity.js';

// Both ends of this private worker protocol are shipped together. All data is
// validated by the canonical decoders before it can affect durable history.
const startup: Extract<Startup, { kind: 'store' }> = workerData;
const options = startup.options;
const port = parentPort;
if (!port) throw new Error('Storage worker requires an owned parent port.');
const db = openDatabase(options);
const reader = new Reader(db);
const checkpoints = new Checkpoints(
  reader,
  decodeReplayLimits(options.replayLimits ?? DEFAULT_REPLAY_LIMITS),
);
const writer = new Writer(reader, checkpoints);
const reads = new Set<StoreCommand['method']>([
  'info',
  'list',
  'baseline',
  'transactions',
  'transaction',
  'checkpoints',
  'checkpointRows',
]);

function dispatch(command: StoreCommand): unknown {
  if (command.method !== 'create' && command.method !== 'list')
    decodeStableId(command.args[0]);
  switch (command.method) {
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
    response = atomic(
      db,
      () => {
        const value = dispatch(command);
        const result = { id: request.id, ok: true, value } satisfies Response;
        encode(result);
        return result;
      },
      reads.has(command.method) ? 'read' : 'write',
    );
  } catch (error) {
    response = failureResponse(request.id, error);
  }
  port.postMessage(response);
});
port.postMessage({ id: 0, ok: true, value: null } satisfies Response);
