import type * as SDK from '@time-travel-sql/sdk';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  HistoryError,
  decodeRecordingInfo,
  resumeRecording,
} from '@time-travel-sql/sdk';
import type {
  ResumeStore,
  HistoryReconstructor,
  RecordingSession,
  RecordingInfo,
} from '@time-travel-sql/sdk';
import { resumePostgresRecording } from '@time-travel-sql/source-postgres';
import { metadata } from '../../test-support/storage-fixture.js';
import { postgresFailure } from '../../packages/source-postgres/src/source-errors.js';

vi.mock('@time-travel-sql/sdk', async (original) => ({
  ...(await original<typeof SDK>()),
  resumeRecording: vi.fn(),
}));
const resume = vi.mocked(resumeRecording);
const info = decodeRecordingInfo({
  ...metadata,
  status: 'interrupted',
  baselinePosition: '0',
  headPosition: '0',
  baselineRowCount: 0,
  baselineChecksum: 'a'.repeat(64),
  transactionCount: 0,
});
const store: ResumeStore = {
  info: vi.fn(async () => info),
  async transaction() {
    throw new Error('Unexpected transaction read');
  },
  async captureBinding() {
    return null;
  },
  async prepareRecording() {
    throw new Error('Unexpected prepare');
  },
};
const reconstructor: HistoryReconstructor = {
  async open() {
    throw new Error('Unexpected reconstruction');
  },
  async close() {},
};
const connection = {
  host: '/unused',
  port: 5432,
  database: 'unused',
  user: 'unused',
};
const unavailable = () =>
  new HistoryError('SOURCE_UNAVAILABLE', 'Source disconnected');
