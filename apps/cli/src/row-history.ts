import { setImmediate } from 'node:timers/promises';
import { inspectRowHistory } from '@time-travel-sql/sdk';
import { createLocalExporter } from '@time-travel-sql/storage-local';
import { selection } from './selection.js';
import { owned } from './owned.js';

export async function rowHistory(
  path: string,
  operands: readonly string[],
  options: { limit?: string; offset?: string },
  signal: AbortSignal,
) {
  const [id = '', tableId = '', anchor = '', key = ''] = operands;
  const request = {
    tableId,
    key,
    selection: selection(anchor),
    options: {
      limit: Number(options.limit ?? '50'),
      offset: Number(options.offset ?? '0'),
    },
  };
  return owned(createLocalExporter({ path }), async (provider) =>
    owned(await provider.open(id, signal), (history) =>
      inspectRowHistory(history, request, {
        signal,
        cooperate: async () => {
          await setImmediate();
        },
      }),
    ),
  );
}
