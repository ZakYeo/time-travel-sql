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
  [
    'checkpoints',
    `CREATE TABLE checkpoints (
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    position TEXT NOT NULL CHECK(length(position)=40), data TEXT NOT NULL, digest TEXT NOT NULL,
    PRIMARY KEY(recording_id, position)
  ) STRICT`,
  ],
  [
    'checkpoint_rows',
    `CREATE TABLE checkpoint_rows (
    recording_id TEXT NOT NULL, position TEXT NOT NULL, key TEXT NOT NULL,
    data TEXT NOT NULL, digest TEXT NOT NULL,
    PRIMARY KEY(recording_id, position, key),
    FOREIGN KEY(recording_id, position) REFERENCES checkpoints(recording_id, position) ON DELETE CASCADE
  ) STRICT`,
  ],
  [
    'capture_bindings',
    `CREATE TABLE capture_bindings (
    recording_id TEXT PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
    data TEXT NOT NULL, digest TEXT NOT NULL
  ) STRICT`,
  ],
] as const;

const normalized = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const tableCounts = [0, 3, 5, 6] as const;

export function inspectSchema(db: DatabaseSync): 0 | 1 | 2 | 3 {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (version !== 0 && version !== 1 && version !== 2 && version !== 3)
    throw new HistoryError(
      'INVALID_HISTORY',
      'Unsupported recording database version.',
    );
  const objects = db
    .prepare(
      "SELECT name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
    )
    .all();
  const expected = tables.slice(0, tableCounts[version]);
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
  const version = inspectSchema(db);
  if (version < 3) {
    for (const [, sql] of tables.slice(tableCounts[version])) db.exec(sql);
    db.exec('PRAGMA user_version=3');
  }
}
