import { MAX_EXECUTION_STEPS } from './execution-limits';
import type { Program } from './compiler';
import { applyChange, applyStep, type Change, type Control, type Frame, type MachineState, type Step, type DeepReadonly } from './machine';
import { pythonBuiltins, pythonTruth } from './python-values';
import type { Value } from './language';
import { getList, isList, listIndex, MAX_HEAP_ITEMS, MAX_HEAP_OBJECTS } from './heap';

export function requireTrace(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Histórico inválido: ${message}`);
}
export function object(value: unknown): Record<string, unknown> {
  requireTrace(value !== null && typeof value === 'object' && !Array.isArray(value), 'objeto esperado');
  return value as Record<string, unknown>;
}
export function fields(value: unknown, expected: readonly string[]): Record<string, unknown> {
  const item = object(value), keys = Object.keys(item);
  requireTrace(keys.length === expected.length && expected.every(key => Object.hasOwn(item, key)), 'campos ausentes ou desconhecidos');
  return item;
}
export function integer(value: unknown, min: number, max: number): asserts value is number {
  requireTrace(typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max, 'inteiro fora dos limites');
}
export function text(value: unknown, max = 32 * 1024 * 1024): asserts value is string {
  requireTrace(typeof value === 'string' && value.length <= max, 'texto fora dos limites');
}
function list(value: unknown): asserts value is unknown[] { requireTrace(Array.isArray(value), 'lista esperada'); }
function name(value: unknown): asserts value is string { text(value, 1_000_000); requireTrace(/^[A-Za-z_]\w*$/.test(value), 'nome de variável inválido'); }
export function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every(key => Object.hasOwn(right, key) && same((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
function value(item: unknown, program: Program): asserts item is Value {
  if (typeof item === 'boolean' || typeof item === 'number') return;
  requireTrace(program.runtime.language === 'python', 'tipo incompatível com o runtime');
  if (item === null) return;
  if (typeof item === 'bigint') { requireTrace((item < 0n ? -item : item).toString(2).length <= 100_000, 'inteiro excede 100.000 bits'); return; }
  const ref = object(item);
  if (ref.kind === 'list') { fields(ref, ['kind', 'id']); integer(ref.id, 1, MAX_HEAP_OBJECTS); return; }
  fields(ref, ['kind', 'name']); name(ref.name);
  requireTrace(ref.kind === 'function' ? Object.hasOwn(program.functions, ref.name) : ref.kind === 'builtin' && pythonBuiltins.has(ref.name), 'referência de função desconhecida');
}
function control(item: unknown, program: Program): asserts item is Control {
  const c = fields(item, ['pc', 'status', 'error', 'nextFrameId', 'nextObjectId', 'heapItems']);
  integer(c.pc, 0, program.instructions.length); integer(c.nextFrameId, 1, MAX_EXECUTION_STEPS + 1);
  integer(c.nextObjectId, 1, MAX_HEAP_OBJECTS + 1); integer(c.heapItems, 0, MAX_HEAP_ITEMS);
  requireTrace(typeof c.status === 'string' && ['running', 'halted', 'error'].includes(c.status), 'status desconhecido');
  if (c.status === 'error') text(c.error); else requireTrace(c.error === null, 'erro incompatível com status');
}
function frame(item: unknown, program: Program): asserts item is Frame {
  const f = fields(item, ['id', 'name', 'locals', 'returnPc', 'operandBase']);
  integer(f.id, 0, MAX_EXECUTION_STEPS); text(f.name); integer(f.operandBase, 0, 20_000);
  requireTrace(f.id === 0 ? f.name === 'programa' && f.returnPc === null && f.operandBase === 0 : typeof f.name === 'string' && Object.hasOwn(program.functions, f.name), 'frame desconhecido');
  if (f.id !== 0) integer(f.returnPc, 0, program.instructions.length - 1);
  for (const [key, local] of Object.entries(object(f.locals))) { name(key); value(local, program); }
}
function binding(item: unknown, program: Program) {
  const b = object(item);
  requireTrace(typeof b.exists === 'boolean', 'presença de binding inválida');
  fields(b, b.exists ? ['exists', 'value'] : ['exists']);
  if (b.exists) value(b.value, program);
}
function change(item: unknown, program: Program): asserts item is Change {
  const c = object(item);
  switch (c.kind) {
    case 'control': fields(c, ['kind', 'before', 'after']); control(c.before, program); control(c.after, program); break;
    case 'binding': fields(c, ['kind', 'frameId', 'name', 'before', 'after']); integer(c.frameId, 0, MAX_EXECUTION_STEPS); name(c.name); binding(c.before, program); binding(c.after, program); break;
    case 'heap-allocation': {
      requireTrace(program.runtime.language === 'python', 'heap incompatível com runtime');
      fields(c, ['kind', 'id', 'object']); integer(c.id, 1, MAX_HEAP_OBJECTS);
      const o = fields(c.object, ['kind', 'items']); requireTrace(o.kind === 'list', 'objeto desconhecido'); list(o.items);
      requireTrace(o.items.length <= MAX_HEAP_ITEMS, 'lista excede os limites'); for (const item of o.items) value(item, program); break;
    }
    case 'heap-splice': {
      requireTrace(program.runtime.language === 'python', 'heap incompatível com runtime');
      fields(c, ['kind', 'id', 'index', 'removed', 'added']); integer(c.id, 1, MAX_HEAP_OBJECTS); integer(c.index, 0, MAX_HEAP_ITEMS);
      list(c.removed); list(c.added); requireTrace(c.removed.length <= 1 && c.added.length === 1, 'mutação de lista inválida');
      for (const item of [...c.removed, ...c.added]) value(item, program); break;
    }
    case 'operands': case 'output': case 'frames': {
      fields(c, ['kind', 'index', 'removed', 'added']); integer(c.index, 0, 20_000); list(c.removed); list(c.added);
      requireTrace(c.removed.length + c.added.length <= 20_000, 'splice excede os limites');
      for (const element of [...c.removed, ...c.added]) {
        if (c.kind === 'frames') frame(element, program);
        else if (c.kind === 'output') text(element);
        else value(element, program);
      }
      break;
    }
    default: throw new Error('Histórico inválido: tipo de delta desconhecido');
  }
}

/** Validate schema, exact splice/binding preconditions and control flow while
 * replaying into a private staging VM. Never evaluates program expressions.
 * Integrity/compatibility is checked separately by the portable envelope. */
/** Check a persisted checkpoint's shape, IDs, counters and all heap references. */
export function validateMachineState(input: unknown, program: Program, maxFrames: number): asserts input is MachineState {
  const s = fields(input, ['control', 'frames', 'operands', 'output', 'heap']); control(s.control, program); list(s.frames); list(s.operands); list(s.output); const heap = object(s.heap);
  requireTrace(s.frames.length >= 1 && s.frames.length <= maxFrames && s.operands.length <= 20_000 && s.output.length <= 20_000, 'checkpoint excede os limites');
  const c = s.control as Control;
  const reference = (v: unknown) => { value(v, program); if (v !== null && typeof v === 'object' && 'kind' in v && v.kind === 'list') requireTrace(Object.hasOwn(heap, (v as { id: number }).id), 'referência de checkpoint ausente'); };
  const ids = new Set<number>();
  for (const [index, raw] of s.frames.entries()) { frame(raw, program); const f = raw as Frame; requireTrace(!ids.has(f.id) && f.id < c.nextFrameId && f.operandBase <= s.operands.length && (index !== 0 || f.id === 0), 'frames do checkpoint inconsistentes'); ids.add(f.id); Object.values(f.locals).forEach(reference); }
  s.operands.forEach(reference); for (const line of s.output) text(line, 100_000);
  let items = 0;
  for (const [key, raw] of Object.entries(heap)) { const id = Number(key); integer(id, 1, c.nextObjectId - 1); requireTrace(String(id) === key, 'ID de checkpoint inválido'); const list = fields(raw, ['kind', 'items']); requireTrace(list.kind === 'list' && Array.isArray(list.items), 'objeto de checkpoint inválido'); items += list.items.length; list.items.forEach(reference); }
  requireTrace(Object.keys(heap).length === c.nextObjectId - 1 && items === c.heapItems, 'contadores de checkpoint inconsistentes');
}
/** Reverse a validated delta against its actual posterior values. Operates on a
 * private staging VM; callers publish only after this completes successfully. */
export function restoreValidatedReverse(state: MachineState, program: Program, step: DeepReadonly<Step>, maxFrames: number): void {
  for (const c of [...step.changes].reverse()) {
    if (c.kind === 'control') requireTrace(same(state.control, c.after), 'controle posterior inconsistente');
    else if (c.kind === 'binding') { const f = state.frames.find(f => f.id === c.frameId); requireTrace(f && same(Object.hasOwn(f.locals, c.name) ? { exists: true, value: f.locals[c.name] } : { exists: false }, c.after), 'binding posterior inconsistente'); }
    else if (c.kind === 'heap-allocation') requireTrace(same(state.heap[c.id], c.object), 'alocação posterior inconsistente');
    else if (c.kind === 'heap-splice') requireTrace(state.heap[c.id] && same(state.heap[c.id]!.items.slice(c.index, c.index + c.added.length), c.added), 'heap posterior inconsistente');
    else { const list = c.kind === 'frames' ? state.frames : c.kind === 'output' ? state.output : state.operands; requireTrace(same(list.slice(c.index, c.index + c.added.length), c.added), 'splice posterior inconsistente'); }
    applyChange(state, c as Change, 'backward');
  }
  restoreValidatedStep(state, program, step, maxFrames); applyStep(state, step, 'backward');
}

export function restoreValidatedStep(state: MachineState, program: Program, input: unknown, maxFrames: number): Step {
  const item = fields(input, ['index', 'op', 'span', 'description', 'changes']);
  integer(item.index, 0, program.instructions.length - 1); text(item.description); list(item.changes);
  const instruction = program.instructions[item.index]!;
  requireTrace(state.control.status === 'running' && item.index === state.control.pc, 'cadeia de instruções interrompida');
  requireTrace(item.op === instruction.op && same(item.span, instruction.span), 'instrução/origem difere do programa compilado');
  requireTrace(item.changes.length > 0 && item.changes.length <= 20_001, 'quantidade de deltas inválida');
  for (const c of item.changes) change(c, program);
  const step = item as unknown as Step;
  const controls = step.changes.filter(c => c.kind === 'control');
  const last = step.changes.at(-1)!;
  requireTrace(controls.length === 1 && last.kind === 'control' && same(last.before, state.control), 'controle anterior inconsistente');
  const after = last.after, before = state.control;
  if (after.status === 'error') {
    requireTrace(step.changes.length === 1 && same(after, { ...before, status: 'error', error: after.error }), 'erro não atômico');
    applyChange(state, last, 'forward'); return step;
  }
  const caller = state.frames.at(-1)!;
  const originalTop = state.operands.at(-1);
  const data = step.changes.slice(0, -1);
  const kinds = data.map(c => c.kind);
  const pattern = (expected: readonly string[]) => requireTrace(same(kinds, expected), 'estrutura dos deltas difere da instrução');
  const pushed = () => {
    const c = data.at(-1);
    requireTrace(c?.kind === 'operands' && c.added.length === 1, 'resultado ausente'); return c.added[0]!;
  };
  let builtinName: string | null = null;
  let nextObjectId = before.nextObjectId, heapItems = before.heapItems;
  switch (instruction.op) {
    case 'PUSH': pattern(['operands']); requireTrace(same(pushed(), instruction.value), 'literal alterado'); break;
    case 'LOAD': {
      pattern(['operands']);
      const local = instruction.scope !== 'global' && Object.hasOwn(caller.locals, instruction.name) ? caller : instruction.scope !== 'local' && Object.hasOwn(state.frames[0]!.locals, instruction.name) ? state.frames[0]! : null;
      const expected = local ? local.locals[instruction.name] : program.runtime.language === 'python' && instruction.scope !== 'local' && pythonBuiltins.has(instruction.name) ? { kind: 'builtin', name: instruction.name } : undefined;
      requireTrace(expected !== undefined && same(pushed(), expected), 'leitura inconsistente'); break;
    }
    case 'DUP': pattern(['operands']); requireTrace(state.operands.length > caller.operandBase && same(pushed(), originalTop), 'duplicação inconsistente'); break;
    case 'CHECK_LIST': pattern([]); getList(originalTop!, state.heap); break;
    case 'BUILD_LIST': {
      pattern([...Array<string>(instruction.count).fill('operands'), 'heap-allocation', 'operands']);
      const allocation = data[instruction.count]!;
      requireTrace(allocation.kind === 'heap-allocation' && allocation.id === before.nextObjectId && !Object.hasOwn(state.heap, allocation.id) && same(allocation.object.items, state.operands.slice(state.operands.length - instruction.count)) && same(pushed(), { kind: 'list', id: allocation.id }), 'alocação inconsistente');
      nextObjectId++; heapItems += instruction.count; break;
    }
    case 'LIST_GET': {
      pattern(['operands', 'operands', 'operands']);
      const target = state.operands.at(-2)!, list = getList(target, state.heap), index = listIndex(originalTop!, list.items.length);
      requireTrace(same(pushed(), list.items[index]), 'leitura de item inconsistente'); break;
    }
    case 'LIST_SET': case 'LIST_APPEND': {
      const append = instruction.op === 'LIST_APPEND';
      pattern(append ? ['operands', 'operands', 'heap-splice', 'operands'] : ['operands', 'operands', 'operands', 'heap-splice']);
      const target = state.operands.at(-2)!, list = getList(target, state.heap), index = append ? list.items.length : listIndex(originalTop!, list.items.length);
      const mutation = data[append ? 2 : 3]!;
      requireTrace(isList(target) && mutation.kind === 'heap-splice' && mutation.id === target.id && mutation.index === index && same(mutation.removed, append ? [] : [list.items[index]]) && same(mutation.added, [append ? originalTop : state.operands.at(-3)]), 'mutação inconsistente');
      if (append) { requireTrace(pushed() === null, 'append deve retornar None'); heapItems++; }
      break;
    }
    case 'BINARY': pattern(['operands', 'operands', 'operands']); break;
    case 'UNARY': pattern(['operands', 'operands']); break;
    case 'POP': case 'JUMP_IF_FALSE': pattern(['operands']); break;
    case 'JUMP': case 'HALT': pattern([]); break;
    case 'DECLARE': case 'STORE': case 'SET': case 'DEFINE': {
      pattern(instruction.op === 'DEFINE' ? ['binding'] : ['operands', 'binding']);
      const b = data.at(-1)!;
      requireTrace(b.kind === 'binding', 'binding ausente');
      const owner = instruction.op === 'STORE' && !Object.hasOwn(caller.locals, instruction.name) ? state.frames[0]! : caller;
      requireTrace(b.frameId === owner.id && (instruction.op !== 'STORE' || Object.hasOwn(owner.locals, instruction.name)) && (instruction.op !== 'DECLARE' || !Object.hasOwn(owner.locals, instruction.name)), 'escopo da atribuição inconsistente');
      requireTrace(b.after.exists && same(b.after.value, instruction.op === 'DEFINE' ? { kind: 'function', name: instruction.name } : originalTop), 'valor da atribuição inconsistente'); break;
    }
    case 'CALL': {
      const callee = instruction.stackCallee ? state.operands[state.operands.length - instruction.argc - 1] : { kind: 'function' as const, name: instruction.name };
      requireTrace(callee !== null && typeof callee === 'object' && !isList(callee), 'callee ausente');
      builtinName = callee.kind === 'builtin' ? callee.name : null;
      pattern([...Array<string>(instruction.argc + (instruction.stackCallee ? 1 : 0)).fill('operands'), ...(builtinName ? builtinName === 'print' ? ['output', 'operands'] : ['operands'] : ['frames'])]);
      if (builtinName === 'print') {
        const output = data.find(c => c.kind === 'output');
        requireTrace(output?.kind === 'output' && output.index === state.output.length && output.removed.length === 0 && output.added.length === 1 && pushed() === null, 'print inconsistente');
      }
      break;
    }
    case 'RETURN': {
      const extra = state.operands.length - 1 - caller.operandBase;
      requireTrace(extra >= 0, 'retorno sem valor');
      pattern(extra ? ['operands', 'operands', 'frames', 'operands'] : ['operands', 'frames', 'operands']);
      requireTrace(same(pushed(), originalTop), 'valor de retorno inconsistente');
      if (extra) { const c = data[1]!; requireTrace(c.kind === 'operands' && c.index === caller.operandBase && c.removed.length === extra && c.added.length === 0, 'temporários do retorno inconsistentes'); }
      break;
    }
  }
  let nextPc = before.pc + 1, nextFrameId = before.nextFrameId;
  const frameChanges = step.changes.filter(c => c.kind === 'frames');
  if (instruction.op === 'JUMP') nextPc = instruction.target;
  if (instruction.op === 'JUMP_IF_FALSE') {
    requireTrace(state.operands.length > caller.operandBase, 'condição ausente');
    const condition = state.operands.at(-1)!;
    if (!(program.runtime.language === 'python' ? pythonTruth(condition, state.heap) : condition === true)) nextPc = instruction.target;
  }
  if (instruction.op === 'CALL' && frameChanges.length) {
    requireTrace(frameChanges.length === 1, 'chamada com frames inconsistentes');
    const c = frameChanges[0]!, added = c.added[0];
    requireTrace(c.index === state.frames.length && c.removed.length === 0 && c.added.length === 1 && added?.id === before.nextFrameId, 'identidade de chamada inválida');
    const callee = instruction.stackCallee ? state.operands[state.operands.length - instruction.argc - 1] : { kind: 'function', name: instruction.name };
    requireTrace(callee !== null && typeof callee === 'object' && callee.kind === 'function' && added.name === callee.name, 'callee inconsistente');
    const fn = program.functions[added.name]!;
    requireTrace(fn.params.length === instruction.argc && same(Object.keys(added.locals), [...fn.params]) && fn.params.every((param, i) => same(added.locals[param], state.operands[state.operands.length - instruction.argc + i])), 'parâmetros da chamada inconsistentes');
    requireTrace(added.returnPc === before.pc + 1 && added.operandBase === state.operands.length - instruction.argc - (instruction.stackCallee ? 1 : 0), 'continuação da chamada inválida');
    nextPc = fn.entry; nextFrameId++;
  } else if (instruction.op === 'RETURN') {
    requireTrace(caller.returnPc !== null && frameChanges.length === 1 && frameChanges[0]!.added.length === 0 && frameChanges[0]!.removed.length === 1 && frameChanges[0]!.index === state.frames.length - 1, 'retorno inconsistente');
    nextPc = caller.returnPc;
  } else requireTrace(frameChanges.length === 0, 'frame alterado fora de chamada/retorno');
  requireTrace(after.pc === nextPc && after.nextFrameId === nextFrameId && after.nextObjectId === nextObjectId && after.heapItems === heapItems && after.status === (instruction.op === 'HALT' ? 'halted' : 'running'), 'controle posterior inconsistente');
  const references = (values: readonly Value[]) => requireTrace(values.every(v => !isList(v) || Object.hasOwn(state.heap, v.id)), 'referência de heap pendente');
  for (const c of step.changes) {
    if (c.kind === 'heap-allocation') {
      references(c.object.items); requireTrace(!Object.hasOwn(state.heap, c.id), 'ID de heap reutilizado');
    } else if (c.kind === 'heap-splice') {
      const list = state.heap[c.id];
      requireTrace(list && c.index + c.removed.length <= list.items.length && same(list.items.slice(c.index, c.index + c.removed.length), c.removed), 'item anterior do heap inconsistente');
      references(c.added);
    } else if (c.kind === 'binding') {
      requireTrace(['DECLARE', 'STORE', 'SET', 'DEFINE'].includes(instruction.op) && 'name' in instruction && c.name === instruction.name, 'binding incompatível com a instrução');
      const f = state.frames.find(f => f.id === c.frameId);
      requireTrace(f, 'frame do binding ausente');
      const exists = Object.hasOwn(f.locals, c.name);
      requireTrace(same(c.before, exists ? { exists: true, value: f.locals[c.name] } : { exists: false }), 'valor anterior do binding inconsistente');
      if (c.after.exists) references([c.after.value]);
    } else if (c.kind !== 'control') {
      if (c.kind === 'operands') {
        const returningCleanup = instruction.op === 'RETURN' && c === data[1] && data.length === 4;
        if (!returningCleanup) requireTrace(c.removed.length === 1 && c.added.length === 0 ? c.index === state.operands.length - 1 && c.index >= state.frames.at(-1)!.operandBase : c.removed.length === 0 && c.added.length === 1 && c.index === state.operands.length, 'operação de pilha inconsistente');
        const pushAllowed = ['PUSH', 'LOAD', 'DUP'].includes(instruction.op) || c === data.at(-1) && ['BINARY', 'UNARY', 'RETURN', 'BUILD_LIST', 'LIST_GET', 'LIST_APPEND'].includes(instruction.op) || instruction.op === 'CALL' && builtinName !== null && c === data.at(-1);
        requireTrace(pushAllowed ? c.added.length === 1 : c.added.length === 0, 'push/pop incompatível com instrução');
        references(c.added);
      }
      if (c.kind === 'frames') for (const f of c.added) references(Object.values(f.locals));
      const list = c.kind === 'frames' ? state.frames : c.kind === 'output' ? state.output : state.operands;
      requireTrace(c.index <= list.length && c.index + c.removed.length <= list.length && same(list.slice(c.index, c.index + c.removed.length), c.removed), 'splice não corresponde ao estado anterior');
      if (c.kind === 'output') requireTrace(instruction.op === 'CALL', 'saída fora de chamada');
    }
    applyChange(state, c, 'forward');
  }
  requireTrace(state.frames.length >= 1 && state.frames.length <= maxFrames && state.frames[0]!.id === 0 && new Set(state.frames.map(f => f.id)).size === state.frames.length, 'pilha de frames inválida');
  requireTrace(state.frames.every(f => f.id < state.control.nextFrameId && f.operandBase <= state.operands.length) && state.operands.length <= 20_000 && state.output.length <= 20_000, 'estado excede os limites');
  return step;
}
