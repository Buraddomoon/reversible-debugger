import type { DeepReadonly, MachineState, Step } from './machine';

export interface HistoryOptions { checkpointInterval?: number; maxCheckpoints?: number }
export interface HistoryStats {
  readonly checkpointInterval: number;
  readonly checkpointCursors: readonly number[];
}
/** Storage owns immutable records; only the session owns the live machine. */
export interface HistoryStore {
  readonly steps: readonly DeepReadonly<Step>[];
  readonly stats: HistoryStats;
  append(step: Step, state: MachineState): void;
  nearestCheckpoint(target: number): number;
  restoreCheckpoint(cursor: number): MachineState;
  clear(): void;
  measurePayload(): { deltaBytes: number; checkpointBytes: number };
}

export class CheckpointHistory implements HistoryStore {
  private records: DeepReadonly<Step>[] = [];
  private checkpoints = new Map<number, DeepReadonly<MachineState>>();
  private interval: number;
  private readonly baseInterval: number;
  private readonly maxCheckpoints: number;
  private readonly origin: DeepReadonly<MachineState>;

  constructor(initial: MachineState, options: HistoryOptions = {}) {
    this.baseInterval = options.checkpointInterval ?? 128;
    this.maxCheckpoints = options.maxCheckpoints ?? 128;
    if (!Number.isSafeInteger(this.baseInterval) || this.baseInterval < 1) throw new Error('checkpointInterval precisa ser um inteiro positivo');
    if (!Number.isSafeInteger(this.maxCheckpoints) || this.maxCheckpoints < 2) throw new Error('maxCheckpoints precisa ser um inteiro maior que um');
    this.interval = this.baseInterval;
    this.origin = freezePayload(structuredClone(initial));
    this.clear();
  }
  get steps(): readonly DeepReadonly<Step>[] { return this.records; }
  get stats(): HistoryStats {
    return { checkpointInterval: this.interval, checkpointCursors: [...this.checkpoints.keys()] };
  }
  append(step: Step, state: MachineState): void {
    this.records.push(freezePayload(step));
    const cursor = this.records.length;
    if (cursor % this.interval !== 0) return;
    // Thin evenly across the entire trace when the count budget is reached.
    // The origin is never evicted; deltas remain available at every cursor.
    if (this.checkpoints.size >= this.maxCheckpoints) {
      this.interval *= 2;
      for (const position of this.checkpoints.keys()) if (position % this.interval !== 0) this.checkpoints.delete(position);
    }
    if (cursor % this.interval === 0) this.checkpoints.set(cursor, freezePayload(structuredClone(state)));
  }
  nearestCheckpoint(target: number): number {
    let closest = 0;
    for (const cursor of this.checkpoints.keys()) {
      if (Math.abs(target - cursor) < Math.abs(target - closest)) closest = cursor;
    }
    return closest;
  }
  restoreCheckpoint(cursor: number): MachineState {
    const saved = this.checkpoints.get(cursor);
    if (!saved) throw new Error(`Checkpoint inexistente: ${cursor}`);
    // structuredClone preserves bigint, -0 and non-finite numbers, and detaches
    // every live frame/operand from the saved checkpoint.
    return structuredClone(saved) as MachineState;
  }
  clear(): void {
    this.records = [];
    this.interval = this.baseInterval;
    this.checkpoints = new Map([[0, this.origin]]);
  }
  /** Encoded payload size, measured on demand; this is not a JS heap estimate. */
  measurePayload(): { deltaBytes: number; checkpointBytes: number } {
    return { deltaBytes: encodedBytes(this.records), checkpointBytes: encodedBytes([...this.checkpoints]) };
  }
}

function freezePayload<T extends object>(value: T): DeepReadonly<T> {
  if (!Object.isFrozen(value)) {
    for (const child of Object.values(value)) if (child !== null && typeof child === 'object') freezePayload(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** For benchmark accounting only; never used to save or restore program state. */
export function encodedBytes(value: unknown): number {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return { $bigint: item.toString() };
    if (typeof item === 'number' && (Object.is(item, -0) || !Number.isFinite(item))) return { $number: String(Object.is(item, -0) ? '-0' : item) };
    return item;
  });
  return new TextEncoder().encode(encoded).byteLength;
}
