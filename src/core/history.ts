import type { DeepReadonly, MachineState, Step } from './machine';
import { encodedBytes, measureMachine, type MachinePayload } from './storage-accounting';
export { encodedBytes } from './storage-accounting';

export const DEFAULT_HISTORY_BYTES = 64 * 1024 * 1024;
export const MAX_HISTORY_BYTES = 256 * 1024 * 1024;
export function validateHistoryBudget(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_HISTORY_BYTES) throw new Error('Orçamento do histórico deve ser um inteiro positivo de até 256 MiB');
}
export class HistoryBudgetError extends Error {
  constructor(readonly limitBytes: number, readonly requiredBytes: number) {
    super(`Orçamento do histórico atingido. A próxima instrução precisa de pelo menos ${(requiredBytes / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} KiB de payload. Os passos registrados foram preservados.`);
    this.name = 'HistoryBudgetError';
  }
}

export interface HistoryOptions { checkpointInterval?: number; maxCheckpoints?: number; maxHistoryBytes?: number }
export interface StorageStats {
  readonly deltaBytes: number;
  readonly checkpointBytes: number;
  readonly reservedMachineBytes: number;
  readonly estimatedBytes: number;
  readonly limitBytes: number;
  readonly skippedCheckpoints: number;
}
export interface HistoryStats {
  readonly checkpointInterval: number;
  readonly checkpointCursors: readonly number[];
}
/** Storage owns immutable records; only the session owns the live machine. */
export interface HistoryStore {
  readonly steps: readonly DeepReadonly<Step>[];
  readonly stats: HistoryStats;
  readonly storageStats: StorageStats;
  setBudget(bytes: number): void;
  append(step: Step, state: MachineState, payload?: MachinePayload): void;
  nearestCheckpoint(target: number): number;
  restoreCheckpoint(cursor: number): MachineState;
  clear(): void;
  measurePayload(): { deltaBytes: number; checkpointBytes: number };
  fork(): HistoryStore;
}

export class CheckpointHistory implements HistoryStore {
  private records: DeepReadonly<Step>[] = [];
  private checkpoints = new Map<number, DeepReadonly<MachineState>>();
  private interval: number;
  private readonly baseInterval: number;
  private readonly maxCheckpoints: number;
  private readonly origin: DeepReadonly<MachineState>;
  private checkpointSizes = new Map<number, number>();
  private deltaBytes = 2;
  private checkpointBytes = 2;
  private reservedMachineBytes = 0;
  private skippedCheckpoints = 0;
  private budget: number;

