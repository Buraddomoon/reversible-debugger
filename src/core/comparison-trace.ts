import { DebugSession, HistoryLimitError } from './debugger';
import { pythonTruth } from './python-values';
import type { DeepReadonly, MachineState, Step } from './machine';
import type { ComparisonPhase, ComparisonPoint, ComparisonRunView, ComparisonSource, DifferenceValue, RunIdentity } from './comparison-types';
import type { HistoryOptions } from './history';

/** Shared interned call paths avoid comparing raw VM frame IDs or copying stacks per point. */
export class ComparisonContexts {
  private keys = new Map<string, number>();
  intern(parent: number, site: string, slot: number, name: string, occurrence: number): number {
    const key = JSON.stringify([parent, site, slot, name, occurrence]);
    const existing = this.keys.get(key);
    if (existing !== undefined) return existing;
    const id = this.keys.size + 1; this.keys.set(key, id); return id;
  }
}

/** This fingerprint is a display label; exact source/runtime/initial state remain in identity. */
function fingerprint(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `run-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
function freezeInitial(initial: MachineState): DeepReadonly<MachineState> {
  const freeze = (value: object) => {
    for (const child of Object.values(value)) if (child !== null && typeof child === 'object') freeze(child);
    Object.freeze(value);
  };
  freeze(initial); return initial;
}

export class RecordedComparisonRun implements ComparisonRunView {
  readonly name: string;
  readonly identity: RunIdentity;
  private readonly session: DebugSession;
  private recordedPoints: ComparisonPoint[] = [];
  private activeFrames = [0];
  private frameContexts = new Map<number, number>([[0, 0]]);
  private frameNames = new Map<number, string>([[0, 'programa']]);
  private counters = new Map<string, number>();
  private slots: number[];
  private complete = false;
  private limited = false;
  private resultAtEnd: DifferenceValue = { present: false };

  constructor(input: ComparisonSource, private readonly contexts: ComparisonContexts, options: HistoryOptions & { maxSteps?: number; maxFrames?: number }) {
    this.name = input.name;
    if (input.recording && (input.source !== input.recording.program.source || input.language !== input.recording.runtime.language || input.version !== input.recording.runtime.version)) throw new Error('Identidade do histórico não corresponde ao programa selecionado');
    this.session = input.recording ? input.recording.forkRecording(0) : new DebugSession(input.source, { ...options, language: input.language, version: input.version });
    const initial = freezeInitial(structuredClone(this.session.state) as MachineState);
    this.identity = Object.freeze({ source: input.source, runtime: this.session.runtime, initial, fingerprint: fingerprint(JSON.stringify([input.source, this.session.runtime, initial])) });
    const counts = new Map<string, number>();
    this.slots = this.program.instructions.map((instruction, pc) => {
      const key = JSON.stringify([this.program.locations[pc]?.semanticKey, this.program.locations[pc]?.flowDecision ? 'flowDecision' : instruction.op]);
      const slot = counts.get(key) ?? 0; counts.set(key, slot + 1); return slot;
    });
    this.recordedPoints.push(Object.freeze({ key: 'initial', cursor: 0, phase: 'initial', line: null, occurrence: 1, description: 'Estado inicial', outcome: null }));
  }
  get program() { return this.session.program; }
  get state() { return this.session.state; }
  get cursor() { return this.session.cursor; }
  get history() { return this.session.history; }
  get points(): readonly ComparisonPoint[] { return this.recordedPoints; }
  get limitReached() { return this.limited; }
  get done() { return this.complete; }
  get finalResult(): DifferenceValue { return this.resultAtEnd; }
  contextForFrame(id: number): number { return this.frameContexts.get(id)!; }
  frameLabel(id: number): string { return this.frameNames.get(id)!; }
  seek(cursor: number): void { this.session.seek(cursor); }
  private finish(): void {
    this.complete = true;
    const globals = this.state.frames[0]!.locals;
    this.resultAtEnd = Object.freeze(Object.hasOwn(globals, 'result') ? { present: true, value: globals.result! } : { present: false });
    Object.freeze(this.recordedPoints);
  }
  private occurrence(key: string): number {
    const count = (this.counters.get(key) ?? 0) + 1; this.counters.set(key, count); return count;
  }
  advance(): void {
    if (this.complete) return;
    if (!this.session.canForward) { this.finishRecording(); return; }
    let step: DeepReadonly<Step>;
    try { step = this.session.forward()!; }
    catch (error) {
      if (!(error instanceof HistoryLimitError)) throw error;
      this.limited = true;
      this.recordedPoints.push(Object.freeze({ key: 'terminal', cursor: this.cursor, phase: 'limit', line: null, occurrence: 1, description: error.message, outcome: null }));
      this.finish();
      return;
    }
    const location = this.program.locations[step.index];
    const site = location?.semanticKey ?? 'terminal';
    const context = this.contextForFrame(this.activeFrames.at(-1)!);
    const slot = this.slots[step.index]!;
    let phase: ComparisonPhase | null = null;
    let outcome: boolean | null = null;
    const frameChange = step.changes.find(change => change.kind === 'frames');
    if (frameChange?.kind === 'frames') {
      for (const frame of frameChange.added) {
        const callKey = JSON.stringify([context, site, slot, frame.name, 'invocation']);
        const invocation = this.occurrence(callKey);
        this.frameContexts.set(frame.id, this.contexts.intern(context, site, slot, frame.name, invocation));
        this.frameNames.set(frame.id, `${frame.name}() · nível ${this.activeFrames.length} · chamada ${invocation}`);
        this.activeFrames.push(frame.id);
      }
      if (frameChange.removed.length) this.activeFrames.splice(this.activeFrames.length - frameChange.removed.length);
      phase = frameChange.added.length ? 'call' : 'return';
    }
    if (this.state.control.status === 'error') phase = 'error';
    else if (step.op === 'HALT') phase = 'end';
    else if (location?.flowDecision) {
      phase = 'decision';
      const operands = step.changes.find(change => change.kind === 'operands' && change.removed.length);
      if (operands?.kind === 'operands') outcome = this.program.runtime.language === 'python' ? pythonTruth(operands.removed[0]!) : Boolean(operands.removed[0]);
    } else if (step.changes.some(change => change.kind === 'binding')) phase = 'write';
    else if (step.changes.some(change => change.kind === 'output')) phase = 'output';
    if (phase) {
      const terminal = phase === 'error' || phase === 'end';
      const base = JSON.stringify([context, site, phase, slot]);
      const occurrence = terminal ? 1 : this.occurrence(base);
      this.recordedPoints.push(Object.freeze({ key: terminal ? 'terminal' : `${base}#${occurrence}`, cursor: this.cursor, phase, line: phase === 'error' ? step.span.line : location?.span.line ?? step.span.line, occurrence, description: step.description, outcome }));
    }
    if (!this.session.canForward) this.finishRecording();
  }
  private finishRecording(): void {
    if (this.state.control.status === 'running') {
      this.limited = this.history.length >= this.session.maxSteps;
      this.recordedPoints.push(Object.freeze({ key: 'terminal', cursor: this.cursor, phase: this.limited ? 'limit' : 'pause', line: null, occurrence: 1, description: this.limited ? 'Limite da gravação registrado' : 'Fim do histórico parcial; o programa não foi concluído', outcome: null }));
    }
    this.finish();
  }
}
