import { compile, type Program } from './compiler';
import { getRuntime, type RuntimeSelection } from './runtime';
import { applyStep, executeInstruction, initialState, type DeepReadonly, type MachineState, type Step } from './machine';

export class HistoryLimitError extends Error {
  constructor(limit: number) {
    super(`Limite de ${limit.toLocaleString('pt-BR')} passos registrados atingido. Reinicie ou reduza o programa.`);
    this.name = 'HistoryLimitError';
  }
}

/** One immutable program, one mutable VM, immutable deltas, and a navigation cursor. */
export class DebugSession {
  readonly program: Program;
  private machine = initialState();
  private steps: Step[] = [];
  private position = 0;
  readonly maxSteps: number;
  readonly maxFrames: number;
  readonly runtime: RuntimeSelection;

  constructor(source: string, options: { maxSteps?: number; maxFrames?: number; language?: string; version?: string } = {}) {
    this.runtime = getRuntime(options.language ?? 'rewind', options.version);
    this.program = compile(source, this.runtime);
    this.maxSteps = options.maxSteps ?? 20_000;
    this.maxFrames = options.maxFrames ?? 256;
    if (!Number.isInteger(this.maxSteps) || this.maxSteps < 1) throw new Error('maxSteps precisa ser um inteiro positivo');
    if (!Number.isInteger(this.maxFrames) || this.maxFrames < 2) throw new Error('maxFrames precisa ser um inteiro maior que um');
  }
  get state(): DeepReadonly<MachineState> { return this.machine; }
  get history(): readonly DeepReadonly<Step>[] { return this.steps; }
  get cursor(): number { return this.position; }
  get canBackward(): boolean { return this.position > 0; }
  get canForward(): boolean { return this.position < this.steps.length || this.machine.control.status === 'running'; }
  get lastStep(): DeepReadonly<Step> | null { return this.steps[this.position - 1] ?? null; }

  forward(): DeepReadonly<Step> | null {
    if (!this.canForward) return null;
    let step = this.steps[this.position];
    if (step) applyStep(this.machine, step, 'forward');
    else {
      if (this.steps.length >= this.maxSteps) throw new HistoryLimitError(this.maxSteps);
      step = executeInstruction(this.machine, this.program, this.maxFrames);
      // Only changed values are retained. Never store a full VM snapshot per instruction.
      freezePayload(step);
      this.steps.push(step);
    }
    this.position++;
    return step;
  }
  backward(): DeepReadonly<Step> | null {
    if (!this.canBackward) return null;
    const step = this.steps[this.position - 1]!;
    applyStep(this.machine, step, 'backward');
    this.position--;
    return step;
  }
  /** Bounded batches let callers yield between chunks, including infinite loops. */
  runBatch(size = 100): number {
    if (!Number.isInteger(size) || size < 1 || size > 1000) throw new Error('O lote deve ter entre 1 e 1.000 passos');
    let count = 0;
    while (count < size && this.canForward) { this.forward(); count++; }
    return count;
  }
  /** Reset is navigation: preserve recorded history for exact forward replay. */
  backwardBatch(size = 100): number {
    if (!Number.isInteger(size) || size < 1 || size > 1000) throw new Error('O lote deve ter entre 1 e 1.000 passos');
    let count = 0;
    while (count < size && this.canBackward) { this.backward(); count++; }
    return count;
  }
  rewind(): void { while (this.canBackward) this.backward(); }
}

function freezePayload(value: object): void {
  if (Object.isFrozen(value)) return;
  for (const child of Object.values(value)) if (child !== null && typeof child === 'object') freezePayload(child);
  Object.freeze(value);
}