  constructor(initial: MachineState, options: HistoryOptions = {}) {
    this.baseInterval = options.checkpointInterval ?? 128;
    this.maxCheckpoints = options.maxCheckpoints ?? 128;
    if (!Number.isSafeInteger(this.baseInterval) || this.baseInterval < 1) throw new Error('checkpointInterval precisa ser um inteiro positivo');
    if (!Number.isSafeInteger(this.maxCheckpoints) || this.maxCheckpoints < 2) throw new Error('maxCheckpoints precisa ser um inteiro maior que um');
    this.interval = this.baseInterval;
    this.budget = options.maxHistoryBytes ?? DEFAULT_HISTORY_BYTES;
    validateHistoryBudget(this.budget);
    this.origin = freezePayload(structuredClone(initial));
    this.clear();
    if (this.storageStats.estimatedBytes > this.budget) throw new HistoryBudgetError(this.budget, this.storageStats.estimatedBytes);
  }
  get steps(): readonly DeepReadonly<Step>[] { return this.records; }
  get stats(): HistoryStats {
    return { checkpointInterval: this.interval, checkpointCursors: [...this.checkpoints.keys()] };
  }
  get storageStats(): StorageStats {
    return { deltaBytes: this.deltaBytes, checkpointBytes: this.checkpointBytes, reservedMachineBytes: this.reservedMachineBytes, estimatedBytes: this.deltaBytes + this.checkpointBytes + this.reservedMachineBytes, limitBytes: this.budget, skippedCheckpoints: this.skippedCheckpoints };
  }
  setBudget(bytes: number): void {
    validateHistoryBudget(bytes);
    if (bytes < this.storageStats.estimatedBytes) throw new Error('O limite precisa cobrir o payload já reservado. Nenhum passo ou checkpoint foi removido.');
    this.budget = bytes;
  }
  append(step: Step, state: MachineState, payload = measureMachine(state)): void {
    const deltaBytes = this.deltaBytes + encodedBytes(step) + 1;
    const reservedMachineBytes = Math.max(this.reservedMachineBytes, payload.totalBytes);
    const minimum = deltaBytes + 2 + this.checkpointSizes.get(0)! + reservedMachineBytes;
    if (minimum > this.budget) throw new HistoryBudgetError(this.budget, minimum);
    // Plan all removals before mutating storage: refusal is atomic.
    const removals = new Set<number>();
    let checkpointBytes = this.checkpointBytes;
    const remove = (cursor: number) => { if (!removals.has(cursor)) { removals.add(cursor); checkpointBytes -= this.checkpointSizes.get(cursor)!; } };
    for (const cursor of this.checkpoints.keys()) {
      if (deltaBytes + checkpointBytes + reservedMachineBytes <= this.budget) break;
      if (cursor !== 0) remove(cursor);
    }
    const cursor = this.records.length + 1;
    let interval = this.interval;
    // Thin evenly across the entire trace when the count budget is reached.
    // The origin is never evicted; deltas remain available at every cursor.
    if (cursor % interval === 0 && this.checkpoints.size - removals.size >= this.maxCheckpoints) {
      interval *= 2;
      for (const position of this.checkpoints.keys()) if (position % interval !== 0) remove(position);
    }
    const checkpointSize = payload.totalBytes + encodedBytes(cursor) + 4;
    const due = cursor % interval === 0;
    const save = due && deltaBytes + checkpointBytes + checkpointSize + reservedMachineBytes <= this.budget;
    const saved = save ? freezePayload(structuredClone(state)) : null;
    this.records.push(freezePayload(step));
    for (const position of removals) { this.checkpoints.delete(position); this.checkpointSizes.delete(position); }
    if (saved) { this.checkpoints.set(cursor, saved); this.checkpointSizes.set(cursor, checkpointSize); checkpointBytes += checkpointSize; }
    else if (due) this.skippedCheckpoints++;
    this.interval = interval; this.deltaBytes = deltaBytes; this.checkpointBytes = checkpointBytes; this.reservedMachineBytes = reservedMachineBytes;
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
    this.reservedMachineBytes = measureMachine(this.origin).totalBytes;
    this.checkpointSizes = new Map([[0, this.reservedMachineBytes + encodedBytes(0) + 4]]);
    this.deltaBytes = 2; this.checkpointBytes = 2 + this.checkpointSizes.get(0)!; this.skippedCheckpoints = 0;
  }
  /** Encoded payload size, measured on demand; this is not a JS heap estimate. */
  measurePayload(): { deltaBytes: number; checkpointBytes: number } {
    return { deltaBytes: encodedBytes(this.records), checkpointBytes: encodedBytes([...this.checkpoints]) };
  }
  /** Share frozen payloads, detach mutable indexes and future append/clear operations. */
  fork(): CheckpointHistory {
    const copy = new CheckpointHistory(this.origin as MachineState, { checkpointInterval: this.baseInterval, maxCheckpoints: this.maxCheckpoints, maxHistoryBytes: this.budget });
    copy.records = [...this.records]; copy.checkpoints = new Map(this.checkpoints); copy.interval = this.interval;
    copy.checkpointSizes = new Map(this.checkpointSizes); copy.deltaBytes = this.deltaBytes; copy.checkpointBytes = this.checkpointBytes; copy.reservedMachineBytes = this.reservedMachineBytes; copy.skippedCheckpoints = this.skippedCheckpoints;
    return copy;
  }
}

export function freezePayload<T extends object>(value: T): DeepReadonly<T> {
  if (!Object.isFrozen(value)) {
    for (const child of Object.values(value)) if (child !== null && typeof child === 'object') freezePayload(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
