import { inspect } from 'node:util';
import { expect, it } from 'vitest';
import {
  decodeTransactionContext,
  decodeTransaction,
  TRANSACTION_CONTEXT_MAX_BYTES,
  DERIVED_CAPABILITIES,
  projectTransaction,
} from '@time-travel-sql/sdk';
import {
  PostgresTransactions,
  POSTGRES_CONTEXT_PREFIX,
} from '@time-travel-sql/source-postgres';
import {
  baseline,
  frame,
  begin,
  commit,
  insert,
  recording,
} from '../../test-support/postgres-transaction-fixture.js';

const context = decodeTransactionContext({
  version: 1,
  operation: 'checkout.create',
  requestId: 'request-1',
  traceId: '1234567890abcdef1234567890abcdef',
});
const message = (
  content: Uint8Array = Buffer.from(JSON.stringify(context)),
  prefix = POSTGRES_CONTEXT_PREFIX,
  flags = 1,
) =>
  frame({
    tag: 'message',
    prefix,
    flags,
    transactional: flags === 1,
    messageLsn: '0/F',
    content,
  });

it('canonicalizes bounded allowlisted labels without capturing arbitrary data or invoking accessors', () => {
  expect(Object.isFrozen(context)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(
    TRANSACTION_CONTEXT_MAX_BYTES,
  );
  for (const input of [
    { ...context, body: 'private' },
    { ...context, version: 2 },
    { ...context, operation: 'x'.repeat(129) },
    { ...context, operation: '<script>' },
    { ...context, requestId: 'request\u001b[31m' },
    { ...context, traceId: '0'.repeat(32) },
  ])
    expect(() => decodeTransactionContext(input)).toThrow();
  let invoked = false;
  expect(() =>
    decodeTransactionContext({
      version: 1,
      get operation() {
        invoked = true;
        return 'private';
      },
    }),
  ).toThrow();
  expect(invoked).toBe(false);
});

it('associates context with exactly one commit and includes it in duplicate validation', () => {
  const assembler = new PostgresTransactions(baseline());
  expect(
    assembler.push(message(Buffer.from('ignored'), 'unrelated', 0)),
  ).toBeUndefined();
  assembler.push(begin());
  assembler.push(message());
  assembler.push(insert());
  const tx = assembler.push(commit());
  if (!tx) throw new Error('Missing commit');
  expect(tx.context).toEqual(context);
  const derived = {
    ...recording,
    derivation: {
      kind: 'column-policy' as const,
      parentConfigurationFingerprint: 'a'.repeat(64),
      capabilities: DERIVED_CAPABILITIES,
      liveResume: false as const,
    },
  };
  expect(() => decodeTransaction(derived, tx)).toThrow(
    'omit transaction context',
  );
  expect(projectTransaction(recording, derived, tx).context).toBeUndefined();
  expect(tx.context).toEqual(context);
  const state = baseline().apply(tx);
  expect(state.apply(tx)).toBe(state);
  expect(() =>
    state.apply(
      decodeTransaction(recording, {
        ...tx,
        context: { ...context, operation: 'different' },
      }),
    ),
  ).toThrow();
  assembler.confirmDurable(tx.position);
  assembler.push(begin('0/20'));
  assembler.push(message(Buffer.from('unrelated-payload'), 'unrelated'));
  expect(assembler.push(commit('0/20', '0/21'))?.context).toBeUndefined();
});

it('rejects duplicate, malformed, nontransactional and out-of-transaction context without leaking payloads', () => {
  for (const inputs of [
    [message()],
    [begin(), message(), message()],
    [begin(), message(undefined, POSTGRES_CONTEXT_PREFIX, 0)],
    [begin(), message(Buffer.from('SENSITIVE_MESSAGE_VALUE malformed JSON'))],
    [begin(), message(Buffer.from([0xff]))],
    [begin(), message(Buffer.alloc(TRANSACTION_CONTEXT_MAX_BYTES + 1))],
  ]) {
    const assembler = new PostgresTransactions(baseline());
    let failure: unknown;
    try {
      for (const input of inputs) assembler.push(input);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(inspect(failure, { depth: 10 })).not.toContain(
      'SENSITIVE_MESSAGE_VALUE',
    );
    expect(assembler.durableState.position).toBe('0');
    expect(() => assembler.push(begin())).toThrow('closed');
  }
  const assembler = new PostgresTransactions(baseline(), { maxMessages: 2 });
  assembler.push(begin());
  assembler.push(message());
  expect(() =>
    assembler.push(message(Buffer.from('ignored'), 'unrelated')),
  ).toThrow('wire work budget');
});
