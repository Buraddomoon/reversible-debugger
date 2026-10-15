import type { Program } from './compiler';
import type { Value } from './language';
import type { DeepReadonly, MachineState } from './machine';
import type { RuntimeSelection } from './runtime';
import type { DebugSession } from './debugger';

export interface ComparisonSource { name: string; source: string; language: string; version?: string; recording?: DebugSession }
export interface RunIdentity {
  readonly fingerprint: string;
  readonly source: string;
  readonly runtime: RuntimeSelection;
  readonly initial: DeepReadonly<MachineState>;
}
export type ComparisonPhase = 'initial' | 'write' | 'mutation' | 'decision' | 'call' | 'return' | 'output' | 'error' | 'end' | 'limit' | 'pause';
export interface ComparisonPoint {
  readonly key: string;
  readonly cursor: number;
  readonly phase: ComparisonPhase;
  readonly line: number | null;
  readonly occurrence: number;
  readonly description: string;
  readonly outcome: boolean | null;
}
export interface ComparisonRunView {
  readonly name: string;
  readonly identity: RunIdentity;
  readonly program: Program;
  readonly state: DeepReadonly<MachineState>;
  readonly cursor: number;
  readonly history: { readonly length: number };
  readonly points: readonly ComparisonPoint[];
  readonly limitReached: boolean;
  readonly finalResult: DifferenceValue;
  contextForFrame(id: number): number;
  frameLabel(id: number): string;
}
export interface ComparisonRow {
  readonly leftPoint: number | null;
  readonly rightPoint: number | null;
  /** In a one-sided row the other execution stays at its last represented point. */
  readonly leftCursor: number;
  readonly rightCursor: number;
  readonly leftStatePoint: number;
  readonly rightStatePoint: number;
  readonly differenceCount: number;
}
export type DifferenceValue = { readonly present: false } | {
  readonly present: true;
  readonly value: DeepReadonly<Value> | string | readonly string[] | readonly DeepReadonly<Value>[];
};
export interface StateDifference {
  readonly category: 'variables' | 'heap' | 'stack' | 'operands' | 'output' | 'control' | 'decision' | 'flow';
  readonly name: string;
  readonly left: DifferenceValue;
  readonly right: DifferenceValue;
}
