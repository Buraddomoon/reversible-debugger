import type { Program } from './compiler';
import type { SavedExecution } from './execution-library';
import type { StepExplanation } from './explanations';
import type { HistoryEvent } from './history-events';
import type { DeepReadonly, MachineState, Step } from './machine';
import type { PagedCacheStats, PagedOptions, PagedSeekProgress } from './paged-history';
import type { LiveOptions, RecordingLedger } from './live-recording';
import type { TraceMetadata } from './portable-history';
import type { RuntimeSelection } from './runtime';

export interface PagedHeader { entry: SavedExecution; program: Program; events: readonly HistoryEvent[]; limits?: { maxSteps: number; maxFrames: number } }
export interface PagedSnapshot { cursor: number; count: number; state: DeepReadonly<MachineState>; step: Pick<Step, 'span' | 'op' | 'description'> | null; evidence: StepExplanation | null; reverse: boolean; changedNames: string[]; stats: PagedCacheStats; recording?: RecordingLedger }
export type PagedRequest = { id: number } & (
  { kind: 'open'; recordingId: string; options: PagedOptions } | { kind: 'seek'; target: number } | { kind: 'cache'; bytes: number } | { kind: 'cancel' }
  | { kind: 'ack' }
);
export type PagedResponse =
  | { id: number; kind: 'index-progress'; done: number; total: number }
  | { id: number; kind: 'seek-progress'; progress: PagedSeekProgress }
  | { id: number; kind: 'state'; snapshot: PagedSnapshot; header?: PagedHeader }
  | { id: number; kind: 'error'; message: string; aborted: boolean };
export type LiveRequest = Exclude<PagedRequest, { kind: 'open' }> | ({ id: number } & (
  { kind: 'start'; source: string; runtime: RuntimeSelection; metadata: TraceMetadata; options: LiveOptions }
  | { kind: 'resume'; recordingId: string; options: LiveOptions }
  | { kind: 'flush' | 'close' | 'run' }
  | { kind: 'range'; first: number; count: number }
));
export type LiveResponse = PagedResponse
  | { id: number; kind: 'prepared'; snapshot: PagedSnapshot }
  | { id: number; kind: 'records'; records: readonly DeepReadonly<Step>[] }
  | { id: number; kind: 'state'; snapshot: PagedSnapshot; header?: PagedHeader; events?: readonly HistoryEvent[] };
