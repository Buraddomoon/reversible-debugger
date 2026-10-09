import { LanguageError, validateSourceSize, type Expression, type FunctionNode, type Span, type Statement, type SyntaxTree } from './language';

interface Token { text: string; span: Span; kind: 'number' | 'name' | 'symbol' | 'end' }
interface Line { indent: number; text: string; span: Span }
const reserved = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '));
const priorities: Record<string, number> = { or: 1, and: 2, '==': 4, '!=': 4, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '//': 6, '%': 6, '**': 8 };
const combine = (a: Span, b: Span): Span => ({ ...a, end: b.end });

function lines(source: string): Line[] {
  const result: Line[] = [];
  let offset = 0, continuation: Line | null = null, depth = 0;
  source.split('\n').forEach((raw, index) => {
    const indentText = /^[ \t]*/.exec(raw)![0];
    const span = { start: offset + indentText.length, end: offset + raw.length, line: index + 1, column: indentText.length + 1 };
    const code = raw.slice(indentText.length).split('#')[0]!.trimEnd();
    if (code || continuation) {
      if (!continuation && indentText.includes('\t')) throw new LanguageError('Use espaços na indentação; tabulações ainda não são suportadas', span);
      if (!continuation) continuation = { indent: indentText.length, text: '', span };
      for (const character of code) { if (character === '(') depth++; if (character === ')') depth--; }
      if (depth < 0) throw new LanguageError('Parêntese de fechamento inesperado', span);
      if (depth === 0) {
        continuation.text = source.slice(continuation.span.start, span.end);
        continuation.span = combine(continuation.span, span);
        result.push(continuation); continuation = null;
      }
    }
    offset += raw.length + 1;
  });
  if (continuation) throw new LanguageError('Parêntese não foi fechado', (continuation as Line).span);
  return result;
}

