import { expect, it } from 'vitest';
import { emitPrismaContext } from '@time-travel-sql/integration-prisma';
import {
  POSTGRES_CONTEXT_PREFIX,
  postgresContextPayload,
} from '@time-travel-sql/sql-postgres';

it('binds the shared context payload once and preserves errors without transaction lifecycle work', async () => {
  const context = {
    version: 1,
    operation: 'checkout.create',
    requestId: 'request-1',
  };
  const calls: { parts: readonly string[]; values: readonly unknown[] }[] = [];
  const transaction = {
    $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ parts, values });
      return 1;
    },
  };
  await emitPrismaContext(transaction, context);
  expect(calls).toEqual([
    {
      parts: [
        'SELECT pg_catalog.pg_logical_emit_message(true, ',
        ', ',
        '::text)',
      ],
      values: [POSTGRES_CONTEXT_PREFIX, postgresContextPayload(context)],
    },
  ]);
  await expect(
    emitPrismaContext(transaction, { ...context, password: 'not-allowed' }),
  ).rejects.toMatchObject({ code: 'INVALID_VALUE' });
  expect(calls).toHaveLength(1);
  const failure = new Error('Caller query failed');
  await expect(
    emitPrismaContext(
      {
        $executeRaw: async () => {
          throw failure;
        },
      },
      context,
    ),
  ).rejects.toBe(failure);
});
