import { expect, it } from 'vitest';
import { ExactPgoutputPlugin } from '../../packages/source-postgres/src/index.js';

it('returns decoder failures to the asynchronous consumer instead of throwing in a socket callback', () => {
  const plugin = new ExactPgoutputPlugin('tts_test');
  expect(plugin.parse(Buffer.from([0x49])).result).toMatchObject({
    kind: 'error',
    error: { code: 'INVALID_EVENT' },
  });
});

it('rejects message limits and unsafe publication names', () => {
  expect(() => new ExactPgoutputPlugin("tts_bad'")).toThrow();
  expect(() => new ExactPgoutputPlugin('tts_test', 0)).toThrow();
  const plugin = new ExactPgoutputPlugin('tts_test', 16);
  expect(plugin.parse(Buffer.alloc(17)).result).toMatchObject({
    kind: 'error',
    error: { code: 'LIMIT_EXCEEDED' },
  });
});

it('preserves unsigned transaction and cached relation identities above the signed boundary', () => {
  const plugin = new ExactPgoutputPlugin('tts_test');
  const begin = Buffer.alloc(21);
  begin[0] = 0x42;
  begin.writeUInt32BE(0x80000001, 17);
  expect(plugin.parse(begin).result).toMatchObject({
    kind: 'message',
    message: { tag: 'begin', xid: 2147483649 },
  });
  const oid = Buffer.alloc(4);
  oid.writeUInt32BE(0xf0000001);
  const relation = Buffer.concat([
    Buffer.from('R'),
    oid,
    Buffer.from('public\0selected\0'),
    Buffer.from([0x66, 0, 1, 1]),
    Buffer.from('id\0'),
    Buffer.from([0, 0, 0, 23, 255, 255, 255, 255]),
  ]);
  expect(plugin.parse(relation).result).toMatchObject({
    kind: 'message',
    message: { tag: 'relation', relationOid: 4026531841 },
  });
  const insert = Buffer.concat([
    Buffer.from('I'),
    oid,
    Buffer.from([0x4e, 0, 1, 0x74, 0, 0, 0, 1]),
    Buffer.from('1'),
  ]);
  expect(plugin.parse(insert).result).toMatchObject({
    kind: 'message',
    message: {
      tag: 'insert',
      relation: { relationOid: 4026531841 },
      new: { id: '1' },
    },
  });
});
