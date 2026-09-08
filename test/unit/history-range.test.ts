import { join } from 'node:path';
import { expect, it } from 'vitest';
import { decodePosition, resolveHistoryRange } from '@time-travel-sql/sdk';
import { createLocalExporter } from '@time-travel-sql/storage-local';
import { fixture, seed, signal } from '../../test-support/exchange-fixture.js';
import { metadata, transaction } from '../../test-support/storage-fixture.js';

it('resolves exact inclusive endpoints in pinned history despite append and deletion', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    await source.append(metadata.id, transaction('20', '10', '3'));
    const exporter = createLocalExporter({ path: join(root, 'source.sqlite') });
    try {
      const history = await exporter.open(metadata.id);
      const after = { kind: 'after', position: decodePosition('10') } as const;
      await source.append(metadata.id, transaction('30', '20', '4'));
      await source.remove(metadata.id);
      expect(await history.transaction(decodePosition('10'))).toEqual(
        transaction('10', '0', '2'),
      );
      expect(
        await resolveHistoryRange(
          history,
          { kind: 'baseline' },
          after,
          signal(),
        ),
      ).toEqual({ from: '0', to: '10' });
      expect(
        await resolveHistoryRange(
          history,
          { kind: 'before', position: decodePosition('20') },
          { kind: 'after', position: decodePosition('20') },
          signal(),
        ),
      ).toEqual({ from: '10', to: '20' });
      expect(
        await resolveHistoryRange(
          history,
          { ...after, kind: 'before' },
          after,
          signal(),
        ),
      ).toEqual({ from: '0', to: '10' });
      expect(
        await resolveHistoryRange(history, after, after, signal()),
      ).toEqual({ from: '10', to: '10' });
      await expect(
        resolveHistoryRange(history, after, { kind: 'baseline' }, signal()),
      ).rejects.toMatchObject({ code: 'INVALID_VALUE' });
      for (const position of ['9', '30'])
        await expect(
          resolveHistoryRange(
            history,
            { kind: 'baseline' },
            { kind: 'after', position: decodePosition(position) },
            signal(),
          ),
        ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
      const controller = new AbortController();
      controller.abort();
      await expect(
        resolveHistoryRange(history, after, after, controller.signal),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      await history.close();
      await expect(
        history.transaction(decodePosition('10')),
      ).rejects.toBeDefined();
    } finally {
      await exporter.close();
    }
  });
});
