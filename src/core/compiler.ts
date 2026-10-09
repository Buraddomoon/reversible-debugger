import { LanguageError, parse, type Expression, type Span, type Statement, type Value } from './language';
import { parsePython } from './python';
import { formatValue, getRuntime, type LanguageId, type RuntimeSelection } from './runtime';

export type Operation =
  | { op: 'PUSH'; value: Value }
  | { op: 'LOAD'; name: string; scope?: 'local' | 'global' }
  | { op: 'DECLARE' | 'STORE' | 'SET' | 'DEFINE'; name: string }
  | { op: 'BINARY' | 'UNARY'; operator: string }
  | { op: 'JUMP' | 'JUMP_IF_FALSE'; target: number }
  | { op: 'CALL'; name: string; argc: number; stackCallee?: boolean }
  | { op: 'RETURN' | 'POP' | 'DUP' | 'HALT' };
export type Instruction = Operation & { span: Span };
export interface DebugLocation {
  readonly statementId: number;
  readonly span: Span;
  readonly entry: boolean;
  readonly kind: 'statement' | 'implicit-return';
}
export interface FunctionInfo { entry: number; params: readonly string[] }
export interface Program {
  readonly source: string;
  readonly runtime: RuntimeSelection;
  readonly instructions: readonly Instruction[];
  readonly functions: Readonly<Record<string, FunctionInfo>>;
  readonly locations: readonly (DebugLocation | null)[];
  readonly breakableLines: readonly number[];
}

