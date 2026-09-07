import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeRecordingFrames,
  encodeRecordingFrames,
  DEFAULT_EXCHANGE_LIMITS,
} from '@time-travel-sql/exchange';
import type { ExchangeLimits } from '@time-travel-sql/exchange';

const HEADER = '{"format":"time-travel-sql-frames","version":1}\n';
const limits = { ...DEFAULT_EXCHANGE_LIMITS, maxRecordBytes: 4096 };
const signal = () => new AbortController().signal;
async function* values<T>(items: readonly T[]): AsyncGenerator<T> {
  yield* items;
}
async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}
// Independent wire fixture: no production encoder is involved.
function wire(records: readonly string[]): Buffer {
  const body =
    HEADER + records.map((value) => '{"record":' + value + '}\n').join('');
  const hash = createHash('sha256').update(body).digest('hex');
  return Buffer.from(
    body + JSON.stringify({ end: records.length, sha256: hash }) + '\n',
  );
}
function decode(bytes: Uint8Array, options: ExchangeLimits = limits) {
  return collect(decodeRecordingFrames(values([bytes]), signal(), options));
}

describe('portable recording framing', () => {
  it.each(['encode', 'decode'])(
    'allows timer cancellation during buffered %s work',
    async (mode) => {
      const controller = new AbortController();
      const records = Array.from({ length: 20000 }, () => '1');
      const stream =
        mode === 'encode'
          ? encodeRecordingFrames(values(records), controller.signal, limits)
          : decodeRecordingFrames(
              values([wire(records)]),
              controller.signal,
              limits,
            );
      let consumed = 0;
      const timer = setTimeout(() => controller.abort(), 0);
      try {
        const consume = async () => {
          for await (const value of stream) {
            expect(value).toBeDefined();
            consumed++;
          }
        };
        await expect(consume()).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(consumed).toBeLessThan(records.length);
      } finally {
        clearTimeout(timer);
        await stream.return(undefined);
      }
    },
  );
  it('reads an independent fixture at every byte split, including UTF-8 boundaries', async () => {
    const records = [
      '{"text":"雪🦆\\n\\"","integer":"9223372036854775807"}',
      'null',
      '[true,false]',
    ];
    const bytes = wire(records);
    const expected = records.map((value): unknown => JSON.parse(value));
    for (let split = 1; split < bytes.length; split++) {
      const chunks = values([bytes.subarray(0, split), bytes.subarray(split)]);
      expect(
        await collect(decodeRecordingFrames(chunks, signal(), limits)),
      ).toEqual(expected);
    }
    expect(
      await collect(
        decodeRecordingFrames(
          values([...bytes].map((byte) => new Uint8Array([byte]))),
          signal(),
          limits,
        ),
      ),
    ).toEqual(expected);
  });

  it('emits the independent wire format and supports an empty framed stream', async () => {
    for (const records of [[], ['{"a":1}', '"雪"']]) {
      const chunks = await collect(
        encodeRecordingFrames(values(records), signal(), limits),
      );
      expect(Buffer.concat(chunks)).toEqual(wire(records));
      expect(await decode(Buffer.concat(chunks))).toHaveLength(records.length);
    }
  });

  it.each([
    ['missing trailer', Buffer.from(HEADER + '{"record":1}\n')],
    ['missing final LF', wire(['1']).subarray(0, -1)],
    ['empty input', Buffer.alloc(0)],
    ['blank line', Buffer.from(HEADER + '\n')],
    ['CRLF', Buffer.from(HEADER.replace('\n', '\r\n'))],
    ['BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), wire([])])],
    [
      'bad UTF-8',
      Buffer.concat([
        Buffer.from(HEADER + '{"record":"'),
        Buffer.from([0xc0, 0xaf]),
        Buffer.from('"}\n'),
      ]),
    ],
    ['future version', Buffer.from(HEADER.replace(':1}', ':2}'))],
    ['trailing data', Buffer.concat([wire([]), Buffer.from('{}\n')])],
    ['duplicate trailer', Buffer.concat([wire([]), wire([])])],
    [
      'checksum mutation',
      Buffer.from(wire(['1']).toString().replace('"record":1', '"record":2')),
    ],
    [
      'count mutation',
      Buffer.from(wire([]).toString().replace('"end":0', '"end":1')),
    ],
    ['duplicate object key', wire(['{"a":1,"a":2}'])],
    ['whitespace', wire(['{ "a":1}'])],
    ['rounded number', wire(['9007199254740993'])],
    ['extra frame field', Buffer.from(HEADER + '{"record":1,"extra":2}\n')],
  ])('rejects %s', async (_name, bytes) => {
    await expect(decode(bytes)).rejects.toMatchObject({
      code: expect.stringMatching(/INVALID_HISTORY|INVALID_VALUE/),
    });
  });

  it('bounds bytes, record count, depth and structural work before accepting the stream', async () => {
    const bytes = wire(['[1,2,3]', '{}']);
    await expect(
      decode(bytes, { ...limits, maxTotalBytes: bytes.length - 1 }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(
      decode(bytes, { ...limits, maxRecords: 1 }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(
      decode(wire(['[[[]]]']), { ...limits, maxDepth: 3 }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(
      decode(wire(['[1,2,3,4,5,6,7,8]']), {
        ...limits,
        maxStructuralTokens: 6,
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(
      decode(wire([JSON.stringify('x'.repeat(200))]), {
        ...limits,
        maxRecordBytes: 128,
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(
      decode(Buffer.from('x'.repeat(129)), { ...limits, maxRecordBytes: 128 }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(
      await decode(bytes, {
        ...limits,
        maxTotalBytes: bytes.length,
        maxRecords: 2,
      }),
    ).toEqual([[1, 2, 3], {}]);
  });

  it.each(['1,"extra":2', '{"a":1,"a":2}', 'undefined', '"\ud800"'])(
    'rejects invalid encoder text %s',
    async (record) => {
      await expect(
        collect(encodeRecordingFrames(values([record]), signal(), limits)),
      ).rejects.toBeDefined();
    },
  );

  it('bounds encoder work and rejects accessor-based limits without invoking them', async () => {
    await expect(
      collect(
        encodeRecordingFrames(values(['1', '2']), signal(), {
          ...limits,
          maxRecords: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(
      collect(
        encodeRecordingFrames(values(['"雪雪雪雪"']), signal(), {
          ...limits,
          maxTotalBytes: 50,
        }),
      ),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const getter = vi.fn(() => 100);
    const options = {
      ...limits,
      get maxDepth() {
        return getter();
      },
    };
    await expect(decode(wire([]), options)).rejects.toMatchObject({
      code: 'INVALID_VALUE',
    });
    expect(getter).not.toHaveBeenCalled();
    await expect(
      decode(wire([]), { ...limits, maxDepth: 65 }),
    ).rejects.toMatchObject({ code: 'INVALID_VALUE' });
  });

  it('closes source iterators on early return, parse failure and cancellation', async () => {
    for (const action of ['return', 'abort', 'bad-input']) {
      const closed = vi.fn();
      const controller = new AbortController();
      async function* source() {
        try {
          yield Buffer.from(
            HEADER + (action === 'bad-input' ? '{}\n' : '{"record":1}\n'),
          );
          throw new Error('Unexpected further pull.');
        } finally {
          closed();
        }
      }
      const reader = decodeRecordingFrames(source(), controller.signal, limits);
      if (action === 'bad-input')
        await expect(reader.next()).rejects.toMatchObject({
          code: 'INVALID_HISTORY',
        });
      else {
        expect(await reader.next()).toEqual({ done: false, value: 1 });
        if (action === 'return') await reader.return(undefined);
        else {
          controller.abort();
          await expect(reader.next()).rejects.toMatchObject({
            code: 'CANCELLED',
          });
        }
      }
      expect(closed).toHaveBeenCalledOnce();
    }
  });

  it('does not pull a source when already cancelled, including after yielding the encoder header', async () => {
    const next = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source = { [Symbol.asyncIterator]: () => ({ next }) };
    const controller = new AbortController();
    const encoder = encodeRecordingFrames(source, controller.signal, limits);
    await encoder.next();
    controller.abort();
    await expect(encoder.next()).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(
      collect(decodeRecordingFrames(source, controller.signal, limits)),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(next).not.toHaveBeenCalled();
  });
});
