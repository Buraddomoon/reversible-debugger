import { compile, type Program } from './compiler';
import { getRuntime, type RuntimeSelection } from './runtime';
import { applyStep, executeInstruction, initialState, type DeepReadonly, type MachineState, type Step } from './machine';
import { CheckpointHistory, HistoryBudgetError, type HistoryOptions, type HistoryStore } from './history';
import { accountStep, measureMachine } from './storage-accounting';
export { HistoryBudgetError } from './history';
import { restoreValidatedStep } from './trace-validation';
import { DEFAULT_EXECUTION_LIMITS, validateExecutionLimits, type ExecutionLimits } from './execution-limits';

export interface RecordingJob {
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
  yieldControl?: () => Promise<void>;
}
export interface RecordingBuilder {
  readonly count: number;
  append(records: readonly unknown[]): void;
  finish(job?: RecordingJob): Promise<DebugSession>;
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
export interface SeekProgress extends SeekResult {
  readonly id: number;
  readonly cursor: number;
  readonly totalSteps: number;
  readonly done: boolean;
}
export interface SeekJob {
  signal?: AbortSignal;
  onProgress?: (progress: SeekProgress) => void;
  yieldControl?: () => Promise<void>;
  batchSize?: number;
  maxMilliseconds?: number;
}
export function validateSeekBatch(size: number, milliseconds: number): void {
  if (!Number.isSafeInteger(size) || size < 1 || size > 1000 || !Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 16) throw new Error('Navegação deve usar 1 a 1.000 passos por lote e orçamento de tempo entre 0 e 16 ms');
}
export class SeekSupersededError extends Error {
  constructor() { super('Navegação substituída por outra ação'); this.name = 'AbortError'; }
}

export class HistoryLimitError extends Error {
  constructor(limit: number) {
    super(`Limite de ${limit.toLocaleString('pt-BR')} passos registrados atingido. Aumente o limite da execução para continuar, ou reinicie.`);
    this.name = 'HistoryLimitError';
  }
}

/** One immutable program, one mutable VM, immutable deltas, and a navigation cursor. */
export class DebugSession {
  private compiled: Program;
  private machine = initialState();
  private storage: HistoryStore;
  private position = 0;
  private limits: ExecutionLimits;
  get maxSteps() { return this.limits.maxSteps; }
  get maxFrames() { return this.limits.maxFrames; }
  get stepLimitReached() { return !this.recordingOnly && this.machine.control.status === 'running' && this.history.length >= this.maxSteps && this.cursor === this.history.length; }
  readonly runtime: RuntimeSelection;
  private recordingOnly = false;
  private payload = measureMachine(this.machine);
  private budgetPause: Readonly<{ reason: 'budget'; requiredBytes: number }> | null = null;
  private seekEpoch = 0;
  private seeking: SeekProgress | null = null;

  constructor(source: string, options: HistoryOptions & { maxSteps?: number; maxFrames?: number; language?: string; version?: string } = {}) {
    this.runtime = getRuntime(options.language ?? 'rewind', options.version);
    this.compiled = compile(source, this.runtime);
    this.limits = { maxSteps: options.maxSteps ?? DEFAULT_EXECUTION_LIMITS.maxSteps, maxFrames: options.maxFrames ?? DEFAULT_EXECUTION_LIMITS.maxFrames };
    validateExecutionLimits(this.limits);
    this.storage = new CheckpointHistory(this.machine, options);
  }
  get program(): Program { return this.compiled; }
  setExecutionLimits(limits: ExecutionLimits): void {
    validateExecutionLimits(limits);
    if (this.recordingOnly) throw new Error('Os limites pertencem à gravação importada. Execute o código de novo para alterá-los.');
    if (limits.maxSteps < this.history.length) throw new Error('O limite não pode ser menor que o histórico já gravado.');
    let depth = 1, peak = 1;
    for (const step of this.history) for (const c of step.changes) if (c.kind === 'frames') { depth += c.added.length - c.removed.length; peak = Math.max(peak, depth); }
    if (limits.maxFrames < peak) throw new Error('O limite da pilha não pode ser menor que a profundidade já registrada, incluindo o futuro.');
    this.cancelSeek(); this.limits = { ...limits };
  }
  get state(): DeepReadonly<MachineState> { return this.machine; }
  get history(): readonly DeepReadonly<Step>[] { return this.storage.steps; }
  get historyStats() { return this.storage.stats; }
  get storageStats() { return this.storage.storageStats; }
  get machinePayload() { return this.payload; }
  get recordingStop() { return this.budgetPause; }
  setHistoryBudget(bytes: number): void {
    this.storage.setBudget(bytes);
    this.cancelSeek();
    if (this.budgetPause && bytes >= this.budgetPause.requiredBytes) this.budgetPause = null;
  }
  measureHistory() { return this.storage.measurePayload(); }
  get cursor(): number { return this.position; }
  get canBackward(): boolean { return this.position > 0; }
  get replayOnly(): boolean { return this.recordingOnly; }
  get canForward(): boolean { return this.position < this.history.length || (!this.recordingOnly && !this.budgetPause && this.machine.control.status === 'running'); }
  get lastStep(): DeepReadonly<Step> | null { return this.history[this.position - 1] ?? null; }

