import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { ReplayWork } from '../../packages/storage-local/src/replay-work.js';
import { readRecord } from '../../packages/storage-local/src/integrity.js';

it('charges failed integrity and JSON decoding attempts before processing more candidates', () => {
  const work = new ReplayWork(100);
  const data = 'x'.repeat(60);
  expect(() => readRecord({ data, digest: 'bad' }, work)).toThrow('integrity');
  expect(() => readRecord({ data, digest: 'bad' }, work)).toThrow(
    'operation budget',
  );
  const parsing = new ReplayWork(100);
  const digest = createHash('sha256').update(data).digest('hex');
  expect(() => readRecord({ data, digest }, parsing)).toThrow('JSON');
  expect(() => readRecord({ data, digest }, parsing)).toThrow(
    'operation budget',
  );
});

it('charges raw UTF-8 bytes even when decoding will reject the row', () => {
  const work = new ReplayWork(100);
  const data = '漢'.repeat(20);
  expect(() => readRecord({ data, digest: 'bad' }, work)).toThrow('integrity');
  expect(() => readRecord({ data, digest: 'bad' }, work)).toThrow(
    'operation budget',
  );
});
