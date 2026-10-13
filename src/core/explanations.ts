import type { Program } from './compiler';
import type { Value } from './language';
import type { Change, DeepReadonly, Frame, Step } from './machine';

export type ExplanationDirection = 'forward' | 'backward';
export type RecordedBinding = DeepReadonly<Extract<Change, { kind: 'binding' }>['before']>;
export interface OperationEvidence { readonly inputs: readonly DeepReadonly<Value>[]; readonly operator: string; readonly result: DeepReadonly<Value> }
export type StepExplanation =
  | { kind: 'operation'; operation: OperationEvidence }
  | { kind: 'read'; name: string; value: DeepReadonly<Value>; frameId: number | null; scope: string }
  | { kind: 'binding'; frameId: number; scope: string; name: string; before: RecordedBinding; after: RecordedBinding }
  | { kind: 'decision'; value: DeepReadonly<Value>; satisfied: boolean; operation: OperationEvidence | null; sourceLine: number | null; destinationLine: number | null }
  | { kind: 'frame'; action: 'enter' | 'leave' | 'restore' | 'remove'; frame: DeepReadonly<Frame>; caller: string; result: RecordedBinding }
  | { kind: 'output'; text: string; action: 'append' | 'remove' }
  | { kind: 'error'; message: string; action: 'raise' | 'clear' }
  | { kind: 'heap'; id: number; index: number; before: readonly Value[]; after: readonly Value[]; action: 'create' | 'delete' | 'append' | 'remove' | 'replace' }
  | { kind: 'item-read'; id: number; index: Value; value: Value }
  | { kind: 'flow'; description: string; sourceLine: number | null; destinationLine: number | null };

function scopeAt(program: Program, pc: number): string {
  const scope = program.locations[pc]?.semanticKey.split('/')[0];
  return scope?.startsWith('function:') ? decodeURIComponent(scope.slice('function:'.length)) : 'programa';
}
function operands(step: DeepReadonly<Step>) {
  return step.changes.filter(change => change.kind === 'operands');
}
function operation(program: Program, step: DeepReadonly<Step>): OperationEvidence | null {
  const instruction = program.instructions[step.index]!;
  if (instruction.op !== 'BINARY' && instruction.op !== 'UNARY') return null;
  const changes = operands(step);
  const inputs = changes.flatMap(change => [...change.removed]);
  const added = changes.flatMap(change => [...change.added]);
  if (!added.length || inputs.length !== (instruction.op === 'BINARY' ? 2 : 1)) return null;
  // The VM pops right before left. Preserve recorded values; do not evaluate math.
  return { inputs: instruction.op === 'BINARY' ? [...inputs].reverse() : inputs, operator: instruction.operator, result: added.at(-1)! };
}
/** Follow operand splices backward to its recorded producer, including stack shifts.
 * This is provenance over deltas, not execution or a search for an equal value. */
export function operandProducer(history: readonly DeepReadonly<Step>[], beforeIndex: number, operandIndex: number): number | null {
  let position = operandIndex;
  for (let index = beforeIndex - 1; index >= 0; index--) {
    const changes = history[index]!.changes;
    for (let c = changes.length - 1; c >= 0; c--) {
      const change = changes[c]!;
      if (change.kind !== 'operands') continue;
      if (position >= change.index && position < change.index + change.added.length) return index;
      if (position >= change.index + change.added.length) position += change.removed.length - change.added.length;
    }
  }
  return null;
}
/** Only binding presence and frame names are reconstructed for a LOAD's origin.
 * No values, operand stack, output or VM snapshots are copied. */
function readScope(program: Program, history: readonly DeepReadonly<Step>[], index: number): { frameId: number | null; scope: string } {
  const instruction = program.instructions[history[index]!.index]!;
  if (instruction.op !== 'LOAD') throw new Error('Origem de leitura inválida');
  const frames = [{ id: 0, name: 'programa', names: new Set<string>() }];
  for (let i = 0; i < index; i++) {
    for (const change of history[i]!.changes) {
      if (change.kind === 'binding') {
        const names = frames.find(frame => frame.id === change.frameId)!.names;
        if (change.after.exists) names.add(change.name); else names.delete(change.name);
      } else if (change.kind === 'frames') {
        frames.splice(change.index, change.removed.length, ...change.added.map(frame => ({ id: frame.id, name: frame.name, names: new Set(Object.keys(frame.locals)) })));
      }
    }
  }
  const local = frames.at(-1)!;
  const origin = instruction.scope !== 'global' && local.names.has(instruction.name) ? local : frames[0]!.names.has(instruction.name) ? frames[0]! : null;
  return origin ? { frameId: origin.id, scope: origin.name } : { frameId: null, scope: 'builtins do Python' };
}

