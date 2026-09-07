import {
  decodePosition,
  decodeStableId,
  decodeResumableRecording,
  HistoryError,
} from '@time-travel-sql/sdk';
import { randomUUID } from 'node:crypto';
import type { Reader } from './reader.js';

function generation(input: unknown): string {
  const value = decodePosition(input);
  if (BigInt(value) > 9223372036854775807n)
    throw new HistoryError(
      'INVALID_HISTORY',
      'Invalid recording ownership generation.',
    );
  return value;
}

function incarnation(input: unknown): string {
  const value = decodeStableId(input);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    )
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Invalid recording ownership incarnation.',
    );
  return value;
}

function claimToken(input: string): {
  incarnation: string;
  generation: string;
} {
  const parts = decodeStableId(input).split(':');
  if (parts.length !== 2)
    throw new HistoryError(
      'INVALID_HISTORY',
      'Invalid recording writer token.',
    );
  return {
    incarnation: incarnation(parts[0]),
    generation: generation(parts[1]),
  };
}

/** Every check and its associated mutation share the worker's SQLite transaction. */
export class RecordingOwners {
  constructor(readonly reader: Reader) {}

  private owner(
    id: string,
  ):
    | { incarnation: string; generation: string; owner: string; active: number }
    | undefined {
    const row = this.reader.db
      .prepare(
        `SELECT incarnation, CAST(generation AS TEXT) AS generation,
      CAST(owner_generation AS TEXT) AS owner, active FROM recording_owners WHERE recording_id=?`,
      )
      .get(id);
    if (!row) return undefined;
    const current = generation(row.generation);
    const owner = generation(row.owner);
    if (
      current === '0' ||
      BigInt(owner) > BigInt(current) ||
      (row.active !== 0 && row.active !== 1) ||
      (owner === '0' && row.active === 1)
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Invalid recording ownership state.',
      );
    return {
      incarnation: incarnation(row.incarnation),
      generation: current,
      owner,
      active: row.active,
    };
  }

  prepare(id: string): string {
    decodeResumableRecording(this.reader.info(id));
    if (this.owner(id)?.generation === '9223372036854775807')
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Recording ownership generation is exhausted.',
      );
    this.reader.db
      .prepare(
        `INSERT INTO recording_owners(recording_id,incarnation,generation,owner_generation,active) VALUES(?,?,1,0,0)
      ON CONFLICT(recording_id) DO UPDATE SET generation=generation+1`,
      )
      .run(id, randomUUID());
    const owner = this.owner(id);
    if (!owner)
      throw new HistoryError(
        'STORAGE_FAILURE',
        'Recording ownership reservation failed.',
      );
    return `${owner.incarnation}:${owner.generation}`;
  }

  activate(id: string, input: string): void {
    const token = claimToken(input);
    const owner = this.owner(id);
    if (
      !owner ||
      token.incarnation !== owner.incarnation ||
      BigInt(token.generation) <= BigInt(owner.owner) ||
      BigInt(token.generation) > BigInt(owner.generation)
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Recording writer claim was superseded or never reserved.',
      );
    this.reader.db
      .prepare(
        'UPDATE recording_owners SET owner_generation=?,active=1 WHERE recording_id=?',
      )
      .run(token.generation, id);
  }

  assertWrite(id: string, input?: string): void {
    const owner = this.owner(id);
    if (input === undefined && owner === undefined) return;
    const token = input === undefined ? undefined : claimToken(input);
    if (
      !owner ||
      owner.active !== 1 ||
      owner.owner !== token?.generation ||
      owner.incarnation !== token?.incarnation
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Recording writer ownership is missing, released or superseded.',
      );
  }

  release(id: string, input: string): void {
    const token = claimToken(input);
    this.reader.db
      .prepare(
        'UPDATE recording_owners SET active=0 WHERE recording_id=? AND incarnation=? AND owner_generation=?',
      )
      .run(id, token.incarnation, token.generation);
  }
}