function lex(line: Line): Token[] {
  const tokens: Token[] = [];
  let offset = 0, row = line.span.line, column = line.span.column;
  const number = /(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/y;
  const identifier = /[A-Za-z_][A-Za-z_0-9]*/y;
  const advance = () => { if (line.text[offset] === '\n') { row++; column = 1; } else column++; offset++; };
  while (offset < line.text.length) {
    const character = line.text[offset]!;
    if (/\s/.test(character)) { advance(); continue; }
    if (character === '#') { while (offset < line.text.length && line.text[offset] !== '\n') advance(); continue; }
    const span = { start: line.span.start + offset, end: line.span.start + offset, line: row, column };
    number.lastIndex = identifier.lastIndex = offset;
    const numeric = number.exec(line.text), name = identifier.exec(line.text);
    let text: string, kind: Token['kind'];
    if (numeric) { text = numeric[0]; kind = 'number'; }
    else if (name) { text = name[0]; kind = 'name'; }
    else {
      const triple = line.text.slice(offset, offset + 3), pair = line.text.slice(offset, offset + 2);
      text = ['//=', '**='].includes(triple) ? triple : ['==', '!=', '<=', '>=', '//', '**', '+=', '-=', '*=', '/=', '%='].includes(pair) ? pair : character;
      if (!['==', '!=', '<=', '>=', '//', '**', '+=', '-=', '*=', '/=', '%=', '//=', '**=', '+', '-', '*', '/', '%', '<', '>', '=', '(', ')', ',', ':'].includes(text)) {
        throw new LanguageError(`Recurso ou caractere ainda não suportado em Python: ${character}`, span);
      }
      kind = 'symbol';
    }
    for (let i = 0; i < text.length; i++) advance();
    tokens.push({ text, kind, span: { ...span, end: line.span.start + offset } });
  }
  tokens.push({ text: '<fim da linha>', kind: 'end', span: { start: line.span.end, end: line.span.end, line: row, column } });
  return tokens;
}

class Expressions {
  cursor = 0;
  private depth = 0;
  private grouped = new WeakSet<Expression>();
  constructor(readonly tokens: Token[]) {}
  get current(): Token { return this.tokens[this.cursor]!; }
  take(): Token { return this.tokens[this.cursor++]!; }
  match(text: string): boolean { if (this.current.text !== text) return false; this.take(); return true; }
  expect(text: string): Token {
    if (this.current.text !== text) throw new LanguageError(`Esperado '${text}', encontrado '${this.current.text}'`, this.current.span);
    return this.take();
  }
  name(): Token {
    if (this.current.kind !== 'name' || reserved.has(this.current.text)) throw new LanguageError('Esperado um identificador Python', this.current.span);
    return this.take();
  }
  end(): void {
    if (this.current.kind !== 'end') throw new LanguageError(`Sintaxe ou recurso Python ainda não suportado: ${this.current.text}`, this.current.span);
  }
  expression(minimum = 1): Expression {
    if (++this.depth > 128) throw new LanguageError('Limite de aninhamento sintático excedido', this.current.span);
    try {
      let left = this.primary();
      while ((priorities[this.current.text] ?? 0) >= minimum) {
        const operator = this.take();
        if (priorities[operator.text] === 4 && left.kind === 'binary' && priorities[left.operator] === 4 && !this.grouped.has(left)) {
          throw new LanguageError('Comparações encadeadas ainda não são suportadas; use and com comparações separadas', operator.span);
        }
        const right = this.expression(priorities[operator.text]! + (operator.text === '**' ? 0 : 1));
        const span = combine(left.span, right.span);
        left = operator.text === 'and' || operator.text === 'or' ? { kind: 'logical', operator: operator.text, left, right, span } : { kind: 'binary', operator: operator.text, left, right, span };
      }
      return left;
    } finally { this.depth--; }
  }
  private primary(): Expression {
    const token = this.current;
    if (this.match('not') || this.match('-') || this.match('+')) {
      const operand = this.expression(token.text === 'not' ? 3 : 7);
      return { kind: 'unary', operator: token.text, operand, span: combine(token.span, operand.span) };
    }
    if (this.match('(')) { const expression = this.expression(); this.expect(')'); this.grouped.add(expression); return expression; }
    if (token.kind === 'number') {
      this.take();
      const isBaseInteger = /^0[xob]/i.test(token.text);
      const integer = isBaseInteger || !/[.eE]/.test(token.text);
      if (!isBaseInteger && integer && /^0\d*[1-9]/.test(token.text)) throw new LanguageError('Inteiros decimais não podem ter zeros à esquerda', token.span);
      if (integer && token.text.length > 4300) throw new LanguageError('Literal inteiro excede 4.300 dígitos', token.span);
      return { kind: 'literal', value: integer ? BigInt(token.text) : Number(token.text), span: token.span };
    }
    if (this.match('True') || this.match('False') || this.match('None')) return { kind: 'literal', value: token.text === 'None' ? null : token.text === 'True', span: token.span };
    if (token.kind === 'name' && !reserved.has(token.text)) {
      const name = this.name().text;
      if (!this.match('(')) return { kind: 'variable', name, span: token.span };
      const args: Expression[] = [];
      if (this.current.text !== ')') {
        do { args.push(this.expression()); } while (this.match(',') && this.current.text !== ')');
      }
      return { kind: 'call', name, args, span: combine(token.span, this.expect(')').span) };
    }
    throw new LanguageError(`Expressão Python ainda não suportada ou inválida: ${token.text}`, token.span);
  }
}

class PythonParser {
  private cursor = 0;
  private depth = 0;
  private clauseDepth = 0;
  private functions: FunctionNode[] = [];
  constructor(private readonly input: Line[], private readonly source: string) {}
  parse(): SyntaxTree {
    const statements = this.block(0, true);
    const span = this.input[0]?.span ?? { start: 0, end: this.source.length, line: 1, column: 1 };
    return { statements, functions: this.functions, span: { ...span, end: this.source.length } };
  }
  private suite(parentIndent: number): Statement[] {
    const next = this.input[this.cursor];
    if (!next || next.indent <= parentIndent) throw new LanguageError('Esperado um bloco indentado', next?.span ?? this.input[this.cursor - 1]!.span);
    return this.block(next.indent, false);
  }
  private block(indent: number, top: boolean): Statement[] {
    if (++this.depth > 128) throw new LanguageError('Limite de aninhamento sintático excedido', this.input[this.cursor]!.span);
    const body: Statement[] = [];
    try {
      while (this.cursor < this.input.length) {
        const line = this.input[this.cursor]!;
        if (line.indent < indent) break;
        if (line.indent > indent) throw new LanguageError('Indentação inesperada ou inconsistente', line.span);
        const expression = new Expressions(lex(line));
        this.cursor++;
        if (expression.match('def')) {
          if (!top) throw new LanguageError('Funções aninhadas ou condicionais ainda não são suportadas', line.span);
          const name = expression.name().text;
          expression.expect('(');
          const params: string[] = [];
          if (expression.current.text !== ')') do {
            const parameter = expression.name();
            if (params.includes(parameter.text)) throw new LanguageError('Parâmetro duplicado', parameter.span);
            params.push(parameter.text);
          } while (expression.match(',') && expression.current.text !== ')');
          expression.expect(')'); expression.expect(':'); expression.end();
          const fnBody = this.suite(indent);
          this.functions.push({ name, params, body: fnBody, span: line.span });
          body.push({ kind: 'define', name, span: line.span });
        } else if (expression.match('if')) {
          body.push(this.conditional(line, expression));
        } else if (expression.match('while')) {
          const condition = expression.expression(); expression.expect(':'); expression.end();
          const loop = this.suite(indent);
          body.push({ kind: 'while', condition, body: loop, span: line.span });
        } else if (expression.match('return')) {
          const value: Expression = expression.current.kind === 'end' ? { kind: 'literal', value: null, span: line.span } : expression.expression();
          expression.end(); body.push({ kind: 'return', value, span: line.span });
        } else if (expression.match('pass')) { expression.end(); }
        else if (expression.current.kind === 'name' && ['=', '+=', '-=', '*=', '/=', '//=', '%=', '**='].includes(expression.tokens[1]?.text ?? '')) {
          const name = expression.name();
          const operator = expression.take().text;
          let value = expression.expression(); expression.end();
          if (operator !== '=') value = { kind: 'binary', operator: operator.slice(0, -1), left: { kind: 'variable', name: name.text, span: name.span }, right: value, span: line.span };
          body.push({ kind: 'set', name: name.text, value, span: line.span });
        } else {
          if (reserved.has(expression.current.text)) throw new LanguageError(`Recurso Python ainda não suportado: ${expression.current.text}`, expression.current.span);
          const value = expression.expression(); expression.end();
          body.push({ kind: 'expression', value, span: line.span });
        }
      }
      return body;
    } finally { this.depth--; }
  }
  private conditional(line: Line, expression: Expressions): Statement {
    if (++this.clauseDepth > 128) throw new LanguageError('Limite de aninhamento de condicionais excedido', line.span);
    try {
    const condition = expression.expression(); expression.expect(':'); expression.end();
    const then = this.suite(line.indent);
    let otherwise: Statement[] = [];
    const next = this.input[this.cursor];
    if (next && next.indent === line.indent) {
      const clause = new Expressions(lex(next));
      if (clause.match('elif')) { this.cursor++; otherwise = [this.conditional(next, clause)]; }
      else if (clause.match('else')) { this.cursor++; clause.expect(':'); clause.end(); otherwise = this.suite(line.indent); }
    }
    return { kind: 'if', condition, then, otherwise, span: line.span };
    } finally { this.clauseDepth--; }
  }
}

export function parsePython(source: string): SyntaxTree {
  validateSourceSize(source);
  return new PythonParser(lines(source), source).parse();
}
