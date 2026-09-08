import type { QueryRequest, QueryResult } from '../domain/query.js';
import type {
  CancellationSignal,
  ReconstructionView,
} from './reconstruction.js';

/** Executes only against validated recorded values in a disposable engine.
 * The view is borrowed; callers retain ownership and keep it open until query
 * settles. Implementations receive no source connection or credentials.
 */
export interface HistoricalQueryEngine {
  /** The deadline covers materialization, execution and result delivery. Limits
   * fail explicitly, without returning a partial successful result. Engine
   * resources are released before settlement, including on cancellation.
   */
  query(
    view: ReconstructionView,
    request: QueryRequest,
    signal?: CancellationSignal,
  ): Promise<QueryResult>;
  /** Cancels pending queries and drains owned resources. Idempotent. */
  close(): Promise<void>;
}
