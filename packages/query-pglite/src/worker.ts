import { parentPort, workerData } from 'node:worker_threads';
import { once } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import {
  decodeDataFields,
  decodeQueryRequest,
  decodeSchema,
  decodeStableId,
  HistoryError,
} from '@time-travel-sql/sdk';
import type { QueryResult } from '@time-travel-sql/sdk';
import { Materializer } from './materialize.js';
import { restrictEngine, executeReadOnly, queryFailure } from './policy.js';

const port = parentPort;
if (!port)
  throw new Error('Historical query worker requires its owned message port.');
let db: PGlite | undefined;
let result: QueryResult | undefined;
const errors: HistoryError[] = [];
try {
  const startup = decodeDataFields(workerData, ['schema', 'request']);
  const schema = decodeSchema(startup.schema);
  const request = decodeQueryRequest(startup.request);
  db = await PGlite.create();
  const loader = new Materializer(db, schema, request.limits);
  await loader.initialize();
  port.postMessage({ kind: 'ready' });
  for (;;) {
    const [input] = await once(port, 'message');
    const command = decodeDataFields(input, ['kind', 'tableId', 'row']);
    if (command.kind === 'load') {
      await loader.load(decodeStableId(command.tableId), command.row);
      port.postMessage({ kind: 'loaded' });
    } else if (
      command.kind === 'prepare' &&
      Object.keys(command).length === 1
    ) {
      break;
    } else
      throw new HistoryError(
        'INVALID_VALUE',
        'Invalid historical query command.',
      );
  }
  await loader.finish();
  await restrictEngine(db);
  port.postMessage({ kind: 'prepared' });
  const [input] = await once(port, 'message');
  const command = decodeDataFields(input, ['kind']);
  if (command.kind !== 'execute')
    throw new HistoryError(
      'INVALID_VALUE',
      'Invalid historical query execution command.',
    );
  result = await executeReadOnly(db, request);
} catch (error) {
  errors.push(queryFailure(error));
} finally {
  try {
    await db?.close();
  } catch (error) {
    errors.push(queryFailure(error));
  }
}
if (errors.length)
  port.postMessage({
    kind: 'error',
    errors: errors.map((error) => ({
      code: error.code,
      message: error.message,
    })),
  });
else port.postMessage({ kind: 'result', result });
port.close();