  forward(): DeepReadonly<Step> | null {
    this.cancelSeek();
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
    this.cancelSeek();
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
  get seekProgress(): SeekProgress | null { return this.seeking; }
  cancelSeek(id?: number): void {
    if (id !== undefined && id !== this.seekEpoch) return;
    this.seekEpoch++; this.seeking = null;
  }
  /** The checkpoint copy and each transaction are indivisible. Every published
   * cursor is an exact recorded state, including when cancellation interrupts. */
  beginSeek(target: number): SeekProgress {
    if (!Number.isSafeInteger(target) || target < 0 || target > this.history.length) throw new RangeError('Escolha um passo já registrado no histórico');
    this.cancelSeek();
    const from = this.position;
    const closest = this.storage.nearestCheckpoint(target);
    const useCheckpoint = Math.abs(target - closest) < Math.abs(target - from);
    if (useCheckpoint) { this.machine = this.storage.restoreCheckpoint(closest); this.payload = measureMachine(this.machine); this.position = closest; }
    const progress = Object.freeze({ id: this.seekEpoch, from, to: target, cursor: this.position, checkpoint: useCheckpoint ? closest : null, appliedSteps: 0, totalSteps: Math.abs(target - this.position), done: target === this.position });
    this.seeking = progress.done ? null : progress;
    return progress;
  }
  seekBatch(id: number, size = 128, maxMilliseconds = 6): SeekProgress | null {
    validateSeekBatch(size, maxMilliseconds);
    const plan = this.seeking;
    if (!plan || plan.id !== id) return null;
    const started = performance.now();
    let count = 0;
    while (this.position !== plan.to && count < size) {
      const forward = this.position < plan.to;
      const step = this.history[forward ? this.position : this.position - 1]!;
      applyStep(this.machine, step, forward ? 'forward' : 'backward');
      this.payload = accountStep(this.payload, step, forward ? 'forward' : 'backward');
      this.position += forward ? 1 : -1; count++;
      if (performance.now() - started >= maxMilliseconds) break;
    }
    const progress = Object.freeze({ ...plan, cursor: this.position, appliedSteps: plan.appliedSteps + count, done: this.position === plan.to });
    this.seeking = progress.done ? null : progress;
    return progress;
  }
  /** Compatibility API for synchronous consumers. UI uses bounded batches. */
  seek(target: number): SeekResult {
    let progress = this.beginSeek(target);
    while (!progress.done) progress = this.seekBatch(progress.id, 1000, 8)!;
    return { from: progress.from, to: progress.to, checkpoint: progress.checkpoint, appliedSteps: progress.appliedSteps };
  }
  async seekAsync(target: number, job: SeekJob = {}): Promise<SeekProgress> {
    validateSeekBatch(job.batchSize ?? 128, job.maxMilliseconds ?? 6);
    job.signal?.throwIfAborted();
    let progress = this.beginSeek(target);
    try {
      do {
        job.signal?.throwIfAborted();
        if (progress.id !== this.seekEpoch) throw new SeekSupersededError();
        if (!progress.done) {
          const next = this.seekBatch(progress.id, job.batchSize ?? 128, job.maxMilliseconds ?? 6);
          if (!next) throw new SeekSupersededError();
          progress = next;
        }
        job.onProgress?.(progress);
        job.signal?.throwIfAborted();
        if (progress.id !== this.seekEpoch) throw new SeekSupersededError();
        if (!progress.done) await recordingYield({ signal: job.signal, yieldControl: job.yieldControl });
      } while (!progress.done);
      return progress;
    } catch (error) { this.cancelSeek(progress.id); throw error; }
  }
  rewind(): void { this.seek(0); }
  /** Start a fresh execution without replacing the immutable program or its source. */
  restart(): void { this.cancelSeek(); this.machine = initialState(); this.payload = measureMachine(this.machine); this.storage.clear(); this.position = 0; this.recordingOnly = false; this.budgetPause = null; }

  /** Private staging session; every imported transaction is checked before publication.
   * Partial recordings stop at their last record instead of executing new code. */
  static async restoreRecording(source: string, options: { language: string; version: string; maxSteps: number; maxFrames: number; maxHistoryBytes?: number }, records: readonly unknown[], cursor: number, job: RecordingJob = {}): Promise<DebugSession> {
    job.signal?.throwIfAborted();
    const builder = DebugSession.recordingBuilder(source, options, records.length, cursor);
    let batchStart = performance.now();
    for (let i = 0; i < records.length; i++) {
      builder.append([records[i]]);
      if ((i + 1) % 256 === 0 || performance.now() - batchStart >= 8) { job.onProgress?.(i + 1, records.length); await recordingYield(job); batchStart = performance.now(); }
    }
    const session = await builder.finish(job);
    job.onProgress?.(records.length, records.length);
    return session;
  }
  /** Stream into a private VM. Failed/incomplete builders can never publish. */
  static recordingBuilder(source: string, options: { language: string; version: string; maxSteps: number; maxFrames: number; maxHistoryBytes?: number }, count: number, cursor: number): RecordingBuilder {
    validateExecutionLimits(options);
    if (!Number.isSafeInteger(count) || count < 0 || count > options.maxSteps || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > count) throw new Error('Histórico inválido: limites/cursor incompatíveis');
    const session = new DebugSession(source, options); session.recordingOnly = true;
    let closed = false;
    return {
      get count() { return session.history.length; },
      append(records) {
        if (closed) throw new Error('Restauração encerrada');
        try {
          if (records.length > 256 || session.position + records.length > count) throw new Error('Lote de restauração inconsistente');
          for (const record of records) {
            const step = restoreValidatedStep(session.machine, session.program, record, session.maxFrames);
            const payload = accountStep(session.payload, step, 'forward');
            session.storage.append(step, session.machine, payload); session.payload = payload; session.position++;
          }
        } catch (error) { closed = true; throw error; }
      },
      async finish(job = {}) {
        if (closed || session.position !== count) throw new Error('Restauração incompleta ou encerrada');
        closed = true; job.signal?.throwIfAborted();
        await session.seekAsync(cursor, { signal: job.signal, yieldControl: job.yieldControl });
        return session;
      },
    };
  }
  /** Fork already-owned immutable payloads; the VM and checkpoint indexes are detached. */
  forkForSeek(cursor: number): DebugSession {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.history.length) throw new RangeError('Cursor do histórico inválido');
    const fork = new DebugSession('', { ...this.runtime, maxSteps: this.maxSteps, maxFrames: this.maxFrames });
    fork.compiled = this.program; fork.storage = this.storage.fork();
    const closest = this.storage.nearestCheckpoint(cursor);
    const useCheckpoint = Math.abs(cursor - closest) < Math.abs(cursor - this.cursor);
    fork.machine = useCheckpoint ? this.storage.restoreCheckpoint(closest) : structuredClone(this.machine);
    fork.position = useCheckpoint ? closest : this.position;
    fork.payload = useCheckpoint ? measureMachine(fork.machine) : { ...this.payload }; fork.budgetPause = this.budgetPause;
    fork.recordingOnly = true;
    return fork;
  }
  forkRecording(cursor = this.cursor): DebugSession {
    const fork = this.forkForSeek(cursor); fork.seek(cursor); return fork;
  }
}
