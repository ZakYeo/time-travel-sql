import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HistoryError } from '@time-travel-sql/sdk';

/** Parent ownership survives a terminated SQLite worker. */
export class ImportDirectories {
  readonly #roots = new Set<string>();
  #closed = false;
  constructor(readonly databasePath: string) {}

  create(): string {
    if (this.#closed)
      throw new HistoryError('STORAGE_FAILURE', 'Local storage is closed.');
    const root = mkdtempSync(join(dirname(this.databasePath), '.tts-import-'));
    this.#roots.add(root);
    return root;
  }

  async release(root: string): Promise<void> {
    if (!this.#roots.has(root)) return;
    await rm(root, { recursive: true, force: true });
    this.#roots.delete(root);
  }

  /** Call only after worker termination, so no open writer can recreate files. */
  async close(): Promise<void> {
    this.#closed = true;
    const results = await Promise.allSettled(
      [...this.#roots].map((root) => this.release(root)),
    );
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, 'Import directory cleanup failed.');
  }
}
