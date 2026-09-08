import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type * as Http from 'node:http';
import type * as Storage from '@time-travel-sql/storage-local';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startLocalApi } from '@time-travel-sql/cli';

const faults = vi.hoisted(() => ({
  closeFailure: false,
  closedStores: 0,
  server: undefined as Server | undefined,
}));
vi.mock('@time-travel-sql/storage-local', async (original) => {
  const real = await original<typeof Storage>();
  return {
    ...real,
    openLocalStore: async (...args: Parameters<typeof real.openLocalStore>) => {
      const store = await real.openLocalStore(...args);
      return {
        ...store,
        close: async () => {
          await store.close();
          faults.closedStores++;
          if (faults.closeFailure) throw new Error('Injected close failure');
        },
      };
    },
  };
});
vi.mock('node:http', async (original) => {
  const real = await original<typeof Http>();
  return {
    ...real,
    createServer: (...args: Parameters<typeof real.createServer>) => {
      const server = real.createServer(...args);
      faults.server = server;
      return server;
    },
  };
});

it('retains bind and cleanup errors together and closes the acquired store', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tts-api-start-'));
  const occupied = createServer();
  await new Promise<void>((done) => occupied.listen(0, '127.0.0.1', done));
  const address = occupied.address();
  if (!address || typeof address === 'string') throw new Error('Expected port');
  const before = faults.closedStores;
  faults.closeFailure = true;
  try {
    await expect(
      startLocalApi({ workspace, port: address.port }),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ code: 'EADDRINUSE' }),
        expect.objectContaining({ message: 'Injected close failure' }),
      ],
    });
    expect(faults.closedStores).toBe(before + 1);
  } finally {
    faults.closeFailure = false;
    await new Promise<void>((done) => occupied.close(() => done()));
    await rm(workspace, { recursive: true, force: true });
  }
});

it('owns runtime server errors and reports them through the closed promise', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tts-api-runtime-'));
  const api = await startLocalApi({ workspace });
  const failure = new Error('Injected server failure');
  const before = faults.closedStores;
  try {
    faults.server?.emit('error', failure);
    await expect(api.closed).rejects.toBe(failure);
    await expect(api.close()).rejects.toBe(failure);
    expect(faults.closedStores).toBe(before + 1);
  } finally {
    await api.close().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
});
