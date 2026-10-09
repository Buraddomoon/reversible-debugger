import { alignComparison } from './comparison-alignment';
import { compareStates } from './comparison-diff';
import { ComparisonContexts, RecordedComparisonRun } from './comparison-trace';
import type { ComparisonRow, ComparisonRunView, ComparisonSource, StateDifference } from './comparison-types';
import type { HistoryOptions } from './history';

export type ComparisonStage = 'recording' | 'analyzing' | 'ready' | 'cancelled';

/** Two isolated deterministic executions, deltas/checkpoints, and a lightweight alignment. */
export class ExecutionComparison {
  private readonly runs: readonly [RecordedComparisonRun, RecordedComparisonRun];
  private alignment: ComparisonRow[] = [];
  private stageValue: ComparisonStage = 'recording';
  private recordingTurn = 0;
  private analysisCursor = 0;
  private position = 0;
  private first: number | null = null;

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
  cancel(): void { if (!this.ready) this.stageValue = 'cancelled'; }
  prepareBatch(size = 256): void {
    if (!Number.isInteger(size) || size < 1 || size > 1000) throw new Error('O lote deve ter entre 1 e 1.000 operações');
    if (this.stageValue === 'recording') {
      for (let i = 0; i < size && !this.runs.every(run => run.done); i++) {
        const run = this.runs[this.recordingTurn++ % 2]!;
        if (!run.done) run.advance();
      }
      if (this.runs.every(run => run.done)) {
        this.alignment = alignComparison(this.left.points, this.right.points);
        this.stageValue = 'analyzing';
      }
    } else if (this.stageValue === 'analyzing') {
      for (let i = 0; i < size && this.analysisCursor < this.alignment.length; i++) {
        const row = this.alignment[this.analysisCursor]!;
        this.restore(row);
        const count = compareStates(this.runs[0], this.runs[1], row).length;
        this.alignment[this.analysisCursor] = Object.freeze({ ...row, differenceCount: count });
        if (count && this.first === null) this.first = this.analysisCursor;
        this.analysisCursor++;
      }
      if (this.analysisCursor === this.alignment.length) {
        Object.freeze(this.alignment);
        this.stageValue = 'ready'; this.seekRow(0);
      }
    }
  }
  private restore(row: ComparisonRow): void { this.runs[0].seek(row.leftCursor); this.runs[1].seek(row.rightCursor); }
  seekRow(target: number): void {
    if (!this.ready) throw new Error('Aguarde a preparação da comparação');
    if (!Number.isSafeInteger(target) || target < 0 || target >= this.alignment.length) throw new RangeError('Escolha uma posição válida da comparação');
    this.restore(this.alignment[target]!); this.position = target;
  }
  differences(): readonly StateDifference[] {
    if (!this.ready) return [];
    return compareStates(this.runs[0], this.runs[1], this.alignment[this.position]!);
  }
}
