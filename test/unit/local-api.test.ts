import { request as httpRequest } from 'node:http';
import type { OutgoingHttpHeaders } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startLocalApi } from '@time-travel-sql/cli';
import type { LocalApi } from '@time-travel-sql/cli';
import { API_LIMITS, API_PATH } from '@time-travel-sql/contracts';

async function fixture(
  work: (api: LocalApi, workspace: string) => Promise<void>,
) {
  const workspace = await mkdtemp(join(tmpdir(), 'tts-http-'));
  const api = await startLocalApi({ workspace });
  try {
    await work(api, workspace);
  } finally {
    await api.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

function call(
  api: LocalApi,
  body: unknown,
  headers: Readonly<Record<string, string | readonly string[]>> = {},
  path = API_PATH,
  method = 'POST',
) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const fields: Readonly<Record<string, string | readonly string[]>> = {
    host: new URL(api.origin).host,
    authorization: 'Bearer ' + api.token,
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    ...headers,
  };
  return new Promise<{
    status: number;
    headers: OutgoingHttpHeaders;
    data: unknown;
  }>((done, reject) => {
    const request = httpRequest(
      api.origin + path,
      {
        method,
        headers: Object.entries(fields).flatMap(([name, value]) =>
          typeof value === 'string'
            ? [name, value]
            : value.flatMap((item) => [name, item]),
        ),
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            done({
              status: response.statusCode ?? 0,
              headers: response.headers,
              data: JSON.parse(text),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once('error', reject);
    request.end(payload);
  });
}

it('protects actual loopback operations and preserves stored recording context across server sessions', async () => {
  await fixture(async (api, workspace) => {
    const sample = { version: 1, operation: 'sample' };
    for (const headers of [
      { authorization: '' },
      { authorization: 'Bearer wrong' },
      { origin: 'https://untrusted.example' },
      { origin: 'null' },
      { host: 'untrusted.example' },
      { 'sec-fetch-site': 'cross-site' },
    ]) {
      const result = await call(api, sample, headers);
      expect([401, 403]).toContain(result.status);
      expect(result.data).toMatchObject({ version: 1, ok: false });
    }
    const list = {
      version: 1,
      operation: 'list',
      page: { limit: 10, cursor: null },
    };
    expect((await call(api, list)).data).toMatchObject({ data: { items: [] } });
    const loaded = await call(api, sample, { origin: api.origin });
    expect(loaded.status).toBe(200);
    expect(loaded.headers['cache-control']).toBe('no-store');
    expect(loaded.headers['access-control-allow-origin']).toBeUndefined();
    expect(loaded.data).toMatchObject({
      version: 1,
      ok: true,
      operation: 'sample',
      data: {
        id: 'sample-checkout-v1',
        sourceId: 'sample-checkout',
        derivation: null,
        baselinePosition: '0',
        headPosition: '40',
        transactionCount: 4,
      },
    });
    const recordingId = 'sample-checkout-v1';
    expect(
      (
        await call(api, {
          version: 1,
          operation: 'transaction',
          recordingId,
          position: '20',
        })
      ).data,
    ).toMatchObject({
      data: {
        recordingId,
        transaction: {
          position: '20',
          context: { requestId: 'sample-request-2' },
        },
      },
    });
    expect(
      (
        await call(api, {
          version: 1,
          operation: 'transactions',
          recordingId,
          page: { limit: 1, cursor: null },
        })
      ).data,
    ).toMatchObject({
      data: { page: { items: [{ position: '10' }], nextCursor: '10' } },
    });
    await api.close();
    await api.closed;
    const reopened = await startLocalApi({ workspace });
    try {
      expect(reopened.token).not.toBe(api.token);
      expect(
        (await call(reopened, list, { authorization: 'Bearer ' + api.token }))
          .status,
      ).toBe(401);
      expect((await call(reopened, list)).data).toMatchObject({
        data: { items: [{ id: recordingId }] },
      });
    } finally {
      await reopened.close();
    }
  });
});

it('rejects malformed, oversized, unsupported and ambiguous requests before mutation', async () => {
  await fixture(async (api) => {
    for (const [body, headers, expected] of [
      ['{', {}, 400],
      [
        { version: 1, operation: 'sample' },
        { authorization: ['Bearer ' + api.token, 'Bearer duplicate'] },
        400,
      ],
      [{ version: 2, operation: 'sample' }, {}, 422],
      [{ version: 1, operation: 'sample', path: '/tmp/arbitrary' }, {}, 422],
      [
        { version: 1, operation: 'sample' },
        { 'content-type': 'text/plain' },
        415,
      ],
      [' '.repeat(API_LIMITS.requestBytes + 1), {}, 413],
      [
        { version: 1, operation: 'sample' },
        Object.fromEntries(
          Array.from({ length: 41 }, (_, index) => ['x-extra-' + index, 'a']),
        ),
        400,
      ],
    ] as const)
      expect((await call(api, body, headers)).status).toBe(expected);
    expect((await call(api, {}, {}, '/unknown')).status).toBe(404);
    expect((await call(api, {}, {}, API_PATH, 'GET')).status).toBe(405);
    expect(
      (
        await call(api, {
          version: 1,
          operation: 'list',
          page: { limit: 10, cursor: null },
        })
      ).data,
    ).toMatchObject({ data: { items: [] } });
  });
});

it('bounds unfinished bodies and drains accepted connections on idempotent shutdown', async () => {
  await fixture(async (api) => {
    const incomplete = [];
    for (let index = 0; index < API_LIMITS.activeRequests; index++) {
      const request = httpRequest(api.origin + API_PATH, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + api.token,
          'content-type': 'application/json',
          'content-length': '100',
          expect: '100-continue',
        },
      });
      request.on('error', () => undefined);
      const ready = new Promise<void>((done) => request.once('continue', done));
      request.flushHeaders();
      await ready;
      incomplete.push(request);
    }
    expect((await call(api, { version: 1, operation: 'sample' })).status).toBe(
      429,
    );
    const closed = incomplete.map(
      (request) => new Promise<void>((done) => request.once('close', done)),
    );
    await Promise.all([api.close(), api.close(), ...closed]);
    await expect(call(api, {})).rejects.toThrow();
  });
});

it('rejects an occupied port and leaves its workspace reopenable', async () => {
  await fixture(async (api, workspace) => {
    await expect(
      startLocalApi({ workspace, port: Number(new URL(api.origin).port) }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    const other = await startLocalApi({ workspace });
    await other.close();
    await expect(
      // @ts-expect-error remote binding is not an accepted public option
      startLocalApi({ workspace, host: '0.0.0.0' }),
    ).rejects.toMatchObject({ code: 'INVALID_VALUE' });
  });
});