function active() {
  const result = Promise.withResolvers<RecordingInfo>();
  const session: RecordingSession = {
    done: result.promise,
    stop: vi.fn(() => {
      result.resolve({ ...info, status: 'stopped' });
      return result.promise;
    }),
  };
  return { result, session };
}
beforeEach(() => {
  vi.useFakeTimers();
  resume.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

it('uses capped exponential delay and a lifetime budget across successful restarts', async () => {
  const first = active();
  const second = active();
  resume
    .mockRejectedValueOnce(unavailable())
    .mockResolvedValueOnce(first.session)
    .mockResolvedValueOnce(second.session);
  const session = resumePostgresRecording(
    store,
    reconstructor,
    connection,
    metadata.id,
    { maxRetries: 2, initialDelayMs: 10, maxDelayMs: 15 },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(session.status()).toMatchObject({
    phase: 'waiting-to-retry',
    retries: 1,
  });
  await vi.advanceTimersByTimeAsync(9);
  expect(resume).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(session.status().phase).toBe('recording');
  first.result.reject(unavailable());
  await vi.advanceTimersByTimeAsync(14);
  expect(resume).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(resume).toHaveBeenCalledTimes(3);
  second.result.reject(unavailable());
  await expect(session.done).rejects.toMatchObject({
    code: 'SOURCE_UNAVAILABLE',
  });
  expect(session.status()).toMatchObject({ phase: 'failed', retries: 2 });
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  'INVALID_HISTORY',
  'INVALID_SCHEMA',
  'LIMIT_EXCEEDED',
  'STORAGE_FAILURE',
  'CANCELLED',
] as const)(
  'does not retry %s, even when its cause is source unavailability',
  async (code) => {
    const error = new HistoryError(code, 'Terminal failure', {
      cause: unavailable(),
    });
    resume.mockRejectedValue(error);
    const session = resumePostgresRecording(
      store,
      reconstructor,
      connection,
      metadata.id,
    );
    await expect(session.done).rejects.toBe(error);
    expect(resume).toHaveBeenCalledTimes(1);
  },
);

it.each(['stop', 'abort'] as const)(
  'cancels backoff through %s without reopening or rewriting history',
  async (action) => {
    const controller = new AbortController();
    resume.mockRejectedValue(unavailable());
    const session = resumePostgresRecording(
      store,
      reconstructor,
      connection,
      metadata.id,
      { signal: controller.signal },
    );
    await vi.advanceTimersByTimeAsync(0);
    if (action === 'stop') expect(await session.stop()).toBe(info);
    else {
      controller.abort();
      await expect(session.done).rejects.toMatchObject({ code: 'CANCELLED' });
    }
    expect(resume).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('stop waits for the active recorder completion and retains cleanup failures', async () => {
  const current = active();
  const failure = new HistoryError('STORAGE_FAILURE', 'Cleanup failed');
  vi.mocked(current.session.stop).mockImplementation(
    () => current.result.promise,
  );
  resume.mockResolvedValue(current.session);
  const session = resumePostgresRecording(
    store,
    reconstructor,
    connection,
    metadata.id,
  );
  await vi.advanceTimersByTimeAsync(0);
  const stopping = session.stop();
  expect(stopping).toBe(session.stop());
  current.result.reject(failure);
  await expect(stopping).rejects.toBe(failure);
  expect(resume).toHaveBeenCalledTimes(1);
});

it('stop cancels startup but still waits for failed-attempt cleanup', async () => {
  const cleanup = Promise.withResolvers<void>();
  resume.mockImplementation(async (_store, _reader, _source, _id, signal) => {
    await new Promise<void>((resolve) =>
      signal?.addEventListener('abort', resolve, { once: true }),
    );
    await cleanup.promise;
    throw new HistoryError('CANCELLED', 'Startup cancelled');
  });
  const session = resumePostgresRecording(
    store,
    reconstructor,
    connection,
    metadata.id,
  );
  const stopped = session.stop();
  let settled = false;
  void stopped.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  cleanup.resolve();
  expect(await stopped).toBe(info);
});

it.each(['ECONNRESET', 'ECONNREFUSED', '57P01', '57P03'])(
  'classifies transport code %s without exposing its message',
  (code) => {
    const failure = postgresFailure(
      Object.assign(new Error('private detail'), { code }),
      'Safe diagnostic',
    );
    expect(failure).toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
      message: 'Safe diagnostic',
    });
  },
);
it.each(['28P01', '08P01', 'ENOSPC', '53100'])(
  'keeps code %s terminal',
  (code) => {
    expect(
      postgresFailure(
        Object.assign(new Error('detail'), { code }),
        'Safe diagnostic',
      ).code,
    ).toBe('STORAGE_FAILURE');
  },
);
it('does not promote aggregate cleanup failures to retryable', () => {
  expect(
    postgresFailure(new AggregateError([unavailable()]), 'Cleanup').code,
  ).toBe('STORAGE_FAILURE');
});

it('does not hide external cancellation when stop is requested in the same tick', async () => {
  const controller = new AbortController();
  resume.mockRejectedValue(unavailable());
  const session = resumePostgresRecording(
    store,
    reconstructor,
    connection,
    metadata.id,
    { signal: controller.signal },
  );
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await expect(session.stop()).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(session.status().phase).toBe('failed');
});

it('does not hide an active recorder cancellation already queued before stop', async () => {
  const current = active();
  resume.mockResolvedValue(current.session);
  const session = resumePostgresRecording(
    store,
    reconstructor,
    connection,
    metadata.id,
  );
  await vi.advanceTimersByTimeAsync(0);
  const failure = new HistoryError(
    'CANCELLED',
    'Independent source cancellation',
  );
  current.result.reject(failure);
  await expect(session.stop()).rejects.toBe(failure);
});

it('does not hide an independent startup cancellation queued before stop', async () => {
  const failure = new HistoryError(
    'CANCELLED',
    'Independent startup cancellation',
  );
  resume.mockRejectedValue(failure);
  const session = resumePostgresRecording(
    store,
    reconstructor,
    connection,
    metadata.id,
  );
  await expect(session.stop()).rejects.toBe(failure);
});
