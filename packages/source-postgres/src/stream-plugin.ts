import type pg from 'pg';
import { HistoryError } from '@time-travel-sql/sdk';
import { ExactPgoutputPlugin } from './pgoutput.js';
import { identifySystem, databaseOid } from './identity.js';

export class VerifiedStreamPlugin extends ExactPgoutputPlugin {
  constructor(
    publication: string,
    private readonly expected: {
      systemId: string;
      timeline: string;
      database: string;
      databaseOid: string;
    },
  ) {
    super(publication);
  }
  override async start(
    client: pg.Client,
    slot: string,
    lsn: string,
  ): Promise<unknown> {
    const actual = await identifySystem(client, this.expected.database);
    if (
      actual.systemId !== this.expected.systemId ||
      actual.timeline !== this.expected.timeline ||
      (await databaseOid(client)) !== this.expected.databaseOid
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Streaming connection reached a different cluster, timeline or database.',
      );
    return super.start(client, slot, lsn);
  }
}
