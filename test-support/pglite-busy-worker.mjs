import { parentPort } from 'node:worker_threads';
import { PGlite } from '@electric-sql/pglite';

if (!parentPort) throw new Error('Busy engine fixture requires a parent.');
const db = await PGlite.create();
parentPort.postMessage('executing');
await db.query('SELECT count(*) FROM generate_series(1,1000000000000::bigint)');
parentPort.postMessage('unexpected completion');
await db.close();
parentPort.close();
