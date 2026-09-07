import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import {
  readFile,
  readdir,
  writeFile,
  symlink,
  readlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createLocalExporter } from '@time-travel-sql/storage-local';
import type { HistoryExports, RecordingExport } from '@time-travel-sql/sdk';
import {
  exportRecordingFile,
  importRecordingFile,
  DEFAULT_EXCHANGE_LIMITS,
} from '@time-travel-sql/exchange';
import {
  fixture,
  seed,
  signal,
  page,
  bytesFrom,
} from '../../test-support/exchange-fixture.js';
import { metadata, transaction } from '../../test-support/storage-fixture.js';

it.each(['valid', 'malformed'] as const)(
  'retains input close failures for %s input and publishes nothing',
  async (kind) => {
    await fixture(async (source, target, root) => {
      await seed(source);
      const file = join(root, 'close-failure.tts');
      await writeFile(file, kind === 'valid' ? await bytesFrom(root) : 'bad\n');
      const originalOpen = fs.open;
      const closeFailure = new Error('injected input close failure');
      const close = vi.fn();
      const mock = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (args[0] === file) {
          const originalClose = handle.close.bind(handle);
          handle.close = async () => {
            await originalClose();
            close();
            throw closeFailure;
          };
        }
        return handle;
      });
      syncBuiltinESMExports();
      try {
        const result = await importRecordingFile(file, target, signal()).catch(
          (error: unknown) => error,
        );
        if (kind === 'valid')
          expect(result).toMatchObject({
            code: 'STORAGE_FAILURE',
            cause: closeFailure,
          });
        else {
          expect(result).toBeInstanceOf(AggregateError);
          if (!(result instanceof AggregateError))
            throw new Error('Expected aggregate failure');
          expect(result.errors).toHaveLength(2);
          expect(result.errors[0]).toMatchObject({
            message: 'Invalid recording JSON.',
          });
          expect(result.errors[1]).toMatchObject({
            code: 'STORAGE_FAILURE',
            cause: closeFailure,
          });
        }
        expect(close).toHaveBeenCalledOnce();
        expect((await target.list(page)).items).toEqual([]);
        expect(
          (await readdir(root)).filter((name) =>
            name.startsWith('.tts-import-'),
          ),
        ).toEqual([]);
      } finally {
        mock.mockRestore();
        syncBuiltinESMExports();
      }
    });
  },
);

function wrap(
  source: HistoryExports,
  change: (session: RecordingExport) => RecordingExport,
): HistoryExports {
  return {
    open: async (id, cancellation) =>
      change(await source.open(id, cancellation)),
    close: () => source.close(),
  };
}

it('publishes only after closing the export session and imports the completed file offline', async () => {
  await fixture(async (source, target, root) => {
    await seed(source);
    const file = join(root, 'recording.tts');
    const exporter = createLocalExporter({ path: join(root, 'source.sqlite') });
    const closed = vi.fn();
    try {
      await exportRecordingFile(
        wrap(exporter, (session) => ({
          ...session,
          close: async () => {
            await expect(readFile(file)).rejects.toMatchObject({
              code: 'ENOENT',
            });
            await session.close();
            closed();
          },
        })),
        metadata.id,
        file,
        signal(),
      );
      expect(closed).toHaveBeenCalledOnce();
      expect(await readFile(file)).toEqual(await bytesFrom(root));
    } finally {
      await exporter.close();
    }
    await source.close();
    const info = await importRecordingFile(file, target, signal());
    expect(info).toMatchObject({ headPosition: '10', transactionCount: 1 });
    expect((await target.transactions(metadata.id, page)).items).toEqual([
      transaction('10', '0', '2'),
    ]);
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.tts-')),
    ).toEqual([]);
  });
});

it.each(['file', 'symlink'] as const)(
  'preserves a competing destination %s created immediately before publication',
  async (kind) => {
    await fixture(async (source, _target, root) => {
      await seed(source);
      const file = join(root, 'recording.tts');
      const exporter = createLocalExporter({
        path: join(root, 'source.sqlite'),
      });
      try {
        await expect(
          exportRecordingFile(
            wrap(exporter, (session) => ({
              ...session,
              close: async () => {
                await session.close();
                if (kind === 'file') await writeFile(file, 'sentinel');
                else await symlink('missing-target', file);
              },
            })),
            metadata.id,
            file,
            signal(),
          ),
        ).rejects.toMatchObject({
          code: 'STORAGE_FAILURE',
          cause: { code: 'EEXIST' },
        });
        if (kind === 'file')
          expect(await readFile(file, 'utf8')).toBe('sentinel');
        else expect(await readlink(file)).toBe('missing-target');
        expect(
          (await readdir(root)).filter((name) =>
            name.startsWith('.tts-export-'),
          ),
        ).toEqual([]);
      } finally {
        await exporter.close();
      }
    });
  },
);

it.each(['cancel', 'close-failure'] as const)(
  'removes partial output on %s before publication',
  async (failure) => {
    await fixture(async (source, _target, root) => {
      await seed(source);
      const file = join(root, 'recording.tts');
      const exporter = createLocalExporter({
        path: join(root, 'source.sqlite'),
      });
      const controller = new AbortController();
      const closed = vi.fn();
      try {
        await expect(
          exportRecordingFile(
            wrap(exporter, (session) => ({
              ...session,
              baseline: async (request) => {
                const result = await session.baseline(request);
                if (failure === 'cancel') controller.abort();
                return result;
              },
              close: async () => {
                await session.close();
                closed();
                if (failure === 'close-failure')
                  throw new Error('close failed');
              },
            })),
            metadata.id,
            file,
            controller.signal,
          ),
        ).rejects.toMatchObject({
          code: failure === 'cancel' ? 'CANCELLED' : 'STORAGE_FAILURE',
        });
        expect(closed).toHaveBeenCalledOnce();
        await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(
          (await readdir(root)).filter((name) =>
            name.startsWith('.tts-export-'),
          ),
        ).toEqual([]);
      } finally {
        await exporter.close();
      }
    });
  },
);

it('rejects pre-aborted, oversized and non-regular inputs before acquiring staging', async () => {
  await fixture(async (_source, _target, root) => {
    const beginImport = vi.fn();
    const destination = { beginImport };
    const file = join(root, 'oversized.tts');
    await writeFile(file, Buffer.alloc(128));
    const controller = new AbortController();
    controller.abort();
    await expect(
      importRecordingFile(
        join(root, 'missing'),
        destination,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(
      importRecordingFile(file, destination, signal(), {
        ...DEFAULT_EXCHANGE_LIMITS,
        maxTotalBytes: 127,
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(
      importRecordingFile(root, destination, signal()),
    ).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    expect(beginImport).not.toHaveBeenCalled();
  });
});

it.skipIf(process.platform !== 'linux')(
  'rejects a FIFO without waiting for a writer',
  async () => {
    await fixture(async (_source, target, root) => {
      const file = join(root, 'input.fifo');
      await promisify(execFile)('mkfifo', [file]);
      await expect(
        importRecordingFile(file, target, signal()),
      ).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    });
  },
);
