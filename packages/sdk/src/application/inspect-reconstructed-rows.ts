import { decodeReconstructionInfo } from '../domain/reconstruction.js';
import { decodeInvestigationOptions } from '../domain/investigation.js';
import type { KeyedRow } from '../domain/investigation.js';
import type { ReconstructionView } from '../ports/reconstruction.js';
import {
  InvestigationWork,
  InvestigationPage,
  keyedRows,
} from './investigation-work.js';
import type { InvestigationControl } from './investigation-work.js';

/** Borrows a selected view; validates its full stream before returning a page. */
export async function inspectReconstructedRows(
  view: ReconstructionView,
  input: unknown,
  control: InvestigationControl,
) {
  const info = decodeReconstructionInfo(view.info);
  const options = decodeInvestigationOptions(input);
  const work = new InvestigationWork(control, [info], options);
  const page = new InvestigationPage<KeyedRow>(options);
  let unavailableValues = false;
  for await (const row of keyedRows(view, info, work)) {
    if (options.tableId && row.tableId !== options.tableId) continue;
    unavailableValues ||= row.row.some((value) => value.kind === 'unavailable');
    page.add(row);
  }
  return Object.freeze({ info, ...page.result(), unavailableValues });
}
