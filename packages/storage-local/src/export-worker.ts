import type { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import {
  HistoryError,
  HistoryState,
  decodeStableId,
  decodeReplayLimits,
  DEFAULT_REPLAY_LIMITS,
} from '@time-travel-sql/sdk';
import { openReadSnapshot } from './database.js';
import { Reader } from './reader.js';
import { CheckDefinitions } from './saved-checks.js';
import { HistoryScan } from './history-scan.js';
import { encode } from './integrity.js';
import { failureResponse } from './protocol.js';
import type { Request, Response, Startup } from './protocol.js';

const port = parentPort;
if (!port) throw new Error('Export requires an owned parent port.');
const startup: Extract<Startup, { kind: 'export' }> = workerData;
let opened: DatabaseSync | undefined;
try {
  const db = openReadSnapshot(startup.options.path);
  opened = db;
  const id = decodeStableId(startup.recordingId);
  const reader = new Reader(db);
  const checks = new CheckDefinitions(reader);
  const info = reader.published(id);
  if (info.headPosition === null)
    throw new HistoryError(
      'INVALID_HISTORY',
      'Recording has no published head.',
    );
  // Derived checkpoints are neither required nor trusted for portable export.
  const scan = new HistoryScan(reader, info);
  let state = HistoryState.fromSnapshot(
    info.recording,
    info.baselinePosition,
    scan.baseline(),
    decodeReplayLimits(startup.options.replayLimits ?? DEFAULT_REPLAY_LIMITS),
  );
  for (const transaction of scan.commitsThrough(info.headPosition))
    state = state.apply(transaction);
  const ready = { id: 0, ok: true, value: info } satisfies Response;
  encode(ready);
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
      if (
        (command.method !== 'baseline' &&
          command.method !== 'transactions' &&
          command.method !== 'transaction' &&
          command.method !== 'savedCheck') ||
        command.args[0] !== id
      )
        throw new HistoryError(
          'INVALID_VALUE',
          'Unsupported recording export command.',
        );
      let value: unknown;
      switch (command.method) {
        case 'baseline':
          value = reader.baseline(id, command.args[1]);
          break;
        case 'transactions':
          value = reader.transactions(id, command.args[1]);
          break;
        case 'transaction':
          value = reader.transaction(id, command.args[1]);
          break;
        case 'savedCheck':
          value = checks.savedCheck(id, command.args[1]);
          break;
      }
      response = { id: request.id, ok: true, value };
      encode(response);
    } catch (error) {
      response = failureResponse(request.id, error);
    }
    port.postMessage(response);
  });
  port.postMessage(ready);
} catch (error) {
  opened?.close();
  port.postMessage(failureResponse(0, error));
  port.close();
}
