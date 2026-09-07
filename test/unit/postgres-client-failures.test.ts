import pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { HistoryError } from '@time-travel-sql/sdk';
import { withPostgresClient } from '../../packages/source-postgres/src/owned-client.js';

afterEach(() => vi.restoreAllMocks());
it.each(['INVALID_HISTORY', 'INVALID_SCHEMA'] as const)(
  'preserves %s if availability is lost during cleanup',
  async (code) => {
    const closing = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(
      async () => undefined,
    );
    vi.spyOn(pg.Client.prototype, 'end').mockImplementation(() => {
      entered.resolve();
      return closing.promise;
    });
    const controller = new AbortController();
    const failure = new HistoryError(code, 'Invalid source');
    const pending = withPostgresClient({}, controller.signal, async () => {
      throw failure;
    });
    await entered.promise;
    controller.abort(new HistoryError('SOURCE_UNAVAILABLE', 'Source lost'));
    closing.resolve();
    await expect(pending).rejects.toBe(failure);
  },
);
it('preserves aggregate cleanup failure instead of retrying source unavailability', async () => {
  vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(
    async () => undefined,
  );
  vi.spyOn(pg.Client.prototype, 'end').mockImplementation(async () => {
    throw new Error('Cleanup failed');
  });
  const controller = new AbortController();
  const pending = withPostgresClient({}, controller.signal, async () => {
    controller.abort(new HistoryError('SOURCE_UNAVAILABLE', 'Source lost'));
    throw new HistoryError('SOURCE_UNAVAILABLE', 'Disconnected');
  });
  await expect(pending).rejects.toMatchObject({
    code: 'STORAGE_FAILURE',
    cause: expect.any(AggregateError),
  });
});
