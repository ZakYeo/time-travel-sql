import { parentPort, workerData } from 'node:worker_threads';
import {
  HistoryError,
  decodeReconstructionRequest,
  decodeReconstructionInfo,
  decodeReplayLimits,
  DEFAULT_REPLAY_LIMITS,
  decodeStableId,
  decodePageRequest,
  decodePosition,
  selectedPosition,
} from '@time-travel-sql/sdk';
import type {
  Row,
  Page,
  PageRequest,
  ReconstructionInfo,
} from '@time-travel-sql/sdk';
import { openReadSnapshot } from './database.js';
import { Reader } from './reader.js';
import { Checkpoints } from './checkpoints.js';
import { encode, MAX_MESSAGE_BYTES } from './integrity.js';
import { failureResponse } from './protocol.js';
import type { Request, Response, Startup } from './protocol.js';

const port = parentPort;
if (!port) throw new Error('Reconstruction requires an owned parent port.');

function reconstruct(startup: Extract<Startup, { kind: 'reconstruction' }>): {
  info: ReconstructionInfo;
  tables: ReadonlyMap<string, readonly Row[]>;
} {
  const request = decodeReconstructionRequest(startup.request);
  const limits = decodeReplayLimits(
    startup.options.replayLimits ?? DEFAULT_REPLAY_LIMITS,
  );
  const db = openReadSnapshot(startup.options.path);
  try {
    const reader = new Reader(db);
    const recording = reader.published(request.recordingId);
    const position = selectedPosition(
      recording,
      request.selection,
      request.selection.kind === 'baseline'
        ? undefined
        : reader.transaction(recording.id, request.selection.position),
    );
    const state = new Checkpoints(reader, limits).restore(recording, position);
    const info = decodeReconstructionInfo({
      recording,
      selection: request.selection,
      position: state.position,
      rowCount: state.rowCount,
      retainedBytes: state.retainedBytes,
      limits: state.limits,
    });
    const tables = new Map(
      recording.recording.schema.tables.map((table) => [
        table.id,
        state.rows(table.id),
      ]),
    );
    db.exec('COMMIT');
    return { info, tables };
  } finally {
    db.close();
  }
}

function pageRows(rows: readonly Row[], input: PageRequest): Page<Row> {
  const page = decodePageRequest(input);
  const start = page.cursor === null ? 0n : BigInt(decodePosition(page.cursor));
  if (start > BigInt(rows.length))
    throw new HistoryError(
      'INVALID_VALUE',
      'Reconstruction cursor is outside the selected table.',
    );
  const items: Row[] = [];
  let bytes = 128;
  let offset = Number(start);
  while (offset < rows.length && items.length < page.limit) {
    const row = rows[offset];
    if (!row)
      throw new HistoryError(
        'INVALID_HISTORY',
        'Reconstructed table contains a missing row.',
      );
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (items.length > 0 && bytes + size > MAX_MESSAGE_BYTES - 1024) break;
    items.push(row);
    bytes += size;
    offset++;
  }
  return { items, nextCursor: offset < rows.length ? String(offset) : null };
}

try {
  const startup: Extract<Startup, { kind: 'reconstruction' }> = workerData;
  const snapshot = reconstruct(startup);
  const ready = { id: 0, ok: true, value: snapshot.info } satisfies Response;
  encode(ready);
  port.on('message', (request: Request) => {
    if (request.command.method === 'close') {
      port.postMessage({
        id: request.id,
        ok: true,
        value: null,
      } satisfies Response);
      port.close();
      return;
    }
    let response: Response;
    try {
      encode(request);
      if (request.command.method !== 'reconstructionRows')
        throw new HistoryError(
          'INVALID_VALUE',
          'Unsupported reconstruction command.',
        );
      const [tableId, page] = request.command.args;
      const rows = snapshot.tables.get(decodeStableId(tableId));
      if (!rows)
        throw new HistoryError(
          'INVALID_SCHEMA',
          'Unknown reconstructed table.',
        );
      response = { id: request.id, ok: true, value: pageRows(rows, page) };
      encode(response);
    } catch (error) {
      response = failureResponse(request.id, error);
    }
    port.postMessage(response);
  });
  port.postMessage(ready);
} catch (error) {
  port.postMessage(failureResponse(0, error));
  port.close();
}
