import pg from 'pg';
import { expect, it } from 'vitest';
import { HistoryState } from '@time-travel-sql/sdk';
import type { SnapshotRow } from '@time-travel-sql/sdk';
import {
  openPostgresCaptureLease,
  openPostgresBaseline,
  openPostgresStream,
  cleanupPostgresPublication,
  applyPostgresSetup,
} from '@time-travel-sql/source-postgres';
import { withPostgres } from '../../test-support/postgres.js';
import { postgresResponseProxy } from '../../test-support/postgres-response-proxy.js';
import {
  setupFixture,
  setupOptions,
} from '../../test-support/setup-fixture.js';

it('excludes competing leases, setup and cleanup then releases both locks on close', async () => {
  await withPostgres(async (connection) => {
    const client = new pg.Client(connection);
    await client.connect();
    try {
      const receipt = await setupFixture(client, connection);
      const lease = await openPostgresCaptureLease(
        connection,
        receipt,
        new AbortController().signal,
      );
      try {
        await expect(
          openPostgresCaptureLease(
            connection,
            receipt,
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
        await expect(
          cleanupPostgresPublication(
            connection,
            receipt,
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
        await expect(
          applyPostgresSetup(
            connection,
            { ...setupOptions, publication: 'tts_another' },
            'schema',
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
        expect(
          (
            await client.query(
              "SELECT count(*)::int FROM pg_locks WHERE locktype='advisory'",
            )
          ).rows,
        ).toEqual([{ count: 2 }]);
      } finally {
        await lease.close();
      }
      expect(lease.signal.aborted).toBe(true);
      expect(() => lease.assertActive()).toThrow();
      const next = await openPostgresCaptureLease(
        connection,
        receipt,
        new AbortController().signal,
      );
      await next.close();
      expect(
        await cleanupPostgresPublication(
          connection,
          receipt,
          new AbortController().signal,
        ),
      ).toBe('removed');
    } finally {
      await client.end();
    }
  });
});

it('releases a failed acquisition and rejects changed ownership markers', async () => {
  await withPostgres(async (connection) => {
    const client = new pg.Client(connection);
    await client.connect();
    try {
      const receipt = await setupFixture(client, connection);
      await expect(
        openPostgresCaptureLease(
          connection,
          { ...receipt, ownershipToken: 'a'.repeat(32) },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
      const lease = await openPostgresCaptureLease(
        connection,
        receipt,
        new AbortController().signal,
      );
      await lease.close();
      expect(
        (
          await client.query(
            "SELECT count(*)::int FROM pg_locks WHERE locktype='advisory'",
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    } finally {
      await client.end();
    }
  });
});

it('fails a stalled health probe within its deadline and releases the lease locks', async () => {
  await withPostgres(async (connection) => {
    const client = new pg.Client(connection);
    await client.connect();
    const proxy = await postgresResponseProxy(connection, 'probe-stall');
    try {
      const receipt = await setupFixture(client, connection);
      const lease = await openPostgresCaptureLease(
        proxy.connection,
        receipt,
        new AbortController().signal,
      );
      try {
        await expect
          .poll(() => lease.signal.aborted, { timeout: 8000 })
          .toBe(true);
        expect(proxy.triggered()).toBe(true);
        expect(lease.signal.reason).toMatchObject({
          code: 'SOURCE_UNAVAILABLE',
        });
      } finally {
        await lease.close();
      }
      const next = await openPostgresCaptureLease(
        connection,
        receipt,
        new AbortController().signal,
      );
      await next.close();
    } finally {
      await proxy.close();
      await client.end();
    }
  });
});

it('cancels leased streaming when the lease backend is terminated', async () => {
  await withPostgres(async (connection) => {
    const client = new pg.Client(connection);
    await client.connect();
    try {
      const receipt = await setupFixture(client, connection);
      const lease = await openPostgresCaptureLease(
        connection,
        receipt,
        new AbortController().signal,
      );
      try {
        const baseline = await openPostgresBaseline({
          connection,
          slot: receipt.slot,
          tables: setupOptions.tables,
          sourceId: 'source',
          epochId: 'epoch',
          schemaId: 'schema',
          signal: new AbortController().signal,
          lease,
        });
        const rows: SnapshotRow[] = [];
        try {
          while (true) {
            const batch = await baseline.next();
            if (batch === null) break;
            rows.push(...batch);
          }
        } finally {
          await baseline.close();
        }
        const state = HistoryState.fromSnapshot(
          baseline.recording,
          baseline.position,
          rows,
        );
        const stream = await openPostgresStream({
          connection,
          slot: receipt.slot,
          publication: receipt.publication,
          systemId: receipt.systemId,
          timeline: receipt.timeline,
          databaseOid: receipt.databaseOid,
          state,
          signal: new AbortController().signal,
          lease,
        });
        try {
          const pending = stream.next().then(
            (value) => ({ ok: true, value }),
            (error: unknown) => ({ ok: false, error }),
          );
          const backends = (
            await client.query(
              `SELECT DISTINCT a.pid FROM pg_stat_activity a
            JOIN pg_locks l ON l.pid=a.pid WHERE a.application_name='time-travel-sql'
            AND l.locktype='advisory' AND l.database=$1::oid`,
              [receipt.databaseOid],
            )
          ).rows;
          expect(backends).toHaveLength(1);
          const backendPid: unknown = backends[0]?.pid;
          if (
            typeof backendPid !== 'number' ||
            !Number.isSafeInteger(backendPid) ||
            backendPid < 1
          )
            throw new Error('Missing verified lease backend');
          await client.query('SELECT pg_terminate_backend($1)', [backendPid]);
          await expect.poll(() => lease.signal.aborted).toBe(true);
          expect(lease.signal.reason).toMatchObject({
            code: 'SOURCE_UNAVAILABLE',
          });
          expect(await pending).toMatchObject({
            ok: false,
            error: { code: 'SOURCE_UNAVAILABLE' },
          });
        } finally {
          await stream.close();
        }
      } finally {
        await lease.close();
      }
    } finally {
      await client.end();
    }
  });
});
