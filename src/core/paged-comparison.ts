import { alignComparison } from './comparison-alignment';
import { ComparisonContexts, ComparisonProjection } from './comparison-trace';
import { compareStates } from './comparison-diff';
import type { ComparisonRow, ComparisonRunView, StateDifference } from './comparison-types';
import type { Program } from './compiler';
import { initialState, type DeepReadonly, type MachineState, type Step } from './machine';
import { restoreValidatedStep, integer } from './trace-validation';
import { recordingYield, type RecordingJob } from './debugger';
import type { PagedCacheStats, PagedSeekJob } from './paged-history';

export interface ComparisonRecording { kind: 'journal' | 'saved'; id: string; name: string; language?: string; version?: string }
export interface ComparisonReader {
  name: string; program: Program; count: number; maxSteps: number; maxFrames: number;
  readonly state: DeepReadonly<MachineState>; readonly cursor: number; readonly stats: PagedCacheStats;
  readRange(first: number, count: number, job?: PagedSeekJob): Promise<readonly DeepReadonly<Step>[]>;
  seek(cursor: number, job?: PagedSeekJob): Promise<void>; cancel(): void;
}
export interface PagedComparisonSnapshot { cursor: number; left: { state: DeepReadonly<MachineState>; cursor: number; labels: [number, string][]; contexts: [number, number][] }; right: { state: DeepReadonly<MachineState>; cursor: number; labels: [number, string][]; contexts: [number, number][] }; differences: readonly StateDifference[]; stats: { left: PagedCacheStats; right: PagedCacheStats; indexBytes: number; indexLimit: number } }
export interface PagedComparisonJob extends RecordingJob { beforePublish?: (snapshot: PagedComparisonSnapshot) => Promise<void>; onStage?: (stage: 'indexing' | 'analyzing' | 'seeking', done: number, total: number) => void }
interface Side { reader: ComparisonReader; projection: ComparisonProjection }

/** Keeps semantic metadata and two bounded readers, never a full transaction array.
 * Readers' scratch cursors may move independently; only a complete pair is published. */
