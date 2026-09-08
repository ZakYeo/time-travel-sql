import { HistoryError, decodeTransaction } from '@time-travel-sql/sdk';
import type {
  HistoryState,
  CommittedTransaction,
  Position,
  RowEvent,
  TransactionContext,
} from '@time-travel-sql/sdk';
import type { Pgoutput } from 'pg-logical-replication';
import { decodeLsn } from './identifiers.js';
import { postgresChange, postgresRelation } from './changes.js';
import type { PgoutputFrame } from './pgoutput.js';
import { TransactionRows } from './transaction-rows.js';
import { TransactionBudget } from './transaction-limits.js';
import type { PostgresTransactionLimits } from './transaction-limits.js';
import {
  POSTGRES_CONTEXT_PREFIX,
  postgresTransactionContext,
} from './transaction-context.js';

interface Collecting {
  readonly kind: 'collecting';
  readonly commitLsn: Position;
  readonly committedAtMicros: string;
  readonly xid: number;
  readonly rows: TransactionRows;
  readonly budget: TransactionBudget;
  readonly events: RowEvent[];
  context?: TransactionContext;
}
type Phase =
  | { readonly kind: 'idle' }
  | Collecting
  | {
      readonly kind: 'pending';
      readonly transaction: CommittedTransaction;
      readonly next: HistoryState;
    }
  | { readonly kind: 'closed' };

function commitTime(input: Pgoutput.MessageBegin['commitTime']): string {
  if (typeof input !== 'bigint')
    throw new HistoryError(
      'INVALID_EVENT',
      'Expected exact Unix commit microseconds.',
    );
  return input.toString();
}

/** One protocol-v1 stream. After any failure, reopen from verified durable state. */
export class PostgresTransactions {
  #head: HistoryState;
  #phase: Phase = { kind: 'idle' };
  readonly #limits: PostgresTransactionLimits;

  constructor(state: HistoryState, limits: PostgresTransactionLimits = {}) {
    this.#head = state;
    this.#limits = Object.freeze({ ...limits });
    new TransactionBudget(this.#limits);
  }

  get durableState(): HistoryState {
    return this.#head;
  }

  /** Returns only complete commits. Call confirmDurable after durable append. */
  push(frame: PgoutputFrame): CommittedTransaction | undefined {
    try {
      if (this.#phase.kind === 'closed' || this.#phase.kind === 'pending')
        throw new HistoryError(
          'INVALID_HISTORY',
          'Stream is closed or waiting for durable commit confirmation.',
        );
      if (frame.result.kind === 'error') throw frame.result.error;
      const { message, bytes } = frame.result;
      if (message.tag === 'begin') {
        if (this.#phase.kind !== 'idle')
          throw new HistoryError('INVALID_EVENT', 'Nested transaction begin.');
        const commitLsn = decodeLsn(message.commitLsn);
        if (
          BigInt(commitLsn) < BigInt(this.#head.position) ||
          !Number.isInteger(message.xid) ||
          message.xid < 0 ||
          message.xid > 4294967295
        )
          throw new HistoryError(
            'INVALID_HISTORY',
            'Invalid transaction identity or commit order.',
          );
        this.#phase = {
          kind: 'collecting',
          commitLsn,
          committedAtMicros: commitTime(message.commitTime),
          xid: message.xid,
          rows: new TransactionRows(this.#head),
          budget: new TransactionBudget(this.#limits),
          events: [],
        };
        this.#phase.budget.frame(bytes);
        return undefined;
      }
      if (this.#phase.kind === 'collecting') this.#phase.budget.frame(bytes);
      if (message.tag === 'message') {
        if (message.prefix !== POSTGRES_CONTEXT_PREFIX) return undefined;
        if (
          this.#phase.kind !== 'collecting' ||
          this.#phase.context !== undefined
        )
          throw new HistoryError(
            'INVALID_EVENT',
            'Context requires one message inside an active transaction.',
          );
        this.#phase.context = postgresTransactionContext(message);
        return undefined;
      }
      if (message.tag === 'relation') {
        postgresRelation(this.#head.recording, message);
        return undefined;
      }
      if (this.#phase.kind !== 'collecting')
        throw new HistoryError('INVALID_EVENT', 'Expected transaction begin.');
      const active = this.#phase;
      if (message.tag === 'commit') return this.commit(active, message);
      if (
        message.tag !== 'insert' &&
        message.tag !== 'update' &&
        message.tag !== 'delete'
      )
        throw new HistoryError(
          'INVALID_EVENT',
          'Unsupported replication message in transaction.',
        );
      const event = postgresChange(
        this.#head.recording,
        message,
        (table, key) => active.rows.read(table, key),
      );
      active.budget.event(event);
      active.rows.record(event);
      active.events.push(event);
      return undefined;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private commit(
    active: Collecting,
    message: Pgoutput.MessageCommit,
  ): CommittedTransaction {
    const position = decodeLsn(message.commitEndLsn);
    if (
      message.flags !== 0 ||
      decodeLsn(message.commitLsn) !== active.commitLsn ||
      commitTime(message.commitTime) !== active.committedAtMicros ||
      BigInt(position) <= BigInt(active.commitLsn)
    )
      throw new HistoryError(
        'INVALID_EVENT',
        'Commit does not match its transaction begin.',
      );
    const recording = this.#head.recording;
    const transaction = decodeTransaction(recording, {
      sourceId: recording.sourceId,
      epochId: recording.epochId,
      schemaId: recording.schema.id,
      id: 'pg_' + active.xid + '_' + position,
      previousPosition: this.#head.position,
      position,
      committedAtMicros: active.committedAtMicros,
      ...(active.context === undefined ? {} : { context: active.context }),
      events: active.events,
    });
    const next = this.#head.apply(transaction);
    this.#phase = { kind: 'pending', transaction, next };
    return transaction;
  }

  /** No network acknowledgement is sent here. Position is exclusive commit-end. */
  confirmDurable(position: Position): void {
    if (
      this.#phase.kind !== 'pending' ||
      this.#phase.transaction.position !== position
    ) {
      this.close();
      throw new HistoryError(
        'INVALID_HISTORY',
        'Durable confirmation does not match the pending transaction.',
      );
    }
    this.#head = this.#phase.next;
    this.#phase = { kind: 'idle' };
  }

  /** Discards partial/unconfirmed work. The durable head never advances on close. */
  close(): void {
    this.#phase = { kind: 'closed' };
  }
}
