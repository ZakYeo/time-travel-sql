import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openLocalStore,
  createLocalExporter,
} from '@time-travel-sql/storage-local';
import type { LocalStore } from '@time-travel-sql/storage-local';
import { exportRecording } from '@time-travel-sql/exchange';
import { decodePosition } from '@time-travel-sql/sdk';
import { metadata, row, transaction } from './storage-fixture.js';

export async function* values<T>(input: readonly T[]): AsyncGenerator<T> {
  yield* input;
}
export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of source) result.push(value);
  return result;
}
export const signal = () => new AbortController().signal;
export const page = { cursor: null, limit: 100 };
export async function fixture(
  work: (source: LocalStore, target: LocalStore, root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'tts-exchange-'));
  const stores: LocalStore[] = [];
  const errors: unknown[] = [];
  try {
    const source = await openLocalStore({ path: join(root, 'source.sqlite') });
    stores.push(source);
    const target = await openLocalStore({ path: join(root, 'target.sqlite') });
    stores.push(target);
    await work(source, target, root);
  } catch (error) {
    errors.push(error);
  }
  const results = await Promise.allSettled(
    stores.map((store) => store.close()),
  );
  for (const result of results)
    if (result.status === 'rejected') errors.push(result.reason);
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, 'Exchange fixture failed.');
}
export async function seed(store: LocalStore) {
  await store.create(metadata);
  await store.bindCapture(metadata.id, {
    adapter: 'test',
    version: 1,
    payload: 'source-owned-receipt',
  });
  await store.stageBaseline(metadata.id, [row('1')]);
  await store.publishBaseline(metadata.id, decodePosition('0'));
  await store.append(metadata.id, transaction('10', '0', '2'));
}
export async function bytesFrom(root: string): Promise<Buffer> {
  const exporter = createLocalExporter({ path: join(root, 'source.sqlite') });
  try {
    const session = await exporter.open(metadata.id);
    try {
      return Buffer.concat(await collect(exportRecording(session, signal())));
    } finally {
      await session.close();
    }
  } finally {
    await exporter.close();
  }
}
