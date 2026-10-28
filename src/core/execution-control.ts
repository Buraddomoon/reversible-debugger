import { HistoryBudgetError, type DebugSession } from './debugger';
import type { DeepReadonly, MachineState, Step } from './machine';
import type { Program } from './compiler';

export type RunMode = 'continue' | 'reverse-continue' | 'into' | 'over' | 'out' | 'back-statement';
export interface DebugStop {
  readonly reason: 'breakpoint' | 'step' | 'start' | 'halted' | 'error' | 'recorded-end' | 'budget';
  readonly cursor: number;
  readonly mode: RunMode;
  readonly line: number | null;
}
interface Plan { mode: RunMode; origin: number; frameId: number; skipOrigin: boolean }
export interface RunResult {
  readonly moved: number;
  readonly origin: number;
  readonly direction: 'forward' | 'backward';
  readonly lastStep: DeepReadonly<Step> | null;
  readonly stop: DebugStop | null;
}

export interface ExecutionView {
  readonly program: Program;
  readonly state: DeepReadonly<MachineState>;
  readonly cursor: number;
  readonly canForward: boolean;
  readonly canBackward: boolean;
  readonly recordingStop: unknown;
  readonly stepLimitReached?: boolean;
}

/** Debug policy lives outside the VM: it only chooses when to stop applying deltas. */
export class ExecutionPolicy {
  private readonly points = new Set<number>();
  private readonly eligible: ReadonlySet<number>;
  private plan: Plan | null = null;
  private stopped: DebugStop | null = null;
  breakpointsEnabled = true;

  constructor(readonly session: ExecutionView) { this.eligible = new Set(session.program.breakableLines); }
  get breakpoints(): readonly number[] { return [...this.points].sort((a, b) => a - b); }
  get stop(): DebugStop | null { return this.stopped; }
  get mode(): RunMode | null { return this.plan?.mode ?? null; }
  get running(): boolean { return this.plan !== null; }
  get location() { return this.session.program.locations[this.session.state.control.pc] ?? null; }
  get canStepOut(): boolean { return this.session.canForward && this.session.state.frames.length > 1; }
  toggleBreakpoint(line: number): void {
    if (!this.eligible.has(line)) throw new Error('Essa linha não inicia um comando executável');
    if (this.points.has(line)) this.points.delete(line); else this.points.add(line);
  }
  clearBreakpoints(): void { this.points.clear(); }
  /** Cancel before external navigation (seek/manual steps/restart) to invalidate a pause. */
  cancel(): void { this.plan = null; this.stopped = null; }
  pause(): void { this.plan = null; }
  validateConfiguration(lines: readonly number[], enabled: boolean): void {
    if (typeof enabled !== 'boolean' || !Array.isArray(lines) || lines.length > this.eligible.size || lines.some(line => !this.eligible.has(line))) throw new Error('Configuração de breakpoints inválida');
  }
  configure(lines: readonly number[], enabled: boolean): void {
    this.validateConfiguration(lines, enabled); this.pause(); this.points.clear(); for (const line of lines) this.points.add(line); this.breakpointsEnabled = enabled;
  }
  validateMode(mode: RunMode): void {
    if (!['continue', 'reverse-continue', 'into', 'over', 'out', 'back-statement'].includes(mode)) throw new Error('Modo de execução inválido');
    if (mode === 'out' && !this.canStepOut) throw new Error('Não há função ativa da qual sair');
  }
  start(mode: RunMode): void {
    this.validateMode(mode);
    const resume = this.stopped?.reason === 'breakpoint' && this.stopped.cursor === this.session.cursor;
    this.plan = { mode, origin: this.session.cursor, frameId: this.session.state.frames.at(-1)!.id, skipOrigin: mode !== 'continue' || resume };
    this.stopped = null;
  }
  private breakpointLine(): number | null {
    const location = this.location;
    return this.breakpointsEnabled && location?.entry && location.kind === 'statement' && this.points.has(location.span.line) ? location.span.line : null;
  }
  private finish(reason: DebugStop['reason'], plan: Plan, line: number | null = null): void {
    this.stopped = { reason, mode: plan.mode, cursor: this.session.cursor, line };
    this.plan = null;
  }
  *batch(size = 100): Generator<'forward' | 'backward', RunResult, DeepReadonly<Step> | null> {
    if (!Number.isInteger(size) || size < 1 || size > 1000) throw new Error('O lote deve ter entre 1 e 1.000 passos');
    const plan = this.plan;
    const direction = plan?.mode === 'reverse-continue' || plan?.mode === 'back-statement' ? 'backward' : 'forward';
    let moved = 0;
    let lastStep: DeepReadonly<Step> | null = null;
    if (plan) {
      try {
        while (moved < size && this.plan) {
          if (direction === 'forward') {
            if (this.session.stepLimitReached) { this.finish('budget', plan); break; }
            if (!this.session.canForward) { this.finish(this.session.recordingStop ? 'budget' : this.session.state.control.status === 'running' ? 'recorded-end' : this.session.state.control.status, plan); break; }
            const point = this.breakpointLine();
            if (point !== null && !(plan.skipOrigin && this.session.cursor === plan.origin)) { this.finish('breakpoint', plan, point); break; }
            lastStep = yield 'forward'; moved++;
            const hit = this.breakpointLine();
            if (this.session.state.control.status !== 'running') { this.finish(this.session.state.control.status, plan); break; }
            if (hit !== null) { this.finish('breakpoint', plan, hit); break; }
            const frameId = this.session.state.frames.at(-1)!.id;
            const originalFrameExists = this.session.state.frames.some(frame => frame.id === plan.frameId);
            const entry = this.location?.entry === true;
            if ((plan.mode === 'into' && (entry || frameId !== plan.frameId))
              || (plan.mode === 'over' && (!originalFrameExists || (entry && frameId === plan.frameId)))
              || (plan.mode === 'out' && !originalFrameExists)) { this.finish('step', plan); break; }
          } else {
            if (!this.session.canBackward) { this.finish('start', plan); break; }
            lastStep = yield 'backward'; moved++;
            const hit = this.breakpointLine();
            if (plan.mode === 'reverse-continue' && hit !== null) { this.finish('breakpoint', plan, hit); break; }
            if (plan.mode === 'back-statement' && this.location?.entry) { this.finish('step', plan); break; }
            if (!this.session.canBackward) { this.finish('start', plan); break; }
          }
        }
      } catch (error) {
        // History/resource errors still leave the VM at its last valid transaction.
        if (error instanceof HistoryBudgetError) this.finish('budget', plan);
        else { this.plan = null; throw error; }
      }
    }
    return { moved, origin: plan?.origin ?? this.session.cursor, direction, lastStep, stop: this.stopped };
  }
}

/** Synchronous driver and paged driver consume exactly the same stop policy. */
export class ExecutionControl extends ExecutionPolicy {
  constructor(override readonly session: DebugSession) { super(session); }
  runBatch(size = 100): RunResult {
    const batch = this.batch(size); let next = batch.next();
    while (!next.done) {
      let step: DeepReadonly<Step> | null;
      try { step = next.value === 'forward' ? this.session.forward() : this.session.backward(); }
      catch (cause) { next = batch.throw(cause); continue; }
      next = batch.next(step);
    }
    return next.value;
  }
}
