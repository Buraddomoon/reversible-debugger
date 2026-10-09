import type { DeepReadonly, Step } from './machine';

export type EventKind = 'call' | 'return' | 'decision' | 'output' | 'error' | 'end';
export interface HistoryEvent {
  readonly cursor: number;
  readonly kind: EventKind;
  readonly line: number;
  readonly description: string;
}
/** A cursor is the state AFTER this recorded event, including terminal errors. */
export function historyEvent(step: DeepReadonly<Step>, cursor: number): HistoryEvent | null {
  const control = step.changes.find(change => change.kind === 'control');
  let kind: EventKind;
  if (control?.kind === 'control' && control.after.status === 'error') kind = 'error';
  else if (step.changes.some(change => change.kind === 'frames' && change.added.length)) kind = 'call';
  else if (step.changes.some(change => change.kind === 'frames' && change.removed.length)) kind = 'return';
  else if (step.op === 'JUMP_IF_FALSE') kind = 'decision';
  else if (step.changes.some(change => change.kind === 'output')) kind = 'output';
  else if (step.op === 'HALT') kind = 'end';
  else return null;
  return { cursor, kind, line: step.span.line, description: step.description };
}
