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

/** Incremental projection of an append-only immutable trace. Navigation does not
 * reclassify old instructions; restart/replacement invalidates the index. */
export class HistoryEventIndex {
  private history: readonly DeepReadonly<Step>[] | null = null;
  private processed = 0;
  private last: DeepReadonly<Step> | null = null;
  private events: HistoryEvent[] = [];
  update(history: readonly DeepReadonly<Step>[]): readonly HistoryEvent[] {
    if (history !== this.history || history.length < this.processed || (this.processed > 0 && history[this.processed - 1] !== this.last)) {
      this.history = history; this.processed = 0; this.last = null; this.events = [];
    }
    while (this.processed < history.length) {
      const step = history[this.processed]!;
      const event = historyEvent(step, this.processed + 1);
      if (event) this.events.push(Object.freeze(event));
      this.last = step; this.processed++;
    }
    return this.events;
  }
}
export function firstEventAfter(events: readonly HistoryEvent[], cursor: number): number {
  let low = 0, high = events.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (events[mid]!.cursor <= cursor) low = mid + 1; else high = mid;
  }
  return low;
}
