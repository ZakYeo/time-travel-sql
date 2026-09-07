import {
  decodeRecordingMetadata,
  decodeTransaction,
  scalarValue,
} from '@time-travel-sql/sdk';

export const metadata = decodeRecordingMetadata({
  id: 'recording',
  name: 'Orders',
  createdAt: '2026-01-01 00:00:00Z',
  recording: {
    sourceId: 'source',
    epochId: 'epoch',
    schema: {
      version: 1,
      id: 'schema',
      tables: [
        {
          id: 'orders',
          namespace: 'public',
          name: 'orders',
          columns: [
            { name: 'id', type: 'int4', nullable: false, typeModifier: -1 },
          ],
          primaryKey: ['id'],
        },
      ],
    },
  },
});
export const row = (value: string) => ({
  tableId: 'orders',
  row: [scalarValue('int4', value)],
});
export const transaction = (
  position: string,
  previousPosition: string,
  value: string,
) =>
  decodeTransaction(metadata.recording, {
    id: 'tx-' + position,
    sourceId: 'source',
    epochId: 'epoch',
    schemaId: 'schema',
    position,
    previousPosition,
    events: [{ kind: 'insert', tableId: 'orders', after: row(value).row }],
  });
