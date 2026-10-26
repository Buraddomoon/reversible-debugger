import type { ComparisonRow, ComparisonRunView } from './comparison-types';
import type { ComparisonRecording, PagedComparisonSnapshot } from './paged-comparison';
export type ComparisonRunHeader = Pick<ComparisonRunView, 'name' | 'identity' | 'program' | 'history' | 'points' | 'limitReached' | 'finalResult'>;
export interface ComparisonHeader { left: ComparisonRunHeader; right: ComparisonRunHeader; rows: readonly ComparisonRow[]; firstDifference: number | null }
export type ComparisonRequest = { id: number } & ({ kind: 'open'; left: ComparisonRecording; right: ComparisonRecording; budget: number } | { kind: 'seek'; target: number } | { kind: 'cancel' | 'ack' });
export type ComparisonResponse = { id: number } & ({ kind: 'prepared' } | { kind: 'state'; snapshot: PagedComparisonSnapshot; header?: ComparisonHeader } | { kind: 'progress'; stage: string; done: number; total: number } | { kind: 'error'; message: string; aborted: boolean });
