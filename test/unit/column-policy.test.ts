import { expect, it } from 'vitest';
import {
  applyColumnPolicy,
  recordedColumnPolicy,
  schemaWithoutColumnPolicy,
  projectRow,
  decodeColumnPolicy,
  decodeRow,
  findTable,
  HistoryState,
  decodePosition,
  decodeTransaction,
  decodeRecordingMetadata,
  scalarValue,
} from '@time-travel-sql/sdk';
import { importRecording } from '@time-travel-sql/exchange';
import {
  recording,
  snapshot,
} from '../../test-support/investigation-fixture.js';
import { metadata } from '../../test-support/storage-fixture.js';
import {
  fixture,
  bytesFrom,
  values,
} from '../../test-support/exchange-fixture.js';

const policy = decodeColumnPolicy({
  version: 1,
  rules: [
    { namespace: 'public', table: 'orders', column: 'note', action: 'redact' },
    {
      namespace: 'public',
      table: 'customers',
      column: 'amount',
      action: 'exclude',
    },
  ],
});

it('canonicalizes deterministic column loss, preserves keys and rejects incompatible policies', () => {
  const schema = applyColumnPolicy(recording.schema, policy);
  expect(
    applyColumnPolicy(recording.schema, {
      ...policy,
      rules: [...policy.rules].reverse(),
    }),
  ).toEqual(schema);
  expect(schemaWithoutColumnPolicy(schema)).toEqual(recording.schema);
  expect(recordedColumnPolicy(schema)).toEqual(policy);
  const secret = 'never-persist-this';
  const input = snapshot('a', '1.00', scalarValue('text', secret)).row;
  const row = projectRow(schema, 'orders', input);
  expect(row[2]).toEqual({ kind: 'unavailable', reason: 'redacted' });
  expect(JSON.stringify(row)).not.toContain(secret);
  expect(projectRow(schema, 'orders', row)).toEqual(row);
  expect(() => decodeRow(findTable(schema, 'orders'), input)).toThrow(
    'column policy',
  );
  expect(() =>
    HistoryState.fromSnapshot({ ...recording, schema }, '0', [
      { tableId: 'orders', row: input },
    ]),
  ).toThrow('column policy');
  for (const rules of [
    [{ ...policy.rules[0], column: 'id' }],
    [{ ...policy.rules[0], column: 'missing' }],
    [{ ...policy.rules[0], table: 'missing' }],
    [policy.rules[0], policy.rules[0]],
  ])
    expect(() =>
      applyColumnPolicy(recording.schema, { version: 1, rules }),
    ).toThrow();
});

it('rejects unmasked storage input and preserves declared loss through portable export/import', async () => {
  await fixture(async (source, target, root) => {
    const schema = applyColumnPolicy(recording.schema, policy);
    const configured = decodeRecordingMetadata({
      ...metadata,
      recording: { ...recording, schema },
    });
    await source.create(configured);
    const raw = snapshot(
      'a',
      '1.00',
      scalarValue('text', 'never-in-sqlite-or-export'),
    ).row;
    await expect(
      source.stageBaseline(configured.id, [{ tableId: 'orders', row: raw }]),
    ).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    const row = projectRow(schema, 'orders', raw);
    await source.stageBaseline(configured.id, [{ tableId: 'orders', row }]);
    await source.publishBaseline(configured.id, decodePosition('0'));
    expect(() =>
      decodeTransaction(configured.recording, {
        id: 'bad',
        sourceId: recording.sourceId,
        epochId: recording.epochId,
        schemaId: schema.id,
        previousPosition: '0',
        position: '10',
        events: [
          { kind: 'update', tableId: 'orders', before: row, after: raw },
        ],
      }),
    ).toThrow('column policy');
    const bytes = await bytesFrom(root);
    expect(bytes.toString()).not.toContain('never-in-sqlite-or-export');
    expect(bytes.toString()).toContain('captureConfigurationFingerprint');
    const imported = await importRecording(
      values([bytes]),
      target,
      new AbortController().signal,
    );
    expect(imported.recording).toEqual(configured.recording);
    expect(
      (await target.baseline(configured.id, { cursor: null, limit: 10 })).items,
    ).toEqual([{ tableId: 'orders', row }]);
  });
});
