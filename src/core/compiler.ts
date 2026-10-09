import { LanguageError, parse, type Expression, type Span, type Statement, type Value } from './language';

export type Operation =
  | { op: 'PUSH'; value: Value }
  | { op: 'LOAD' | 'DECLARE' | 'STORE'; name: string }
  | { op: 'BINARY' | 'UNARY'; operator: string }
  | { op: 'JUMP' | 'JUMP_IF_FALSE'; target: number }
  | { op: 'CALL'; name: string; argc: number }
  | { op: 'RETURN' | 'POP' | 'HALT' };
export type Instruction = Operation & { span: Span };
export interface FunctionInfo { entry: number; params: readonly string[] }
export interface Program {
  readonly source: string;
  readonly instructions: readonly Instruction[];
  readonly functions: Readonly<Record<string, FunctionInfo>>;
}

export function compile(source: string): Program {
  const tree = parse(source);
  const instructions: Instruction[] = [];
  const functions: Record<string, FunctionInfo> = Object.create(null);
  for (const fn of tree.functions) {
    if (Object.hasOwn(functions, fn.name)) throw new LanguageError(`Função duplicada: ${fn.name}`, fn.span);
    functions[fn.name] = { entry: -1, params: fn.params };
  }
  const emit = (operation: Operation, span: Span): number => {
    instructions.push({ ...operation, span }); return instructions.length - 1;
  };
  const patch = (index: number, target: number) => {
    const instruction = instructions[index]!;
    if (instruction.op === 'JUMP' || instruction.op === 'JUMP_IF_FALSE') instruction.target = target;
  };
  const expression = (node: Expression) => {
    switch (node.kind) {
      case 'literal': emit({ op: 'PUSH', value: node.value }, node.span); break;
      case 'variable': emit({ op: 'LOAD', name: node.name }, node.span); break;
      case 'unary': expression(node.operand); emit({ op: 'UNARY', operator: node.operator }, node.span); break;
      case 'binary':
        expression(node.left); expression(node.right);
        emit({ op: 'BINARY', operator: node.operator }, node.span); break;
      case 'call': {
        const fn = functions[node.name];
        if (!fn) throw new LanguageError(`Função inexistente: ${node.name}`, node.span);
        if (fn.params.length !== node.args.length) throw new LanguageError(`${node.name} espera ${fn.params.length} argumento(s)`, node.span);
        node.args.forEach(expression);
        emit({ op: 'CALL', name: node.name, argc: node.args.length }, node.span); break;
      }
    }
  };
  const statements = (nodes: Statement[], inFunction: boolean) => {
    for (const node of nodes) {
      switch (node.kind) {
        case 'let': case 'assign':
          expression(node.value);
          emit({ op: node.kind === 'let' ? 'DECLARE' : 'STORE', name: node.name }, node.span); break;
        case 'expression': expression(node.value); emit({ op: 'POP' }, node.span); break;
        case 'return':
          if (!inFunction) throw new LanguageError('return só pode aparecer dentro de uma função', node.span);
          expression(node.value); emit({ op: 'RETURN' }, node.span); break;
        case 'if': {
          expression(node.condition);
          const test = emit({ op: 'JUMP_IF_FALSE', target: -1 }, node.condition.span);
          statements(node.then, inFunction);
          const skip = emit({ op: 'JUMP', target: -1 }, node.span);
          patch(test, instructions.length);
          statements(node.otherwise, inFunction);
          patch(skip, instructions.length); break;
        }
        case 'while': {
          const entry = instructions.length;
          expression(node.condition);
          const test = emit({ op: 'JUMP_IF_FALSE', target: -1 }, node.condition.span);
          statements(node.body, inFunction);
          emit({ op: 'JUMP', target: entry }, node.condition.span);
          patch(test, instructions.length); break;
        }
      }
    }
  };
  statements(tree.statements, false);
  emit({ op: 'HALT' }, tree.statements.at(-1)?.span ?? tree.span);
  for (const fn of tree.functions) {
    functions[fn.name] = { entry: instructions.length, params: fn.params };
    statements(fn.body, true);
    // The small language has a numeric zero as its explicit documented default return.
    emit({ op: 'PUSH', value: 0 }, fn.span);
    emit({ op: 'RETURN' }, fn.span);
  }
  // Program and debug metadata are immutable throughout a run.
  for (const instruction of instructions) { Object.freeze(instruction.span); Object.freeze(instruction); }
  for (const fn of Object.values(functions)) { Object.freeze(fn.params); Object.freeze(fn); }
  return Object.freeze({ source, instructions: Object.freeze(instructions), functions: Object.freeze(functions) });
}

export function describeInstruction(instruction: Instruction): string {
  switch (instruction.op) {
    case 'PUSH': return `Preparar ${instruction.value}`;
    case 'LOAD': return `Ler ${instruction.name}`;
    case 'DECLARE': return `Declarar ${instruction.name}`;
    case 'STORE': return `Atualizar ${instruction.name}`;
    case 'BINARY': return `Calcular ${instruction.operator}`;
    case 'UNARY': return `Aplicar ${instruction.operator}`;
    case 'JUMP': return 'Continuar o fluxo';
    case 'JUMP_IF_FALSE': return 'Decidir o caminho';
    case 'CALL': return `Chamar ${instruction.name}`;
    case 'RETURN': return 'Retornar da função';
    case 'POP': return 'Descartar resultado da expressão';
    case 'HALT': return 'Concluir o programa';
  }
}
