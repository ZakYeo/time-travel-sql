import { PgoutputPlugin } from 'pg-logical-replication';
import type { Pgoutput } from 'pg-logical-replication';
import type pg from 'pg';
import { HistoryError } from '@time-travel-sql/sdk';
import { decodeLsn, encodeLsn, validateSlotName } from './identifiers.js';

/** Keeps library decoder failures inside the asynchronous capture error boundary. */
export class PgoutputFrame {
  constructor(
    readonly result:
      | {
          readonly kind: 'message';
          readonly message: Pgoutput.Message;
          readonly bytes: number;
        }
      | { readonly kind: 'error'; readonly error: Error },
  ) {}
}

/** A public transport plugin contract; no global pg parser mutations or private imports. */
export class ExactPgoutputPlugin {
  readonly name = 'pgoutput';
  readonly options;
  private readonly decoder: PgoutputPlugin;

  constructor(
    publication: string,
    private readonly maxMessageBytes = 4 * 1024 * 1024,
  ) {
    validateSlotName(publication);
    if (
      !Number.isSafeInteger(maxMessageBytes) ||
      maxMessageBytes < 1 ||
      maxMessageBytes > 64 * 1024 * 1024
    )
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Invalid replication message limit.',
      );
    this.options = {
      protoVersion: 1 as const,
      publicationNames: [publication],
      messages: true,
    };
    this.decoder = new PgoutputPlugin(this.options);
  }

  start(client: pg.Client, slot: string, lsn: string): Promise<unknown> {
    return this.decoder.start(
      client,
      validateSlotName(slot),
      encodeLsn(decodeLsn(lsn)),
    );
  }

  parse(buffer: Buffer): PgoutputFrame {
    try {
      if (buffer.length > this.maxMessageBytes)
        throw new HistoryError(
          'LIMIT_EXCEEDED',
          'Replication message exceeds configured limit.',
        );
      const message = this.decoder.parse(buffer);
      if (message.tag === 'begin' || message.tag === 'commit') {
        // The library reads this signed wire field as unsigned, then adds the
        // epoch. Read the original bytes so pre-2000 times remain exact too.
        message.commitTime =
          buffer.readBigInt64BE(message.tag === 'begin' ? 9 : 18) +
          946684800000000n;
      }
      if (message.tag === 'begin') message.xid >>>= 0;
      if (message.tag === 'type') message.typeOid >>>= 0;
      if (message.tag === 'relation') {
        message.relationOid >>>= 0;
        // The library caches this public relation object. Replace its per-column
        // parsers before any following tuple; JSON/numeric/time stay exact text.
        for (const column of message.columns) {
          column.typeOid >>>= 0;
          column.parser = (raw: unknown): string => {
            if (typeof raw !== 'string')
              throw new HistoryError(
                'INVALID_VALUE',
                'Expected replication text value.',
              );
            return raw;
          };
        }
      }
      return new PgoutputFrame({
        kind: 'message',
        message,
        bytes: buffer.length,
      });
    } catch (error) {
      return new PgoutputFrame({
        kind: 'error',
        error:
          error instanceof HistoryError
            ? error
            : new HistoryError(
                'INVALID_EVENT',
                'Malformed PostgreSQL replication message.',
                { cause: error },
              ),
      });
    }
  }
}
