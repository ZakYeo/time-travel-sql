import { expect, it } from 'vitest';
import { planPostgresSetup } from '@time-travel-sql/source-postgres';

const input = {
  publication: 'tts_owned',
  slot: 'tts_capture',
  ownershipToken: '0123456789abcdef0123456789abcdef',
  tables: [
    { namespace: 'strange"schema', name: "table'; DROP TABLE sentinel; --" },
  ],
};

it('quotes every selected identifier and generates an isolated transaction and separate bootstrap command', () => {
  const plan = planPostgresSetup(input);
  expect(plan.sql).toContain(
    'ALTER TABLE ONLY "strange""schema"."table\'; DROP TABLE sentinel; --" REPLICA IDENTITY FULL;',
  );
  expect(plan.sql).toContain('FOR TABLE ONLY "strange""schema".');
  expect(plan.sql.startsWith('BEGIN;\n')).toBe(true);
  expect(plan.sql.endsWith('\nCOMMIT;')).toBe(true);
  expect(plan.sql).not.toContain('CREATE_REPLICATION_SLOT');
  expect(plan.bootstrapCommand).toBe(
    "CREATE_REPLICATION_SLOT tts_capture LOGICAL pgoutput (SNAPSHOT 'export')",
  );
  expect(plan.ownershipComment).toContain(':tts_capture');
  expect(Object.isFrozen(plan.tables[0])).toBe(true);
});

it('rejects accessor configuration without evaluating it', () => {
  let read = false;
  const config = { ...input };
  Object.defineProperty(config, 'ownershipToken', {
    get() {
      read = true;
      return input.ownershipToken;
    },
  });
  expect(() => planPostgresSetup(config)).toThrow();
  expect(read).toBe(false);
});

it.each([
  { ...input, ownershipToken: "'; SELECT 1; --" },
  { ...input, publication: { toString: (): string => 'tts_owned' } },
  { ...input, tables: [] },
  { ...input, tables: [input.tables[0], input.tables[0]] },
  { ...input, tables: Array(1) },
  { ...input, tables: [{ namespace: 'public', name: '\ud800' }] },
  { ...input, tables: [{ namespace: 'public', name: 'é'.repeat(32) }] },
  { ...input, unexpected: true },
])('rejects invalid setup configuration %#', (value) => {
  expect(() => planPostgresSetup(value)).toThrow();
});