export function explainStep(program: Program, history: readonly DeepReadonly<Step>[], index: number, direction: ExplanationDirection): StepExplanation {
  if (!Number.isSafeInteger(index) || index < 0 || index >= history.length) throw new RangeError('Escolha uma instrução registrada');
  const step = history[index]!, instruction = program.instructions[step.index]!;
  const control = step.changes.find(change => change.kind === 'control')!;
  const forward = direction === 'forward';
  if (control.after.status === 'error') return { kind: 'error', message: control.after.error!, action: forward ? 'raise' : 'clear' };
  const allocation = step.changes.find(change => change.kind === 'heap-allocation');
  if (allocation) return { kind: 'heap', id: allocation.id, index: 0, before: forward ? [] : allocation.object.items, after: forward ? allocation.object.items : [], action: forward ? 'create' : 'delete' };
  const mutation = step.changes.find(change => change.kind === 'heap-splice');
  if (mutation) return { kind: 'heap', id: mutation.id, index: mutation.index, before: forward ? mutation.removed : mutation.added, after: forward ? mutation.added : mutation.removed, action: step.op === 'LIST_APPEND' ? forward ? 'append' : 'remove' : 'replace' };
  if (instruction.op === 'LIST_GET') {
    const changes = operands(step), target = changes[1]!.removed[0]!;
    if (target !== null && typeof target === 'object' && target.kind === 'list') return { kind: 'item-read', id: target.id, index: changes[0]!.removed[0]!, value: changes[2]!.added[0]! };
  }
  const math = operation(program, step);
  if (math) return { kind: 'operation', operation: math };
  const binding = step.changes.find(change => change.kind === 'binding');
  if (binding) return { kind: 'binding', frameId: binding.frameId, scope: binding.frameId === 0 ? 'programa' : scopeAt(program, step.index), name: binding.name, before: forward ? binding.before : binding.after, after: forward ? binding.after : binding.before };
  if (instruction.op === 'LOAD') return { kind: 'read', name: instruction.name, value: operands(step).flatMap(change => [...change.added])[0]!, ...readScope(program, history, index) };
  const from = forward ? control.before : control.after, to = forward ? control.after : control.before;
  const sourceLine = from.status === 'halted' ? null : program.instructions[from.pc]?.span.line ?? null;
  const destinationLine = to.status === 'halted' ? null : program.instructions[to.pc]?.span.line ?? null;
  if (instruction.op === 'JUMP_IF_FALSE') {
    const pop = operands(step).find(change => change.removed.length)!;
    const value = pop.removed[0]!;
    const producer = operandProducer(history, index, pop.index);
    return { kind: 'decision', value, satisfied: control.after.pc !== instruction.target, operation: producer === null ? null : operation(program, history[producer]!), sourceLine, destinationLine };
  }
  const frameChange = step.changes.find(change => change.kind === 'frames');
  if (frameChange) {
    const entering = frameChange.added.length > 0;
    const frame = (entering ? frameChange.added : frameChange.removed)[0]!;
    const values = operands(step).flatMap(change => [...change.added]);
    return { kind: 'frame', action: entering ? forward ? 'enter' : 'remove' : forward ? 'leave' : 'restore', frame, caller: scopeAt(program, entering ? step.index : control.after.pc), result: entering ? { exists: false } : { exists: true, value: values.at(-1)! } };
  }
  const output = step.changes.find(change => change.kind === 'output');
  if (output) return { kind: 'output', text: output.added.join(''), action: forward ? 'append' : 'remove' };
  return { kind: 'flow', description: step.description, sourceLine, destinationLine };
}

export interface BindingSummary {
  readonly frameId: number;
  readonly scope: string;
  readonly name: string;
  readonly before: RecordedBinding;
  readonly after: RecordedBinding;
  readonly writes: number;
}
export interface NavigationSummary {
  readonly direction: ExplanationDirection;
  readonly count: number;
  readonly focus: number;
  readonly bindings: readonly BindingSummary[];
}
/** Aggregate recorded writes in navigation order. This describes the interval,
 * including frames that have since left the stack, not a snapshot of live locals. */
export function summarizeNavigation(program: Program, history: readonly DeepReadonly<Step>[], from: number, to: number): NavigationSummary {
  if (![from, to].every(cursor => Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= history.length) || from === to) throw new RangeError('Escolha um intervalo registrado não vazio');
  const forward = to > from;
  const summaries = new Map<string, BindingSummary>();
  let focus = forward ? to - 1 : to, best = -1;
  const priority = (step: DeepReadonly<Step>) => {
    if (step.changes.some(change => change.kind === 'control' && change.after.status === 'error')) return 100;
    if (step.op === 'RETURN') return 90;
    if (step.op === 'JUMP_IF_FALSE') return 80;
    if (step.changes.some(change => change.kind === 'frames')) return 70;
    if (step.changes.some(change => change.kind === 'heap-splice' || change.kind === 'heap-allocation')) return 75;
    if (step.changes.some(change => change.kind === 'output')) return 65;
    if (step.changes.some(change => change.kind === 'binding')) return 60;
    if (step.op === 'BINARY' || step.op === 'UNARY') return 50;
    if (step.op === 'LOAD') return 40;
    return 0;
  };
  for (let index = forward ? from : from - 1; forward ? index < to : index >= to; index += forward ? 1 : -1) {
    const step = history[index]!;
    const rank = priority(step);
    if (rank >= best) { best = rank; focus = index; }
    for (const change of step.changes) if (change.kind === 'binding') {
      const key = JSON.stringify([change.frameId, change.name]);
      const existing = summaries.get(key);
      const before = forward ? change.before : change.after, after = forward ? change.after : change.before;
      summaries.set(key, { frameId: change.frameId, scope: change.frameId === 0 ? 'programa' : scopeAt(program, step.index), name: change.name, before: existing?.before ?? before, after, writes: (existing?.writes ?? 0) + 1 });
    }
  }
  return { direction: forward ? 'forward' : 'backward', count: Math.abs(to - from), focus, bindings: [...summaries.values()] };
}
