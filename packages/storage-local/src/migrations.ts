import type { DatabaseSync } from 'node:sqlite';
import { HistoryError } from '@time-travel-sql/sdk';

const tables = [
  [
    'recordings',
    `CREATE TABLE recordings (
    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL
  ) STRICT`,
  ],
  [
    'baseline',
    `CREATE TABLE baseline (
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    key TEXT NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL,
    PRIMARY KEY(recording_id, key)
  ) STRICT`,
  ],
  [
    'transactions',
    `CREATE TABLE transactions (
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    position TEXT NOT NULL CHECK(length(position)=40),
    data TEXT NOT NULL, digest TEXT NOT NULL,
    PRIMARY KEY(recording_id, position)
  ) STRICT`,
  ],
] as const;

const normalized = (sql: string) => sql.replace(/\s+/g, ' ').trim();

export function inspectSchema(db: DatabaseSync): 0 | 1 {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (version !== 0 && version !== 1)
    throw new HistoryError(
      'INVALID_HISTORY',
      'Unsupported recording database version.',
    );
  const objects = db
    .prepare(
      "SELECT name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
    )
    .all();
  const expected = version === 0 ? [] : tables;
  if (
    objects.length !== expected.length ||
    expected.some(
      ([name, sql]) =>
        !objects.some(
          (object) =>
            object.name === name &&
            typeof object.sql === 'string' &&
            normalized(object.sql) === normalized(sql),
        ),
    )
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Recording database schema is missing, damaged, or unsupported.',
    );
  return version;
}

/** Called under BEGIN IMMEDIATE, so initialization cannot race another opener. */
export function migrate(db: DatabaseSync): void {
  if (inspectSchema(db) === 0) {
    for (const [, sql] of tables) db.exec(sql);
    db.exec('PRAGMA user_version=1');
  }
}
