import { encodedBytes } from './storage-accounting';
import type { Program } from './compiler';
import { DebugSession, HistoryBudgetError, HistoryLimitError } from './debugger';
import { initialState, type DeepReadonly, type MachineState, type Step } from './machine';
import type { ComparisonPhase, ComparisonPoint, ComparisonRunView, ComparisonSource, DifferenceValue, RunIdentity } from './comparison-types';
import type { HistoryOptions } from './history';

/** Shared interned call paths avoid comparing raw VM frame IDs or copying stacks per point. */
export class ComparisonContexts {
  private keys = new Map<string, number>();
  metadataBytes = 2;
  intern(parent: number, site: string, slot: number, name: string, occurrence: number): number {
    const key = JSON.stringify([parent, site, slot, name, occurrence]);
    const existing = this.keys.get(key);
    if (existing !== undefined) return existing;
    const id = this.keys.size + 1; this.keys.set(key, id); this.metadataBytes += encodedBytes(key) + 32; return id;
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

export class ComparisonProjection {
  private bytes = 256;
  get metadataBytes() { return this.bytes + this.contexts.metadataBytes; }
  readonly identity: RunIdentity;
  readonly recordedPoints: ComparisonPoint[] = [];
  private activeFrames = [0];
  private frameContexts = new Map<number, number>([[0, 0]]);
  private frameNames = new Map<number, string>([[0, 'programa']]);
  private counters = new Map<string, number>();
  private slots: number[];
  resultAtEnd: DifferenceValue = { present: false };
  constructor(readonly name: string, readonly program: Program, private readonly contexts: ComparisonContexts) {
    const initial = freezeInitial(initialState());
    this.identity = Object.freeze({ source: program.source, runtime: program.runtime, initial, fingerprint: fingerprint(JSON.stringify([program.source, program.runtime, initial])) });
    const counts = new Map<string, number>();
    this.slots = program.instructions.map((instruction, pc) => {
      const key = JSON.stringify([program.locations[pc]?.semanticKey, program.locations[pc]?.flowDecision ? 'flowDecision' : instruction.op]);
      const slot = counts.get(key) ?? 0; counts.set(key, slot + 1); return slot;
    });
    this.bytes += encodedBytes(this.slots);
    this.pushPoint(Object.freeze({ key: 'initial', cursor: 0, phase: 'initial', line: null, occurrence: 1, description: 'Estado inicial', outcome: null }));
  }
  contextForFrame(id: number): number { return this.frameContexts.get(id)!; }
  frameLabel(id: number): string { return this.frameNames.get(id)!; }
  private pushPoint(point: ComparisonPoint): void { this.bytes += encodedBytes(point) + 1; this.recordedPoints.push(point); }
  private occurrence(key: string): number { if (!this.counters.has(key)) this.bytes += encodedBytes(key) + 32; const count = (this.counters.get(key) ?? 0) + 1; this.counters.set(key, count); return count; }
  append(step: DeepReadonly<Step>, state: DeepReadonly<MachineState>, cursor: number): void {
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
        this.bytes += encodedBytes(frame.name) + 128;
        this.frameNames.set(frame.id, `${frame.name}() · nível ${this.activeFrames.length} · chamada ${invocation}`);
        this.activeFrames.push(frame.id);
      }
      if (frameChange.removed.length) this.activeFrames.splice(this.activeFrames.length - frameChange.removed.length);
      phase = frameChange.added.length ? 'call' : 'return';
    }
    if (state.control.status === 'error') phase = 'error';
    else if (step.op === 'HALT') phase = 'end';
    else if (location?.flowDecision) {
      phase = 'decision';
      const operands = step.changes.find(change => change.kind === 'operands' && change.removed.length);
      const instruction = this.program.instructions[step.index]!;
      if (operands?.kind === 'operands' && instruction.op === 'JUMP_IF_FALSE') outcome = state.control.pc !== instruction.target;
    } else if (step.changes.some(change => change.kind === 'binding')) phase = 'write';
    else if (step.changes.some(change => change.kind === 'output')) phase = 'output';
    else if (step.changes.some(change => change.kind === 'heap-splice' || change.kind === 'heap-allocation')) phase = 'mutation';
    if (phase) {
      const terminal = phase === 'error' || phase === 'end';
      const base = JSON.stringify([context, site, phase, slot]);
      const occurrence = terminal ? 1 : this.occurrence(base);
      this.pushPoint(Object.freeze({ key: terminal ? 'terminal' : `${base}#${occurrence}`, cursor: cursor, phase, line: phase === 'error' ? step.span.line : location?.span.line ?? step.span.line, occurrence, description: step.description, outcome }));
    }
  }
  finish(state: DeepReadonly<MachineState>, cursor: number, limited: boolean, reason?: string): void {
    if (state.control.status === 'running') this.pushPoint(Object.freeze({ key: 'terminal', cursor, phase: limited ? 'limit' : 'pause', line: null, occurrence: 1, description: reason ?? (limited ? 'Limite da gravação registrado' : 'Fim do histórico parcial; o programa não foi concluído'), outcome: null }));
    const globals = state.frames[0]!.locals;
    this.resultAtEnd = Object.freeze(Object.hasOwn(globals, 'result') ? { present: true, value: globals.result! } : { present: false });
    Object.freeze(this.recordedPoints);
  }
}

