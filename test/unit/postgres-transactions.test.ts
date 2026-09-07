import { expect, it } from 'vitest';
import { PostgresTransactions } from '@time-travel-sql/source-postgres';
import {
  decodePosition,
  decodeTransaction,
  rowKey,
} from '@time-travel-sql/sdk';
import {
  baseline,
  recording,
  relation,
  frame,
  begin,
  commit,
  insert,
  expectedRow,
} from '../../test-support/postgres-transaction-fixture.js';

it('exposes a whole commit and advances state only after matching durable confirmation', () => {
  const state = baseline();
  const assembler = new PostgresTransactions(state);
  expect(assembler.push(begin())).toBeUndefined();
  assembler.push(insert());
  assembler.push(
    frame({
      tag: 'update',
      relation,
      key: null,
      old: { id: '1', body: undefined },
      new: { id: '2', body: undefined },
    }),
  );
  const tx = assembler.push(commit());
  if (!tx) throw new Error('Missing commit');
  expect(tx.events).toHaveLength(2);
  expect(tx.id).toBe('pg_4294967295_17');
  expect(tx.committedAtMicros).toBe('946684800000001');
  expect(assembler.durableState).toBe(state);
  assembler.confirmDurable(tx.position);
  expect(assembler.durableState.rows('pg_42')).toEqual([expectedRow('2')]);
  const table = recording.schema.tables[0];
  if (!table) throw new Error('Missing table');
  expect(
    assembler.durableState.row(
      table.id,
      rowKey(recording, table, expectedRow('2')),
    ),
  ).toEqual(expectedRow('2'));
  expect(() => assembler.durableState.row('missing', '')).toThrow();
  assembler.push(begin('0/20', -1n));
  const second = assembler.push(commit('0/20', '0/21', -1n));
  expect(second?.previousPosition).toBe(tx.position);
  expect(second?.committedAtMicros).toBe('-1');
  assembler.close();
  expect(assembler.durableState.position).toBe(tx.position);
});

it('fails closed on missing/nested boundaries, mismatched commits and pending work', () => {
  for (const messages of [
    [insert()],
    [commit()],
    [begin(), begin()],
    [begin(), commit('0/12')],
    [begin(), commit('0/10', '0/10')],
    [begin(), commit('0/10', '0/11', 2n)],
    [begin(), commit(), begin('0/20')],
    [
      begin(),
      frame({
        tag: 'truncate',
        cascade: false,
        restartIdentity: false,
        relations: [relation],
      }),
    ],
  ]) {
    const assembler = new PostgresTransactions(baseline());
    expect(() => {
      for (const message of messages) assembler.push(message);
    }).toThrow();
    expect(assembler.durableState.position).toBe('0');
    expect(() => assembler.push(begin())).toThrow();
  }
  const assembler = new PostgresTransactions(baseline());
  assembler.push(begin());
  assembler.push(commit());
  expect(() => assembler.confirmDurable(decodePosition('18'))).toThrow();
  expect(assembler.durableState.position).toBe('0');
});

it('validates the original event sequence atomically even when an overlay hides a collision', () => {
  const assembler = new PostgresTransactions(baseline());
  assembler.push(begin());
  assembler.push(insert());
  assembler.push(insert());
  expect(() => assembler.push(commit())).toThrow('collides');
  expect(assembler.durableState.rowCount).toBe(0);
});

it('bounds wire messages, wire bytes, canonical event bytes and event count', () => {
  for (const limits of [
    { maxMessages: 1 },
    { maxWireBytes: 1 },
    { maxEvents: 1 },
    { maxEventBytes: 2 },
  ]) {
    const assembler = new PostgresTransactions(baseline(), limits);
    expect(() => {
      assembler.push(begin());
      assembler.push(insert());
      assembler.push(insert('2'));
    }).toThrow('budget');
    expect(assembler.durableState.rowCount).toBe(0);
  }
  expect(
    () => new PostgresTransactions(baseline(), { maxEvents: 10001 }),
  ).toThrow();
});

it('accounts for the empty event-array framing before collecting a transaction', () => {
  expect(
    () => new PostgresTransactions(baseline(), { maxEventBytes: 1 }),
  ).toThrow();
  const assembler = new PostgresTransactions(baseline(), { maxEventBytes: 2 });
  assembler.push(begin());
  expect(assembler.push(commit())?.events).toEqual([]);
});

it('preserves legacy transaction encoding and rejects noncanonical exact times', () => {
  const legacy = {
    id: 'legacy',
    sourceId: 'source',
    epochId: 'epoch',
    schemaId: 'schema',
    previousPosition: '0',
    position: '1',
    events: [],
  };
  expect(JSON.stringify(decodeTransaction(recording, legacy))).toBe(
    JSON.stringify(legacy),
  );
  for (const time of [
    '-0',
    '01',
    '+1',
    '1.5',
    '1e3',
    '1'.repeat(31),
    123,
    null,
    undefined,
  ])
    expect(() =>
      decodeTransaction(recording, { ...legacy, committedAtMicros: time }),
    ).toThrow();
  expect(
    decodeTransaction(recording, { ...legacy, committedAtMicros: '-1' })
      .committedAtMicros,
  ).toBe('-1');
});

it('decodes signed raw PostgreSQL timestamps exactly once across the transport boundary', async () => {
  const { ExactPgoutputPlugin } =
    await import('@time-travel-sql/source-postgres');
  for (const raw of [1n, -1n, -946684800000001n]) {
    const plugin = new ExactPgoutputPlugin('tts_time');
    const beginning = Buffer.alloc(21);
    beginning[0] = 0x42;
    beginning.writeBigUInt64BE(16n, 1);
    beginning.writeBigInt64BE(raw, 9);
    beginning.writeUInt32BE(1, 17);
    const ending = Buffer.alloc(26);
    ending[0] = 0x43;
    ending.writeBigUInt64BE(16n, 2);
    ending.writeBigUInt64BE(17n, 10);
    ending.writeBigInt64BE(raw, 18);
    const assembler = new PostgresTransactions(baseline());
    assembler.push(plugin.parse(beginning));
    const tx = assembler.push(plugin.parse(ending));
    expect(tx?.committedAtMicros).toBe((raw + 946684800000000n).toString());
  }
});
