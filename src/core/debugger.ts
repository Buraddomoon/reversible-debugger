import { compile, type Program } from './compiler';
import { getRuntime, type RuntimeSelection } from './runtime';
import { applyStep, executeInstruction, initialState, type DeepReadonly, type MachineState, type Step } from './machine';
import { CheckpointHistory, HistoryBudgetError, type HistoryOptions, type HistoryStore } from './history';
import { accountStep, measureMachine } from './storage-accounting';
export { HistoryBudgetError } from './history';
import { restoreValidatedStep } from './trace-validation';

export interface RecordingJob {
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
  yieldControl?: () => Promise<void>;
}
export async function recordingYield(job: RecordingJob): Promise<void> {
  job.signal?.throwIfAborted();
  await (job.yieldControl?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
  job.signal?.throwIfAborted();
}

export interface SeekResult {
  readonly from: number;
  readonly to: number;
  readonly checkpoint: number | null;
  readonly appliedSteps: number;
}

export class HistoryLimitError extends Error {
  constructor(limit: number) {
    super(`Limite de ${limit.toLocaleString('pt-BR')} passos registrados atingido. Reinicie ou reduza o programa.`);
    this.name = 'HistoryLimitError';
  }
}

/** One immutable program, one mutable VM, immutable deltas, and a navigation cursor. */
export class DebugSession {
  private compiled: Program;
  private machine = initialState();
  private storage: HistoryStore;
  private position = 0;
  readonly maxSteps: number;
  readonly maxFrames: number;
  readonly runtime: RuntimeSelection;
  private recordingOnly = false;
  private payload = measureMachine(this.machine);
  private budgetPause: Readonly<{ reason: 'budget'; requiredBytes: number }> | null = null;

  constructor(source: string, options: HistoryOptions & { maxSteps?: number; maxFrames?: number; language?: string; version?: string } = {}) {
    this.runtime = getRuntime(options.language ?? 'rewind', options.version);
    this.compiled = compile(source, this.runtime);
    this.maxSteps = options.maxSteps ?? 20_000;
    this.maxFrames = options.maxFrames ?? 256;
    if (!Number.isInteger(this.maxSteps) || this.maxSteps < 1) throw new Error('maxSteps precisa ser um inteiro positivo');
    if (!Number.isInteger(this.maxFrames) || this.maxFrames < 2) throw new Error('maxFrames precisa ser um inteiro maior que um');
    this.storage = new CheckpointHistory(this.machine, options);
  }
  get program(): Program { return this.compiled; }
  get state(): DeepReadonly<MachineState> { return this.machine; }
  get history(): readonly DeepReadonly<Step>[] { return this.storage.steps; }
  get historyStats() { return this.storage.stats; }
  get storageStats() { return this.storage.storageStats; }
  get machinePayload() { return this.payload; }
  get recordingStop() { return this.budgetPause; }
  setHistoryBudget(bytes: number): void {
    this.storage.setBudget(bytes);
    if (this.budgetPause && bytes >= this.budgetPause.requiredBytes) this.budgetPause = null;
  }
  measureHistory() { return this.storage.measurePayload(); }
  get cursor(): number { return this.position; }
  get canBackward(): boolean { return this.position > 0; }
  get replayOnly(): boolean { return this.recordingOnly; }
  get canForward(): boolean { return this.position < this.history.length || (!this.recordingOnly && !this.budgetPause && this.machine.control.status === 'running'); }
  get lastStep(): DeepReadonly<Step> | null { return this.history[this.position - 1] ?? null; }

  forward(): DeepReadonly<Step> | null {
    if (!this.canForward) return null;
    let step = this.history[this.position];
    if (step) {
      applyStep(this.machine, step, 'forward');
      this.payload = accountStep(this.payload, step, 'forward');
    }
    else {
      if (this.history.length >= this.maxSteps) throw new HistoryLimitError(this.maxSteps);
      const recorded = executeInstruction(this.machine, this.program, this.maxFrames);
      const payload = accountStep(this.payload, recorded, 'forward');
      // Each instruction retains deltas; storage also captures sparse checkpoints.
      try { this.storage.append(recorded, this.machine, payload); }
      catch (error) {
        applyStep(this.machine, recorded, 'backward');
        if (error instanceof HistoryBudgetError) this.budgetPause = Object.freeze({ reason: 'budget', requiredBytes: error.requiredBytes });
        throw error;
      }
      this.payload = payload;
      step = recorded;
    }
    this.position++;
    return step;
  }
  backward(): DeepReadonly<Step> | null {
    if (!this.canBackward) return null;
    const step = this.history[this.position - 1]!;
    applyStep(this.machine, step, 'backward');
    this.payload = accountStep(this.payload, step, 'backward');
    this.position--;
    return step;
  }
  /** Bounded batches let callers yield between chunks, including infinite loops. */
  runBatch(size = 100): number {
    if (!Number.isInteger(size) || size < 1 || size > 1000) throw new Error('O lote deve ter entre 1 e 1.000 passos');
    let count = 0;
    while (count < size && this.canForward) { this.forward(); count++; }
    return count;
  }
  /** Reset is navigation: preserve recorded history for exact forward replay. */
  backwardBatch(size = 100): number {
    if (!Number.isInteger(size) || size < 1 || size > 1000) throw new Error('O lote deve ter entre 1 e 1.000 passos');
    let count = 0;
    while (count < size && this.canBackward) { this.backward(); count++; }
    return count;
  }
  /** Seek recorded states only. Replay never executes program instructions. */
  seek(target: number): SeekResult {
    if (!Number.isSafeInteger(target) || target < 0 || target > this.history.length) throw new RangeError('Escolha um passo já registrado no histórico');
    const from = this.position;
    const closest = this.storage.nearestCheckpoint(target);
    const useCheckpoint = Math.abs(target - closest) < Math.abs(target - from);
    if (useCheckpoint) { this.machine = this.storage.restoreCheckpoint(closest); this.payload = measureMachine(this.machine); this.position = closest; }
    const appliedSteps = Math.abs(target - this.position);
    while (this.position < target) this.forward();
    while (this.position > target) this.backward();
    return { from, to: target, checkpoint: useCheckpoint ? closest : null, appliedSteps };
  }
  rewind(): void { this.seek(0); }
  /** Start a fresh execution without replacing the immutable program or its source. */
  restart(): void { this.machine = initialState(); this.payload = measureMachine(this.machine); this.storage.clear(); this.position = 0; this.recordingOnly = false; this.budgetPause = null; }

  /** Private staging session; every imported transaction is checked before publication.
   * Partial recordings stop at their last record instead of executing new code. */
  static async restoreRecording(source: string, options: { language: string; version: string; maxSteps: number; maxFrames: number; maxHistoryBytes?: number }, records: readonly unknown[], cursor: number, job: RecordingJob = {}): Promise<DebugSession> {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > records.length || records.length > options.maxSteps || options.maxSteps > 20_000 || options.maxFrames > 256) throw new Error('Histórico inválido: limites/cursor incompatíveis');
    job.signal?.throwIfAborted();
    const session = new DebugSession(source, options);
    session.recordingOnly = true;
    let batchStart = performance.now();
    for (let i = 0; i < records.length; i++) {
      const step = restoreValidatedStep(session.machine, session.program, records[i], session.maxFrames);
      const payload = accountStep(session.payload, step, 'forward');
      session.storage.append(step, session.machine, payload); session.payload = payload; session.position++;
      if ((i + 1) % 256 === 0 || performance.now() - batchStart >= 8) { job.onProgress?.(i + 1, records.length); await recordingYield(job); batchStart = performance.now(); }
    }
    job.signal?.throwIfAborted(); session.seek(cursor);
    job.onProgress?.(records.length, records.length);
    return session;
  }
  /** Fork already-owned immutable payloads; the VM and checkpoint indexes are detached. */
  forkRecording(cursor = this.cursor): DebugSession {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.history.length) throw new RangeError('Cursor do histórico inválido');
    const fork = new DebugSession('', { ...this.runtime, maxSteps: this.maxSteps, maxFrames: this.maxFrames });
    fork.compiled = this.program; fork.storage = this.storage.fork();
    fork.machine = structuredClone(this.machine); fork.position = this.position;
    fork.payload = { ...this.payload }; fork.budgetPause = this.budgetPause;
    fork.recordingOnly = true;
    fork.seek(cursor); return fork;
  }
}