export function compile(source: string, runtime: RuntimeSelection = getRuntime('rewind')): Program {
  const tree = runtime.language === 'python' ? parsePython(source) : parse(source);
  const instructions: Instruction[] = [];
  const locations: Array<DebugLocation | null> = [];
  let statementId = 0;
  let currentSite: { statementId: number; span: Span; entryPc: number; kind: DebugLocation['kind'] } | null = null;
  const site = (span: Span, kind: DebugLocation['kind'] = 'statement') => ({ statementId: statementId++, span, entryPc: instructions.length, kind });
  const functions: Record<string, FunctionInfo> = Object.create(null);
  for (const fn of tree.functions) {
    if (Object.hasOwn(functions, fn.name)) throw new LanguageError(`Função duplicada: ${fn.name}`, fn.span);
    functions[fn.name] = { entry: -1, params: fn.params };
  }
  const emit = (operation: Operation, span: Span, origin = currentSite): number => {
    locations.push(origin ? { statementId: origin.statementId, span: origin.span, entry: origin.entryPc === instructions.length, kind: origin.kind } : null);
    instructions.push({ ...operation, span }); return instructions.length - 1;
  };
  const patch = (index: number, target: number) => {
    const instruction = instructions[index]!;
    if (instruction.op === 'JUMP' || instruction.op === 'JUMP_IF_FALSE') instruction.target = target;
  };
  const assignedNames = (nodes: Statement[]): Set<string> => {
    const names = new Set<string>(), pending = [...nodes];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.kind === 'set') names.add(node.name);
      if (node.kind === 'while') for (const child of node.body) pending.push(child);
      if (node.kind === 'if') for (const child of [...node.then, ...node.otherwise]) pending.push(child);
    }
    return names;
  };
  let currentLocals: Set<string> | null = null;
  const expression = (root: Expression) => {
    // Use an explicit work stack: long flat expressions must not overflow JavaScript's stack.
    const pending: Array<Expression | (() => void)> = [root];
    while (pending.length) {
      const node = pending.pop()!;
      if (typeof node === 'function') { node(); continue; }
      switch (node.kind) {
        case 'literal': emit({ op: 'PUSH', value: node.value }, node.span); break;
        case 'variable': emit({ op: 'LOAD', name: node.name, ...(runtime.language === 'python' ? { scope: currentLocals?.has(node.name) ? 'local' as const : 'global' as const } : {}) }, node.span); break;
        case 'unary': pending.push(() => emit({ op: 'UNARY', operator: node.operator }, node.span), node.operand); break;
        case 'binary': pending.push(() => emit({ op: 'BINARY', operator: node.operator }, node.span), node.right, node.left); break;
        case 'logical':
          pending.push(() => {
            emit({ op: 'DUP' }, node.left.span);
            if (node.operator === 'or') emit({ op: 'UNARY', operator: 'not' }, node.left.span);
            const branch = emit({ op: 'JUMP_IF_FALSE', target: -1 }, node.span);
            emit({ op: 'POP' }, node.left.span);
            pending.push(() => patch(branch, instructions.length), node.right);
          }, node.left);
          break;
        case 'call': {
          const fn = functions[node.name];
          if (runtime.language === 'rewind') {
            if (!fn) throw new LanguageError(`Função inexistente: ${node.name}`, node.span);
            if (fn.params.length !== node.args.length) throw new LanguageError(`${node.name} espera ${fn.params.length} argumento(s)`, node.span);
          }
          pending.push(() => emit({ op: 'CALL', name: node.name, argc: node.args.length, ...(runtime.language === 'python' ? { stackCallee: true } : {}) }, node.span));
          for (let i = node.args.length - 1; i >= 0; i--) pending.push(node.args[i]!);
          if (runtime.language === 'python') pending.push({ kind: 'variable', name: node.name, span: { ...node.span, end: node.span.start + node.name.length } });
          break;
        }
      }
    }
  };
  const statements = (nodes: Statement[], inFunction: boolean) => {
    const previousSite = currentSite;
    for (const node of nodes) {
      currentSite = site(node.span);
      switch (node.kind) {
        case 'let': case 'assign': case 'set':
          expression(node.value);
          emit({ op: node.kind === 'let' ? 'DECLARE' : node.kind === 'set' ? 'SET' : 'STORE', name: node.name }, node.span); break;
        case 'define': emit({ op: 'DEFINE', name: node.name }, node.span); break;
        case 'expression': expression(node.value); emit({ op: 'POP' }, node.span); break;
        case 'return':
          if (!inFunction) throw new LanguageError('return só pode aparecer dentro de uma função', node.span);
          expression(node.value); emit({ op: 'RETURN' }, node.span); break;
        case 'if': {
          expression(node.condition);
          const test = emit({ op: 'JUMP_IF_FALSE', target: -1 }, node.condition.span);
          statements(node.then, inFunction);
          const skip = emit({ op: 'JUMP', target: -1 }, node.span, null);
          patch(test, instructions.length);
          statements(node.otherwise, inFunction);
          patch(skip, instructions.length); break;
        }
        case 'while': {
          const entry = instructions.length;
          expression(node.condition);
          const test = emit({ op: 'JUMP_IF_FALSE', target: -1 }, node.condition.span);
          statements(node.body, inFunction);
          emit({ op: 'JUMP', target: entry }, node.condition.span, null);
          patch(test, instructions.length); break;
        }
      }
    }
    currentSite = previousSite;
  };
  statements(tree.statements, false);
  emit({ op: 'HALT' }, tree.statements.at(-1)?.span ?? tree.span, null);
  for (const fn of tree.functions) {
    functions[fn.name] = { entry: instructions.length, params: fn.params };
    currentLocals = new Set([...fn.params, ...assignedNames(fn.body)]);
    statements(fn.body, true);
    currentSite = site(fn.span, 'implicit-return');
    emit({ op: 'PUSH', value: runtime.language === 'python' ? null : 0 }, fn.span);
    emit({ op: 'RETURN' }, fn.span);
    currentSite = null;
  }
  // Program and debug metadata are immutable throughout a run.
  for (const instruction of instructions) { Object.freeze(instruction.span); Object.freeze(instruction); }
  for (const fn of Object.values(functions)) { Object.freeze(fn.params); Object.freeze(fn); }
  for (const location of locations) if (location) { Object.freeze(location.span); Object.freeze(location); }
  const breakableLines = [...new Set(locations.filter(location => location?.entry && location.kind === 'statement').map(location => location!.span.line))].sort((a, b) => a - b);
  return Object.freeze({ source, runtime, instructions: Object.freeze(instructions), functions: Object.freeze(functions), locations: Object.freeze(locations), breakableLines: Object.freeze(breakableLines) });
}

export function describeInstruction(instruction: Instruction, language: LanguageId = 'rewind'): string {
  switch (instruction.op) {
    case 'PUSH': return `Preparar ${formatValue(instruction.value, language)}`;
    case 'LOAD': return `Ler ${instruction.name}`;
    case 'DECLARE': return `Declarar ${instruction.name}`;
    case 'STORE': return `Atualizar ${instruction.name}`;
    case 'SET': return `Atribuir ${instruction.name}`;
    case 'DEFINE': return `Definir ${instruction.name}`;
    case 'BINARY': return `Calcular ${instruction.operator}`;
    case 'UNARY': return `Aplicar ${instruction.operator}`;
    case 'JUMP': return 'Continuar o fluxo';
    case 'JUMP_IF_FALSE': return 'Decidir o caminho';
    case 'CALL': return `Chamar ${instruction.name}`;
    case 'RETURN': return 'Retornar da função';
    case 'POP': return 'Descartar resultado da expressão';
    case 'DUP': return 'Preservar valor para a decisão';
    case 'HALT': return 'Concluir o programa';
  }
}
