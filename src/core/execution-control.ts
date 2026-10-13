import type { DebugSession } from './debugger';
import type { DeepReadonly, Step } from './machine';

export type RunMode = 'continue' | 'reverse-continue' | 'into' | 'over' | 'out' | 'back-statement';
export interface DebugStop {
  readonly reason: 'breakpoint' | 'step' | 'start' | 'halted' | 'error' | 'recorded-end';
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

/** Debug policy lives outside the VM: it only chooses when to stop applying deltas. */
export class ExecutionControl {
  private readonly points = new Set<number>();
  private readonly eligible: ReadonlySet<number>;
  private plan: Plan | null = null;
  private stopped: DebugStop | null = null;
  breakpointsEnabled = true;

  constructor(readonly session: DebugSession) { this.eligible = new Set(session.program.breakableLines); }
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
  start(mode: RunMode): void {
    if (mode === 'out' && !this.canStepOut) throw new Error('Não há função ativa da qual sair');
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
  runBatch(size = 100): RunResult {
    if (!Number.isInteger(size) || size < 1 || size > 1000) throw new Error('O lote deve ter entre 1 e 1.000 passos');
    const plan = this.plan;
    const direction = plan?.mode === 'reverse-continue' || plan?.mode === 'back-statement' ? 'backward' : 'forward';
    let moved = 0;
    let lastStep: DeepReadonly<Step> | null = null;
    if (plan) {
      try {
        while (moved < size && this.plan) {
          if (direction === 'forward') {
            if (!this.session.canForward) { this.finish(this.session.state.control.status === 'running' ? 'recorded-end' : this.session.state.control.status, plan); break; }
            const point = this.breakpointLine();
            if (point !== null && !(plan.skipOrigin && this.session.cursor === plan.origin)) { this.finish('breakpoint', plan, point); break; }
            lastStep = this.session.forward(); moved++;
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
            lastStep = this.session.backward(); moved++;
            const hit = this.breakpointLine();
            if (plan.mode === 'reverse-continue' && hit !== null) { this.finish('breakpoint', plan, hit); break; }
            if (plan.mode === 'back-statement' && this.location?.entry) { this.finish('step', plan); break; }
            if (!this.session.canBackward) { this.finish('start', plan); break; }
          }
        }
      } catch (error) {
        // History/resource errors still leave the VM at its last valid transaction.
        this.plan = null;
        throw error;
      }
    }
    return { moved, origin: plan?.origin ?? this.session.cursor, direction, lastStep, stop: this.stopped };
  }
}
