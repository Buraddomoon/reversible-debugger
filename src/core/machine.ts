import { describeInstruction, type Instruction, type Program } from './compiler';
import type { Span, Value } from './language';
import { pythonBinary, pythonBuiltins, pythonTruth, pythonUnary } from './python-values';
import { formatValue } from './runtime';

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
  output: string[];
}
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
type Binding = { exists: false } | { exists: true; value: Value };
export type Change =
  | { kind: 'control'; before: Control; after: Control }
  | { kind: 'binding'; frameId: number; name: string; before: Binding; after: Binding }
  | { kind: 'operands'; index: number; removed: Value[]; added: Value[] }
  | { kind: 'output'; index: number; removed: string[]; added: string[] }
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
    output: [],
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
    case 'output':
      state.output.splice(change.index, (forward ? change.removed : change.added).length, ...(forward ? change.added : change.removed));
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
  let description = describeInstruction(instruction, program.runtime.language);
  const python = program.runtime.language === 'python';
  const format = (value: Value) => formatValue(value, program.runtime.language);
  const commit = (change: Change) => { applyChange(state, change, 'forward'); changes.push(change); };
  const push = (value: Value) => commit({ kind: 'operands', index: state.operands.length, removed: [], added: [value] });
  const pop = (): Value => {
    const frame = state.frames.at(-1)!;
    if (state.operands.length <= frame.operandBase) throw new Error('Pilha de operandos insuficiente');
    const value = state.operands.at(-1)!;
    commit({ kind: 'operands', index: state.operands.length - 1, removed: [value], added: [] });
    return value;
  };
  const resolve = (name: string, scope?: 'local' | 'global'): Frame => {
    const local = state.frames.at(-1)!;
    if (scope !== 'global' && Object.hasOwn(local.locals, name)) return local;
    const global = state.frames[0]!;
    if (scope !== 'local' && Object.hasOwn(global.locals, name)) return global;
    if (scope === 'local') throw new Error(`Variável local ainda não inicializada: ${name}`);
    throw new Error(`Variável inexistente: ${name}`);
  };
  const read = (name: string, scope?: 'local' | 'global'): Value => {
    try { return resolve(name, scope).locals[name]!; }
    catch (error) {
      if (python && scope !== 'local' && pythonBuiltins.has(name)) return { kind: 'builtin', name };
      throw error;
    }
  };
  try {
    switch (instruction.op) {
      case 'PUSH': push(instruction.value); break;
      case 'LOAD': push(read(instruction.name, instruction.scope)); break;
      case 'DECLARE': case 'STORE': case 'SET': case 'DEFINE': {
        const frame = instruction.op === 'STORE' ? resolve(instruction.name) : state.frames.at(-1)!;
        const exists = Object.hasOwn(frame.locals, instruction.name);
        if (instruction.op === 'DECLARE' && exists) throw new Error(`Variável já declarada neste escopo: ${instruction.name}`);
        const value: Value = instruction.op === 'DEFINE' ? { kind: 'function', name: instruction.name } : pop();
        const binding: Binding = exists ? { exists: true, value: frame.locals[instruction.name]! } : { exists: false };
        commit({ kind: 'binding', frameId: frame.id, name: instruction.name, before: binding, after: { exists: true, value } });
        description = exists ? `${instruction.name}: ${format(value)} (antes: ${binding.exists ? format(binding.value) : ''})` : `Declarar ${instruction.name} = ${format(value)}`;
        break;
      }
      case 'BINARY': {
        const right = pop(), left = pop();
        const result = python ? pythonBinary(instruction.operator, left, right) : binary(instruction.operator, left, right);
        push(result);
        description = `${format(left)} ${instruction.operator} ${format(right)} → ${format(result)}`; break;
      }
      case 'UNARY': {
        const value = pop();
        if (python) push(pythonUnary(instruction.operator, value));
        else if (instruction.operator === '!') {
          if (typeof value !== 'boolean') throw new Error('O operador ! exige um booleano');
          push(!value);
        } else { push(-numeric(value)); }
        break;
      }
      case 'POP': pop(); break;
      case 'DUP':
        if (state.operands.length <= state.frames.at(-1)!.operandBase) throw new Error('Pilha de operandos insuficiente');
        push(state.operands.at(-1)!); break;
      case 'JUMP': after.pc = instruction.target; break;
      case 'JUMP_IF_FALSE': {
        const value = pop();
        const condition = python ? pythonTruth(value) : value;
        if (typeof condition !== 'boolean') throw new Error('A condição precisa ser booleana');
        if (!condition) after.pc = instruction.target;
        description = condition ? 'Condição verdadeira: entrar no bloco' : 'Condição falsa: sair do bloco'; break;
      }
      case 'CALL': {
        let name = instruction.name;
        let builtin = false;
        if (instruction.stackCallee) {
          const callee = state.operands[state.operands.length - instruction.argc - 1];
          if (callee === null || typeof callee !== 'object') throw new Error(`${name} não é uma função chamável`);
          name = callee.name; builtin = callee.kind === 'builtin';
        }
        if (builtin) {
          const values: Value[] = [];
          for (let i = 0; i < instruction.argc; i++) values.unshift(pop());
          pop(); // The callee was evaluated before the arguments, like Python.
          if (name === 'print') {
            const text = `${values.map(format).join(' ')}\n`;
            commit({ kind: 'output', index: state.output.length, removed: [], added: [text] });
            push(null); description = `Saída: ${text.trimEnd()}`;
          } else {
            if (values.length > 1 || (values.length === 0 && name === 'abs')) throw new Error(`${name} espera ${name === 'abs' ? 'um argumento' : 'até um argumento'} nesta versão`);
            const result = pythonUnary(name, values.length ? values[0]! : 0n);
            push(result); description = `${name}(${values.map(format).join(', ')}) → ${format(result)}`;
          }
          break;
        }
        if (state.frames.length >= maxFrames) throw new Error(`Limite de ${maxFrames} frames de chamada excedido`);
        const fn = program.functions[name]!;
        if (fn.params.length !== instruction.argc) throw new Error(`${name} espera ${fn.params.length} argumento(s)`);
        const values: Value[] = [];
        for (let i = 0; i < instruction.argc; i++) values.unshift(pop());
        if (instruction.stackCallee) pop();
        const locals: Record<string, Value> = Object.create(null);
        fn.params.forEach((name, index) => { locals[name] = values[index]!; });
        const frame: Frame = { id: before.nextFrameId, name, locals, returnPc: before.pc + 1, operandBase: state.operands.length };
        commit({ kind: 'frames', index: state.frames.length, removed: [], added: [frame] });
        after.nextFrameId++; after.pc = fn.entry;
        description = `Entrar em ${name}(${values.map(format).join(', ')})`; break;
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
        description = `${frame.name} retorna ${format(result)}`; break;
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
