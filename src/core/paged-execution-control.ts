import { HistoryBudgetError } from './history';
import { ExecutionPolicy, type ExecutionView, type RunResult, type RunMode, type DebugStop } from './execution-control';
import type { LiveRecording } from './live-recording';
import type { PagedHistoryStore } from './paged-history';

export interface PagedDebugState {
  readonly breakpoints: readonly number[];
  readonly enabled: boolean;
  readonly mode: RunMode | null;
  readonly stop: DebugStop | null;
  readonly canStepOut: boolean;
  readonly error: string | null;
}

/** Bounded, accepted batches: no full trace or additional command snapshots.
 * The worker obtains ACK before calling this driver. Pause completes at most 16
 * accepted instructions; manual seeks keep their separate atomic commit protocol. */
export class PagedExecutionControl extends ExecutionPolicy {
  private error: string | null = null;
  constructor(readonly store: LiveRecording | PagedHistoryStore) {
    const view: ExecutionView = {
      get program() { return store.program; }, get state() { return store.state; }, get cursor() { return store.cursor; },
      get canForward() { return store.cursor < store.count || ('ledger' in store && store.ledger.canRecord); },
      get canBackward() { return store.cursor > 0; },
      get recordingStop() { return 'ledger' in store && (store.ledger.pauseReason || store.count >= store.source.maxSteps); },
    };
    super(view);
  }
  get snapshot(): PagedDebugState { return { breakpoints: this.breakpoints, enabled: this.breakpointsEnabled, mode: this.mode, stop: this.stop, canStepOut: this.canStepOut, error: this.error }; }
  fail(cause: unknown): void { this.pause(); this.error = cause instanceof Error ? cause.message : String(cause); }
  override cancel(): void { super.cancel(); this.error = null; }
  override start(mode: RunMode): void { super.start(mode); this.error = null; }
  async runBatch(size = 16): Promise<RunResult> {
    if (!Number.isInteger(size) || size < 1 || size > 16) throw new Error('O lote paginado deve ter entre 1 e 16 passos');
    const batch = this.batch(size); let next = batch.next();
    try {
      while (!next.done) {
        const reverse = next.value === 'backward', before = reverse ? this.store.lastStep : null;
        try { await this.store.seek(this.store.cursor + (reverse ? -1 : 1)); }
        catch (cause) {
          if (cause instanceof HistoryBudgetError && 'stop' in this.store) this.store.stop(cause.message);
          next = batch.throw(cause); continue;
        }
        next = batch.next(reverse ? before : this.store.lastStep);
      }
      return next.value;
    } catch (cause) { this.fail(cause); throw cause; }
  }
}
