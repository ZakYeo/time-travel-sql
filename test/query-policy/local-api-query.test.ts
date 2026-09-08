import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startLocalApi } from '@time-travel-sql/cli';
import { API_PATH } from '@time-travel-sql/contracts';

it('returns authoritative historical positions and real read-only SQL results over HTTP', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tts-api-query-'));
  const api = await startLocalApi({ workspace });
  const call = async (input: unknown, signal?: AbortSignal) => {
    const response = await fetch(api.origin + API_PATH, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + api.token,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
      ...(signal === undefined ? {} : { signal }),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    expect((await call({ version: 1, operation: 'sample' })).status).toBe(200);
    const query = {
      version: 1,
      operation: 'query',
      recordingId: 'sample-checkout-v1',
      query: { sql: "SELECT total FROM orders WHERE id='order-2'" },
    };
    const before = await call({
      ...query,
      selection: { kind: 'before', position: '30' },
    });
    expect(before.status).toBe(200);
    expect(before.data).toMatchObject({
      version: 1,
      operation: 'query',
      data: {
        recordingId: 'sample-checkout-v1',
        selection: { kind: 'before', position: '30' },
        position: '20',
        rows: [['199']],
        elapsedMs: expect.any(Number),
        limits: { maxRows: 1000 },
      },
    });
    const after = await call({
      ...query,
      selection: { kind: 'after', position: '30' },
    });
    expect(after.data).toMatchObject({
      data: { position: '30', rows: [['398']] },
    });
    const write = await call({
      ...query,
      selection: { kind: 'after', position: '30' },
      query: { sql: 'DELETE FROM orders' },
    });
    expect(write.status).toBe(422);
    expect(write.data).toMatchObject({
      ok: false,
      error: { code: 'QUERY_REJECTED' },
    });
    const missing = await call({
      ...query,
      selection: { kind: 'after', position: '29' },
    });
    expect(missing.status).toBe(422);
    expect(missing.data).toMatchObject({
      ok: false,
      error: { code: 'INVALID_HISTORY' },
    });
  } finally {
    await api.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
