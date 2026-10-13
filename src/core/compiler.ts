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
  | { op: 'BUILD_LIST'; count: number }
  | { op: 'LIST_GET' | 'LIST_SET' | 'LIST_APPEND' | 'CHECK_LIST' }
  | { op: 'RETURN' | 'POP' | 'DUP' | 'HALT' };
export type Instruction = Operation & { span: Span };
export interface DebugLocation {
  readonly statementId: number;
  readonly span: Span;
  readonly entry: boolean;
  readonly kind: 'statement' | 'implicit-return';
  readonly semanticKey: string;
  readonly flowDecision: boolean;
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
  let currentSite: { statementId: number; span: Span; entryPc: number; kind: DebugLocation['kind']; semanticKey: string } | null = null;
  const site = (span: Span, semanticKey: string, kind: DebugLocation['kind'] = 'statement') => ({ statementId: statementId++, span, entryPc: instructions.length, kind, semanticKey });
  const functions: Record<string, FunctionInfo> = Object.create(null);
  for (const fn of tree.functions) {
    if (Object.hasOwn(functions, fn.name)) throw new LanguageError(`Função duplicada: ${fn.name}`, fn.span);
    functions[fn.name] = { entry: -1, params: fn.params };
  }
  const emit = (operation: Operation, span: Span, origin = currentSite, flowDecision = false): number => {
    locations.push(origin ? { statementId: origin.statementId, span: origin.span, entry: origin.entryPc === instructions.length, kind: origin.kind, semanticKey: origin.semanticKey, flowDecision } : null);
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
        case 'list':
          pending.push(() => emit({ op: 'BUILD_LIST', count: node.items.length }, node.span));
          for (let i = node.items.length - 1; i >= 0; i--) pending.push(node.items[i]!);
          break;
        case 'index': pending.push(() => emit({ op: 'LIST_GET' }, node.span), node.index, node.target); break;
        case 'append': pending.push(() => emit({ op: 'LIST_APPEND' }, node.span), node.value, () => emit({ op: 'CHECK_LIST' }, node.target.span), node.target); break;
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
  const conditionNames = (root: Expression): string => {
    const names = new Set<string>(), pending = [root];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.kind === 'variable') names.add(`var:${node.name}`);
      if (node.kind === 'call') { names.add(`call:${node.name}`); for (const arg of node.args) pending.push(arg); }
      if (node.kind === 'unary') pending.push(node.operand);
      if (node.kind === 'binary' || node.kind === 'logical') pending.push(node.left, node.right);
      if (node.kind === 'list') for (const item of node.items) pending.push(item);
      if (node.kind === 'index') pending.push(node.target, node.index);
      if (node.kind === 'append') pending.push(node.target, node.value);
    }
    return [...names].sort().map(encodeURIComponent).join(',');
  };
  const statementSignature = (node: Statement): string => {
    switch (node.kind) {
      case 'let': case 'assign': case 'set': case 'define': return `${node.kind}:${encodeURIComponent(node.name)}`;
      case 'if': case 'while': return `${node.kind}:${conditionNames(node.condition)}`;
      case 'return': return 'return';
      case 'expression': return `expression:${node.value.kind === 'call' ? encodeURIComponent(node.value.name) : node.value.kind}`;
      case 'index-set': return `index-set:${conditionNames(node.target)}`;
    }
  };
  const statements = (nodes: Statement[], inFunction: boolean, block: string) => {
    const previousSite = currentSite;
    const occurrences = new Map<string, number>();
    for (const node of nodes) {
      const signature = statementSignature(node);
      const occurrence = (occurrences.get(signature) ?? 0) + 1;
      occurrences.set(signature, occurrence);
      const semanticKey = `${block}/${signature}@${occurrence}`;
      currentSite = site(node.span, semanticKey);
      switch (node.kind) {
        case 'let': case 'assign': case 'set':
          expression(node.value);
          emit({ op: node.kind === 'let' ? 'DECLARE' : node.kind === 'set' ? 'SET' : 'STORE', name: node.name }, node.span); break;
        case 'define': emit({ op: 'DEFINE', name: node.name }, node.span); break;
        case 'index-set':
          // Python evaluates RHS before the assignment's receiver/index.
          expression(node.value); expression(node.target); expression(node.index); emit({ op: 'LIST_SET' }, node.span); break;
        case 'expression': expression(node.value); emit({ op: 'POP' }, node.span); break;
        case 'return':
          if (!inFunction) throw new LanguageError('return só pode aparecer dentro de uma função', node.span);
          expression(node.value); emit({ op: 'RETURN' }, node.span); break;
        case 'if': {
          expression(node.condition);
          const test = emit({ op: 'JUMP_IF_FALSE', target: -1 }, node.condition.span, currentSite, true);
          statements(node.then, inFunction, `${semanticKey}/then`);
          const skip = emit({ op: 'JUMP', target: -1 }, node.span, null);
          patch(test, instructions.length);
          statements(node.otherwise, inFunction, `${semanticKey}/else`);
          patch(skip, instructions.length); break;
        }
        case 'while': {
          const entry = instructions.length;
          expression(node.condition);
          const test = emit({ op: 'JUMP_IF_FALSE', target: -1 }, node.condition.span, currentSite, true);
          statements(node.body, inFunction, `${semanticKey}/body`);
          emit({ op: 'JUMP', target: entry }, node.condition.span, null);
          patch(test, instructions.length); break;
        }
      }
    }
    currentSite = previousSite;
  };
  statements(tree.statements, false, 'program');
  emit({ op: 'HALT' }, tree.statements.at(-1)?.span ?? tree.span, null);
  for (const fn of tree.functions) {
    functions[fn.name] = { entry: instructions.length, params: fn.params };
    currentLocals = new Set([...fn.params, ...assignedNames(fn.body)]);
    const scope = `function:${encodeURIComponent(fn.name)}`;
    statements(fn.body, true, scope);
    currentSite = site(fn.span, `${scope}/implicit-return`, 'implicit-return');
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
    case 'BUILD_LIST': return `Criar lista com ${instruction.count} itens`;
    case 'LIST_GET': return 'Ler item da lista';
    case 'LIST_SET': return 'Alterar item da lista';
    case 'LIST_APPEND': return 'Acrescentar item à lista';
    case 'CHECK_LIST': return 'Verificar destino de append';
  }
}
