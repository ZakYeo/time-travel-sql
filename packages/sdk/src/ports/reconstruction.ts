import type {
  ReconstructionInfo,
  ReconstructionRequest,
} from '../domain/reconstruction.js';
import type { Page, PageRequest } from '../domain/recordings.js';
import type { Row } from '../domain/schema.js';

/** Compatible with browser and Node AbortSignal without importing a runtime. */
export interface CancellationSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(
    type: 'abort',
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface ReconstructionView {
  readonly info: ReconstructionInfo;
  /**
   * Stable pages in strictly ascending rowKey string order (UTF-16 code units).
   * Cursors belong to this session and table; null starts iteration. A null
   * nextCursor means completion. Nonterminal pages contain rows and advance.
   */
  rows(tableId: string, page: PageRequest): Promise<Page<Row>>;
}

export interface ReconstructionSession extends ReconstructionView {
  /** Cancels outstanding reads and releases the selected state. Idempotent. */
  close(): Promise<void>;
}

/** Both views derive from one immutable recording snapshot. Views are borrowed;
 * the pair owns their lifetime and releases both together.
 */
export interface ReconstructionPair {
  readonly from: ReconstructionView;
  readonly to: ReconstructionView;
  close(): Promise<void>;
}

export interface HistoryStatePairs {
  open(
    from: ReconstructionRequest,
    to: ReconstructionRequest,
    signal?: CancellationSignal,
  ): Promise<ReconstructionPair>;
  close(): Promise<void>;
}

export interface HistoryReconstructor {
  open(
    request: ReconstructionRequest,
    signal?: CancellationSignal,
  ): Promise<ReconstructionSession>;
  /** Cancels pending opens and closes every session owned by this reconstructor. */
  close(): Promise<void>;
}