export class RecordedComparisonRun implements ComparisonRunView {
  private session: DebugSession;
  readonly projection: ComparisonProjection;
  private complete = false;
  private limited = false;
  constructor(input: ComparisonSource, contexts: ComparisonContexts, options: HistoryOptions & { maxSteps?: number; maxFrames?: number }) {
    if (input.recording && (input.source !== input.recording.program.source || input.language !== input.recording.runtime.language || input.version !== input.recording.runtime.version)) throw new Error('Identidade do histórico não corresponde ao programa selecionado');
    this.session = input.recording ? input.recording.forkRecording(0) : new DebugSession(input.source, { ...options, language: input.language, version: input.version });
    if (input.recording && options.maxHistoryBytes !== undefined) this.session.setHistoryBudget(options.maxHistoryBytes);
    this.projection = new ComparisonProjection(input.name, this.session.program, contexts);
  }
  get name() { return this.projection.name; }
  get identity() { return this.projection.identity; }
  get program() { return this.session.program; }
  get state() { return this.session.state; }
  get cursor() { return this.session.cursor; }
  get history() { return this.session.history; }
  get points(): readonly ComparisonPoint[] { return this.projection.recordedPoints; }
  get limitReached() { return this.limited; }
  get done() { return this.complete; }
  get finalResult() { return this.projection.resultAtEnd; }
  contextForFrame(id: number) { return this.projection.contextForFrame(id); }
  frameLabel(id: number) { return this.projection.frameLabel(id); }
  seek(cursor: number): void { this.session.seek(cursor); }
  forkForSeek(cursor: number): DebugSession { return this.session.forkForSeek(cursor); }
  publishNavigation(session: DebugSession): void { this.session = session; }
  advance(): void {
    if (this.complete) return;
    if (!this.session.canForward) { this.finishRecording(); return; }
    let step: DeepReadonly<Step>;
    try { step = this.session.forward()!; }
    catch (error) {
      if (!(error instanceof HistoryLimitError) && !(error instanceof HistoryBudgetError)) throw error;
      this.limited = true; this.projection.finish(this.state, this.cursor, true, error.message); this.complete = true; return;
    }
    this.projection.append(step, this.state, this.cursor);
    if (!this.session.canForward) this.finishRecording();
  }
  private finishRecording(): void {
    this.limited = this.state.control.status === 'running' && (this.session.recordingStop !== null || this.history.length >= this.session.maxSteps);
    this.projection.finish(this.state, this.cursor, this.limited, this.session.recordingStop ? 'Gravação pausada pelo orçamento do histórico' : undefined); this.complete = true;
  }
}