export class PagedExecutionComparison {
  private rowsValue: ComparisonRow[] = [];
  private sides: [Side, Side];
  private published: [ComparisonRunView, ComparisonRunView];
  private position = 0;
  private first: number | null = null;
  private epoch = 0;
  private indexBytes = 0;
  private constructor(left: ComparisonReader, right: ComparisonReader, readonly indexLimit: number) {
    if (left.program.runtime.language !== right.program.runtime.language || left.program.runtime.version !== right.program.runtime.version) throw new Error('Compare gravações da mesma linguagem e versão');
    integer(indexLimit, 64 * 1024, 64 * 1024 * 1024); const contexts = new ComparisonContexts();
    this.sides = [left, right].map(reader => ({ reader, projection: new ComparisonProjection(reader.name, reader.program, contexts) })) as [Side, Side];
    this.published = this.sides.map(side => this.view(side, initialState(), 0)) as [ComparisonRunView, ComparisonRunView];
  }
  static async prepare(left: ComparisonReader, right: ComparisonReader, indexLimit: number, job: PagedComparisonJob = {}): Promise<PagedExecutionComparison> {
    const comparison = new PagedExecutionComparison(left, right, indexLimit); let done = 0;
    for (const side of comparison.sides) {
      const state = initialState();
      for (let first = 0; first < side.reader.count; first += 16) {
        job.signal?.throwIfAborted(); const records = await side.reader.readRange(first, Math.min(16, side.reader.count - first), { ...job, beforePublish: undefined });
        for (const [index, raw] of records.entries()) { const step = restoreValidatedStep(state, side.reader.program, raw, side.reader.maxFrames); side.projection.append(step, state, first + index + 1); }
        done += records.length; comparison.checkIndex(); job.onStage?.('indexing', done, left.count + right.count); await recordingYield(job);
      }
      side.projection.finish(state, side.reader.count, state.control.status === 'running' && side.reader.count >= side.reader.maxSteps);
    }
    comparison.rowsValue = alignComparison(comparison.sides[0].projection.recordedPoints, comparison.sides[1].projection.recordedPoints); comparison.checkIndex();
    for (let index = 0; index < comparison.rows.length; index++) {
      const pair = await comparison.restore(index, job), row = comparison.rowsValue[index]!, count = compareStates(pair[0], pair[1], row).length;
      comparison.rowsValue[index] = { ...row, differenceCount: count }; if (count && comparison.first === null) comparison.first = index;
      job.onStage?.('analyzing', index + 1, comparison.rows.length); if (index % 16 === 0) await recordingYield(job);
    }
    comparison.published = await comparison.restore(0, job); comparison.checkIndex(); return comparison;
  }
  private checkIndex(): void {
    this.indexBytes = this.rows.length * 192 + this.sides.reduce((bytes, side) => bytes + side.projection.metadataBytes, 0);
    if (this.indexBytes > this.indexLimit) throw new Error('Índice semântico da comparação excedeu o orçamento. As gravações originais foram preservadas.');
  }
  private view(side: Side, state: DeepReadonly<MachineState>, cursor: number): ComparisonRunView {
    const p = side.projection; return { name: side.reader.name, identity: p.identity, program: side.reader.program, state, cursor, history: { length: side.reader.count }, points: p.recordedPoints, limitReached: p.recordedPoints.at(-1)?.phase === 'limit', finalResult: p.resultAtEnd, contextForFrame: id => p.contextForFrame(id), frameLabel: id => p.frameLabel(id) };
  }
  private async restore(index: number, job: PagedComparisonJob): Promise<[ComparisonRunView, ComparisonRunView]> {
    const row = this.rowsValue[index]!, views: ComparisonRunView[] = [];
    for (const [i, side] of this.sides.entries()) { job.signal?.throwIfAborted(); const target = i ? row.rightCursor : row.leftCursor; if (side.reader.cursor !== target) await side.reader.seek(target, { ...job, beforePublish: undefined }); views.push(this.view(side, side.reader.state, side.reader.cursor)); }
    return views as [ComparisonRunView, ComparisonRunView];
  }
  get rows(): readonly ComparisonRow[] { return this.rowsValue; }
  get left() { return this.published[0]; }
  get right() { return this.published[1]; }
  get cursor() { return this.position; }
  get firstDifference() { return this.first; }
  cancel(): void { this.epoch++; this.sides.forEach(s => s.reader.cancel()); }
  private snapshotFor(pair: [ComparisonRunView, ComparisonRunView], cursor: number): PagedComparisonSnapshot {
    const pack = (view: ComparisonRunView) => ({ state: view.state, cursor: view.cursor, labels: view.state.frames.map(f => [f.id, view.frameLabel(f.id)] as [number, string]), contexts: view.state.frames.map(f => [f.id, view.contextForFrame(f.id)] as [number, number]) });
    return { cursor, left: pack(pair[0]), right: pack(pair[1]), differences: compareStates(pair[0], pair[1], this.rowsValue[cursor]!), stats: { left: this.sides[0].reader.stats, right: this.sides[1].reader.stats, indexBytes: this.indexBytes, indexLimit: this.indexLimit } };
  }
  get snapshot() { return this.snapshotFor(this.published, this.position); }
  async seekRow(target: number, job: PagedComparisonJob = {}): Promise<void> {
    integer(target, 0, this.rows.length - 1); const epoch = ++this.epoch, pair = await this.restore(target, job);
    job.signal?.throwIfAborted(); if (epoch !== this.epoch) throw new DOMException('Pedido substituído', 'AbortError');
    await job.beforePublish?.(this.snapshotFor(pair, target)); job.signal?.throwIfAborted(); if (epoch !== this.epoch) throw new DOMException('Pedido substituído', 'AbortError');
    this.published = pair; this.position = target;
  }
}
