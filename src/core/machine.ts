import { describeInstruction, type Instruction, type Program } from './compiler';
import type { Span, Value } from './language';

export interface Control {
  pc: number;
  status: 'running' | 'halted' | 'error';
  error: string | null;
  nextFrameId: number;
}
export interface Frame {
  id: number;
  name: string;
  locals: Record<string, Value>;
  returnPc: number | null;
  operandBase: number;
}
export interface MachineState {
  control: Control;
  frames: Frame[];
  operands: Value[];
}
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
type Binding = { exists: false } | { exists: true; value: Value };
export type Change =
  | { kind: 'control'; before: Control; after: Control }
  | { kind: 'binding'; frameId: number; name: string; before: Binding; after: Binding }
  | { kind: 'operands'; index: number; removed: Value[]; added: Value[] }
  | { kind: 'frames'; index: number; removed: Frame[]; added: Frame[] };
export interface Step {
  index: number;
  op: Instruction['op'];
  span: Span;
  description: string;
  changes: Change[];
}

export function initialState(): MachineState {
  return {
    control: { pc: 0, status: 'running', error: null, nextFrameId: 1 },
    frames: [{ id: 0, name: 'programa', locals: Object.create(null), returnPc: null, operandBase: 0 }],
    operands: [],
  };
}

/** Apply the same immutable payload in either direction. Never retain live frames in history. */
export function applyChange(state: MachineState, change: Change, direction: 'forward' | 'backward'): void {
  const forward = direction === 'forward';
  switch (change.kind) {
    case 'control': state.control = { ...(forward ? change.after : change.before) }; break;
    case 'binding': {
      const frame = state.frames.find(frame => frame.id === change.frameId);
      if (!frame) throw new Error(`Histórico inconsistente: frame ${change.frameId} ausente`);
      const binding = forward ? change.after : change.before;
      if (binding.exists) Object.defineProperty(frame.locals, change.name, { value: binding.value, writable: true, enumerable: true, configurable: true });
      else delete frame.locals[change.name];
      break;
    }
    case 'operands':
      state.operands.splice(change.index, (forward ? change.removed : change.added).length, ...(forward ? change.added : change.removed));
      break;
    case 'frames':
      state.frames.splice(change.index, (forward ? change.removed : change.added).length, ...structuredClone(forward ? change.added : change.removed));
      break;
  }
}

export function applyStep(state: MachineState, step: DeepReadonly<Step>, direction: 'forward' | 'backward'): void {
  // These payloads are only read; the cast bridges readonly arrays to the internal mutation API.
  const changes = step.changes as Change[];
  if (direction === 'forward') for (const change of changes) applyChange(state, change, direction);
  else for (let i = changes.length - 1; i >= 0; i--) applyChange(state, changes[i]!, direction);
}

function numeric(value: Value): number {
  if (typeof value !== 'number') throw new Error('Esta operação exige números');
  return value;
}
function binary(operator: string, left: Value, right: Value): Value {
  if (operator === '==' || operator === '!=') {
    if (typeof left !== typeof right) throw new Error('Comparação exige valores do mesmo tipo');
    return operator === '==' ? left === right : left !== right;
  }
  const a = numeric(left), b = numeric(right);
  let result: Value;
  switch (operator) {
    case '+': result = a + b; break;
    case '-': result = a - b; break;
    case '*': result = a * b; break;
    case '/': case '%':
      if (b === 0) throw new Error('Divisão por zero');
      result = operator === '/' ? a / b : a % b; break;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    default: throw new Error(`Operador desconhecido: ${operator}`);
  }
  if (!Number.isFinite(result)) throw new Error('Resultado numérico fora do intervalo finito');
  return result;
}

