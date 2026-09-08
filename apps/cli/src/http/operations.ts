import { fileURLToPath } from 'node:url';
import { API_VERSION, recordingView } from '@time-travel-sql/contracts';
import type { ApiRequest, ApiSuccess } from '@time-travel-sql/contracts';
import type { LocalStore } from '@time-travel-sql/storage-local';
import { createLocalReconstructor } from '@time-travel-sql/storage-local';
import { createHistoricalQueryEngine } from '@time-travel-sql/query-pglite';
import { importRecordingFile } from '@time-travel-sql/exchange';
import { owned } from '../owned.js';

/** Transport composition calls public application services, never CLI parsing. */
export async function operation(
  request: ApiRequest,
  store: LocalStore,
  path: string,
  signal: AbortSignal,
): Promise<ApiSuccess> {
  const envelope = { version: API_VERSION, ok: true } as const;
  signal.throwIfAborted();
  switch (request.operation) {
    case 'sample':
      return {
        ...envelope,
        operation: 'sample',
        data: recordingView(
          await importRecordingFile(
            fileURLToPath(
              new URL('../../assets/checkout.tts', import.meta.url),
            ),
            store,
            signal,
          ),
        ),
      };
    case 'list': {
      const page = await store.list(request.page);
      return {
        ...envelope,
        operation: 'list',
        data: { ...page, items: page.items.map(recordingView) },
      };
    }
    case 'inspect':
      return {
        ...envelope,
        operation: 'inspect',
        data: recordingView(await store.info(request.recordingId)),
      };
    case 'rename':
      return {
        ...envelope,
        operation: 'rename',
        data: recordingView(
          await store.rename(request.recordingId, request.name),
        ),
      };
    case 'remove':
      await store.remove(request.recordingId);
      return {
        ...envelope,
        operation: 'remove',
        data: { recordingId: request.recordingId, removed: true },
      };
    case 'transactions':
      return {
        ...envelope,
        operation: 'transactions',
        data: {
          recordingId: request.recordingId,
          page: await store.transactions(request.recordingId, request.page),
        },
      };
    case 'transaction':
      return {
        ...envelope,
        operation: 'transaction',
        data: {
          recordingId: request.recordingId,
          transaction: await store.transaction(
            request.recordingId,
            request.position,
          ),
        },
      };
    case 'query': {
      const started = performance.now();
      return owned(createLocalReconstructor({ path }), async (provider) =>
        owned(
          await provider.open(
            { recordingId: request.recordingId, selection: request.selection },
            signal,
          ),
          (view) =>
            owned(createHistoricalQueryEngine(), async (engine) => ({
              ...envelope,
              operation: 'query',
              data: {
                recordingId: request.recordingId,
                selection: view.info.selection,
                position: view.info.position,
                limits: request.query.limits,
                ...(await engine.query(view, request.query, signal)),
                elapsedMs: performance.now() - started,
              },
            })),
        ),
      );
    }
  }
}
