import { HistoryError } from '../domain/errors.js';
import { decodeReconstructionInfo } from '../domain/reconstruction.js';
import { decodeInvestigationOptions } from '../domain/investigation.js';
import type {
  KeyedRow,
  RowDifference,
  FieldDifference,
} from '../domain/investigation.js';
import type { ReconstructionPair } from '../ports/reconstruction.js';
import { findTable } from '../domain/schema.js';
import type { Schema } from '../domain/schema.js';
import {
  InvestigationWork,
  InvestigationPage,
  keyedRows,
} from './investigation-work.js';
import type { InvestigationControl } from './investigation-work.js';

function difference(
  schema: Schema,
  before: KeyedRow | undefined,
  after: KeyedRow | undefined,
): RowDifference | undefined {
  const row = before ?? after;
  if (!row) return undefined;
  if (
    before &&
    after &&
    JSON.stringify(before.row) === JSON.stringify(after.row)
  )
    return undefined;
  const fields: FieldDifference[] = [];
  if (before && after) {
    const table = findTable(schema, row.tableId);
    for (const [index, column] of table.columns.entries()) {
      const left = before.row[index];
      const right = after.row[index];
      if (left && right && JSON.stringify(left) !== JSON.stringify(right))
        fields.push(
          Object.freeze({ column: column.name, before: left, after: right }),
        );
    }
  }
  return Object.freeze({
    tableId: row.tableId,
    key: row.key,
    kind: before ? (after ? 'update' : 'delete') : 'insert',
    before: before?.row ?? null,
    after: after?.row ?? null,
    fields: Object.freeze(fields),
  });
}

/** Deterministic net differences; key changes are delete+insert, not inferred lineage.
 * Borrows one atomic pair. Full input validation precedes any returned result.
 */
export async function compareReconstructedStates(
  pair: ReconstructionPair,
  input: unknown,
  control: InvestigationControl,
) {
  const from = decodeReconstructionInfo(pair.from.info);
  const to = decodeReconstructionInfo(pair.to.info);
  if (JSON.stringify(from.recording) !== JSON.stringify(to.recording))
    throw new HistoryError(
      'INVALID_HISTORY',
      'Comparison views do not share one recording snapshot.',
    );
  const options = decodeInvestigationOptions(input);
  const work = new InvestigationWork(control, [from, to], options);
  const page = new InvestigationPage<RowDifference>(options);
  const schema = from.recording.recording.schema;
  const order = new Map(schema.tables.map((table, index) => [table.id, index]));
  const left = keyedRows(pair.from, from, work);
  const right = keyedRows(pair.to, to, work);
  let unavailableValues = false;
  const counts = { inserted: 0, deleted: 0, updated: 0, unchanged: 0 };
  try {
    let a = await left.next();
    let b = await right.next();
    while (!a.done || !b.done) {
      const ordering = a.done
        ? 1
        : b.done
          ? -1
          : (order.get(a.value.tableId) ?? 0) -
              (order.get(b.value.tableId) ?? 0) ||
            (a.value.key < b.value.key
              ? -1
              : a.value.key > b.value.key
                ? 1
                : 0);
      const before = !a.done && ordering <= 0 ? a.value : undefined;
      const after = !b.done && ordering >= 0 ? b.value : undefined;
      const tableId = before?.tableId ?? after?.tableId;
      if (!options.tableId || tableId === options.tableId) {
        unavailableValues ||= [before, after].some((row) =>
          row?.row.some((value) => value.kind === 'unavailable'),
        );
        const change = difference(schema, before, after);
        if (!change) counts.unchanged++;
        else {
          counts[
            change.kind === 'insert'
              ? 'inserted'
              : change.kind === 'delete'
                ? 'deleted'
                : 'updated'
          ]++;
          page.add(change);
        }
      }
      if (ordering <= 0) a = await left.next();
      if (ordering >= 0) b = await right.next();
    }
    work.check();
    return Object.freeze({
      from,
      to,
      ...page.result(),
      counts: Object.freeze(counts),
      unavailableValues,
    });
  } finally {
    await left.return(undefined);
    await right.return(undefined);
  }
}
