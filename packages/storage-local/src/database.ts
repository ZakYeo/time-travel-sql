import { DatabaseSync } from 'node:sqlite';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { HistoryError } from '@time-travel-sql/sdk';
import { inspectSchema, migrate } from './migrations.js';

export interface LocalStoreOptions {
  readonly path: string;
  /** SQLite main database limit; WAL and temporary files require additional space. */
  readonly maxBytes?: number;
}

export function openDatabase(options: LocalStoreOptions): DatabaseSync {
  if (typeof options.path !== 'string' || !isAbsolute(options.path))
    throw new HistoryError(
      'INVALID_VALUE',
      'Storage requires an absolute file path.',
    );
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 65536)
    throw new HistoryError(
      'INVALID_VALUE',
      'Storage limit must be at least 65536 bytes.',
    );
  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  closeSync(openSync(options.path, 'a', 0o600));
  const db = new DatabaseSync(options.path, { timeout: 5000 });
  try {
    atomic(db, () => inspectSchema(db), 'read');
    db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL',
    );
    const pageSize = db.prepare('PRAGMA page_size').get()?.page_size;
    if (typeof pageSize !== 'number')
      throw new HistoryError(
        'STORAGE_FAILURE',
        'Cannot read database page size.',
      );
    const pageLimit = Math.floor(maxBytes / pageSize);
    const actual = db
      .prepare(`PRAGMA max_page_count=${pageLimit}`)
      .get()?.max_page_count;
    if (typeof actual !== 'number' || actual > pageLimit)
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Existing database exceeds the configured storage limit.',
      );
    atomic(db, () => migrate(db));
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function atomic<T>(
  db: DatabaseSync,
  operation: () => T,
  mode: 'read' | 'write' = 'write',
): T {
  db.exec(mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    // SQLite can already have rolled back a failed write (for example SQLITE_FULL).
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
