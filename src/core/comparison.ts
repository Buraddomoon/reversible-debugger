import { alignComparison } from './comparison-alignment';
import { compareStates } from './comparison-diff';
import { ComparisonContexts, RecordedComparisonRun } from './comparison-trace';
import type { ComparisonRow, ComparisonRunView, ComparisonSource, StateDifference } from './comparison-types';
import type { HistoryOptions } from './history';
import { validateSeekBatch, type DebugSession, type SeekProgress } from './debugger';

export type ComparisonStage = 'recording' | 'analyzing' | 'ready' | 'cancelled';
export interface ComparisonSeekProgress { readonly id: number; readonly target: number; readonly completedSteps: number; readonly totalSteps: number; readonly done: boolean }
interface ComparisonSeekPlan {
  progress: ComparisonSeekProgress;
  sessions: readonly [DebugSession, DebugSession];
  seeks: [SeekProgress, SeekProgress];
  turn: number;
}

/** Two isolated deterministic executions, deltas/checkpoints, and a lightweight alignment. */
export class ExecutionComparison {
  private readonly runs: readonly [RecordedComparisonRun, RecordedComparisonRun];
  private alignment: ComparisonRow[] = [];
  private stageValue: ComparisonStage = 'recording';
  private recordingTurn = 0;
  private analysisCursor = 0;
  private position = 0;
  private first: number | null = null;
  private seekEpoch = 0;
  private seeking: ComparisonSeekPlan | null = null;

  constructor(left: ComparisonSource, right: ComparisonSource, options: HistoryOptions & { maxSteps?: number; maxFrames?: number } = {}) {
    const contexts = new ComparisonContexts();
    this.runs = [new RecordedComparisonRun(left, contexts, options), new RecordedComparisonRun(right, contexts, options)];
    if (this.left.program.runtime.language !== this.right.program.runtime.language || this.left.program.runtime.version !== this.right.program.runtime.version) throw new Error('Compare programas da mesma linguagem e versão');
  }
  get left(): ComparisonRunView { return this.runs[0]; }
  get right(): ComparisonRunView { return this.runs[1]; }
  get rows(): readonly ComparisonRow[] { return this.alignment; }
  get stage(): ComparisonStage { return this.stageValue; }
  get cursor(): number { return this.position; }
  get firstDifference(): number | null { return this.first; }
  get analyzedRows(): number { return this.analysisCursor; }
  get ready(): boolean { return this.stageValue === 'ready'; }
  cancel(): void { this.cancelNavigation(); if (!this.ready) this.stageValue = 'cancelled'; }
  prepareBatch(size = 256): void {
    if (!Number.isInteger(size) || size < 1 || size > 1000) throw new Error('O lote deve ter entre 1 e 1.000 operações');
    const started = performance.now();
    if (this.stageValue === 'recording') {
      for (let i = 0; i < size && !this.runs.every(run => run.done); i++) {
        const run = this.runs[this.recordingTurn++ % 2]!;
        if (!run.done) run.advance();
        if (performance.now() - started >= 6) break;
      }
      if (this.runs.every(run => run.done)) {
        this.alignment = alignComparison(this.left.points, this.right.points);
        this.stageValue = 'analyzing';
      }
    } else if (this.stageValue === 'analyzing') {
      for (let i = 0; i < size; i++) {
        const resetting = this.analysisCursor === this.alignment.length;
        const progress = this.seeking?.progress ?? this.startRestore(resetting ? 0 : this.analysisCursor);
        const update = progress.done ? progress : this.seekRowBatch(progress.id, 32, 6)!;
        if (update.done) {
          if (resetting) { Object.freeze(this.alignment); this.stageValue = 'ready'; break; }
          const row = this.alignment[this.analysisCursor]!;
          const count = compareStates(this.runs[0], this.runs[1], row).length;
          this.alignment[this.analysisCursor] = Object.freeze({ ...row, differenceCount: count });
          if (count && this.first === null) this.first = this.analysisCursor;
          this.analysisCursor++;
        }
        if (performance.now() - started >= 6) break;
      }
    }
  }
  get navigationProgress(): ComparisonSeekProgress | null { return this.seeking?.progress ?? null; }
  cancelNavigation(id?: number): void {
    if (id !== undefined && id !== this.seekEpoch) return;
    this.seekEpoch++; this.seeking = null;
  }
  private startRestore(target: number): ComparisonSeekProgress {
    if (!Number.isSafeInteger(target) || target < 0 || target >= this.alignment.length) throw new RangeError('Escolha uma posição válida da comparação');
    this.cancelNavigation();
    const row = this.alignment[target]!;
    const sessions = [this.runs[0].forkForSeek(row.leftCursor), this.runs[1].forkForSeek(row.rightCursor)] as const;
    const seeks: [SeekProgress, SeekProgress] = [sessions[0].beginSeek(row.leftCursor), sessions[1].beginSeek(row.rightCursor)];
    const progress = Object.freeze({ id: this.seekEpoch, target, completedSteps: 0, totalSteps: seeks[0].totalSteps + seeks[1].totalSteps, done: seeks.every(seek => seek.done) });
    this.seeking = { progress, sessions, seeks, turn: 0 };
    if (progress.done) this.publishNavigation();
    return progress;
  }
  beginSeekRow(target: number): ComparisonSeekProgress {
    if (!this.ready) throw new Error('Aguarde a preparação da comparação');
    return this.startRestore(target);
  }
  private publishNavigation(): void {
    const plan = this.seeking!;
    this.runs[0].publishNavigation(plan.sessions[0]); this.runs[1].publishNavigation(plan.sessions[1]);
    this.position = plan.progress.target; this.seeking = null;
  }
  seekRowBatch(id: number, size = 128, maxMilliseconds = 6): ComparisonSeekProgress | null {
    validateSeekBatch(size, maxMilliseconds);
    const plan = this.seeking;
    if (!plan || plan.progress.id !== id) return null;
    const started = performance.now();
    let count = 0;
    while (count < size && !plan.seeks.every(seek => seek.done)) {
      const side = plan.turn++ % 2;
      if (plan.seeks[side]!.done) continue;
      plan.seeks[side] = plan.sessions[side]!.seekBatch(plan.seeks[side]!.id, 1, maxMilliseconds)!;
      count++;
      if (performance.now() - started >= maxMilliseconds) break;
    }
    plan.progress = Object.freeze({ ...plan.progress, completedSteps: plan.progress.completedSteps + count, done: plan.seeks.every(seek => seek.done) });
    const progress = plan.progress;
    if (progress.done) this.publishNavigation();
    return progress;
  }
  seekRow(target: number): void {
    let progress = this.beginSeekRow(target);
    while (!progress.done) progress = this.seekRowBatch(progress.id, 1000, 8)!;
  }
  differences(): readonly StateDifference[] {
    if (!this.ready) return [];
    return compareStates(this.runs[0], this.runs[1], this.alignment[this.position]!);
  }
}