/** Execute one instruction as a transaction. Failed instructions roll back partial writes. */
export function executeInstruction(state: MachineState, program: Program, maxFrames = 256): Step {
  if (state.control.status !== 'running') throw new Error('A execução já terminou');
  const before = { ...state.control };
  const instruction = program.instructions[before.pc];
  if (!instruction) throw new Error('Posição de execução inválida');
  const changes: Change[] = [];
  let after: Control = { ...before, pc: before.pc + 1 };
  let description = describeInstruction(instruction);
  const commit = (change: Change) => { applyChange(state, change, 'forward'); changes.push(change); };
  const push = (value: Value) => commit({ kind: 'operands', index: state.operands.length, removed: [], added: [value] });
  const pop = (): Value => {
    const frame = state.frames.at(-1)!;
    if (state.operands.length <= frame.operandBase) throw new Error('Pilha de operandos insuficiente');
    const value = state.operands.at(-1)!;
    commit({ kind: 'operands', index: state.operands.length - 1, removed: [value], added: [] });
    return value;
  };
  const resolve = (name: string): Frame => {
    const local = state.frames.at(-1)!;
    if (Object.hasOwn(local.locals, name)) return local;
    const global = state.frames[0]!;
    if (Object.hasOwn(global.locals, name)) return global;
    throw new Error(`Variável inexistente: ${name}`);
  };
  try {
    switch (instruction.op) {
      case 'PUSH': push(instruction.value); break;
      case 'LOAD': push(resolve(instruction.name).locals[instruction.name]!); break;
      case 'DECLARE': case 'STORE': {
        const frame = instruction.op === 'DECLARE' ? state.frames.at(-1)! : resolve(instruction.name);
        const exists = Object.hasOwn(frame.locals, instruction.name);
        if (instruction.op === 'DECLARE' && exists) throw new Error(`Variável já declarada neste escopo: ${instruction.name}`);
        const value = pop();
        const binding: Binding = exists ? { exists: true, value: frame.locals[instruction.name]! } : { exists: false };
        commit({ kind: 'binding', frameId: frame.id, name: instruction.name, before: binding, after: { exists: true, value } });
        description = exists ? `${instruction.name}: ${frame.locals[instruction.name]} (antes: ${binding.exists ? binding.value : ''})` : `Declarar ${instruction.name} = ${value}`;
        break;
      }
      case 'BINARY': {
        const right = pop(), left = pop();
        const result = binary(instruction.operator, left, right);
        push(result);
        description = `${left} ${instruction.operator} ${right} → ${result}`; break;
      }
      case 'UNARY': {
        const value = pop();
        if (instruction.operator === '!') {
          if (typeof value !== 'boolean') throw new Error('O operador ! exige um booleano');
          push(!value);
        } else { push(-numeric(value)); }
        break;
      }
      case 'POP': pop(); break;
      case 'JUMP': after.pc = instruction.target; break;
      case 'JUMP_IF_FALSE': {
        const condition = pop();
        if (typeof condition !== 'boolean') throw new Error('A condição precisa ser booleana');
        if (!condition) after.pc = instruction.target;
        description = condition ? 'Condição verdadeira: entrar no bloco' : 'Condição falsa: sair do bloco'; break;
      }
      case 'CALL': {
        if (state.frames.length >= maxFrames) throw new Error(`Limite de ${maxFrames} frames de chamada excedido`);
        const fn = program.functions[instruction.name]!;
        const values: Value[] = [];
        for (let i = 0; i < instruction.argc; i++) values.unshift(pop());
        const locals: Record<string, Value> = Object.create(null);
        fn.params.forEach((name, index) => { locals[name] = values[index]!; });
        const frame: Frame = { id: before.nextFrameId, name: instruction.name, locals, returnPc: before.pc + 1, operandBase: state.operands.length };
        commit({ kind: 'frames', index: state.frames.length, removed: [], added: [frame] });
        after.nextFrameId++; after.pc = fn.entry;
        description = `Entrar em ${instruction.name}(${values.join(', ')})`; break;
      }
      case 'RETURN': {
        const frame = state.frames.at(-1)!;
        if (frame.returnPc === null) throw new Error('Retorno fora de uma função');
        const result = pop();
        // Preserve any caller operands held below this frame's base.
        if (state.operands.length > frame.operandBase) {
          commit({ kind: 'operands', index: frame.operandBase, removed: state.operands.slice(frame.operandBase), added: [] });
        }
        commit({ kind: 'frames', index: state.frames.length - 1, removed: [structuredClone(frame)], added: [] });
        push(result); after.pc = frame.returnPc;
        description = `${frame.name} retorna ${result}`; break;
      }
      case 'HALT': after.status = 'halted'; description = 'Execução concluída'; break;
    }
  } catch (error) {
    for (let i = changes.length - 1; i >= 0; i--) applyChange(state, changes[i]!, 'backward');
    changes.length = 0;
    after = { ...before, status: 'error', error: error instanceof Error ? error.message : String(error) };
    description = after.error!;
  }
  commit({ kind: 'control', before, after });
  return { index: before.pc, op: instruction.op, span: instruction.span, description, changes };
}
