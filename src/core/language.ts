/** The complete front end for the intentionally small Rewind language. */
export interface Span { start: number; end: number; line: number; column: number }
export type Value = number | boolean;
export class LanguageError extends Error {
  constructor(message: string, public readonly span: Span) {
    super(`${message} (linha ${span.line}, coluna ${span.column})`);
    this.name = 'LanguageError';
  }
}
interface Token { text: string; kind: 'number' | 'name' | 'symbol' | 'eof'; span: Span }
export type Expression =
  | { kind: 'literal'; value: Value; span: Span }
  | { kind: 'variable'; name: string; span: Span }
  | { kind: 'unary'; operator: string; operand: Expression; span: Span }
  | { kind: 'binary'; operator: string; left: Expression; right: Expression; span: Span }
  | { kind: 'call'; name: string; args: Expression[]; span: Span };
export type Statement =
  | { kind: 'let' | 'assign'; name: string; value: Expression; span: Span }
  | { kind: 'if'; condition: Expression; then: Statement[]; otherwise: Statement[]; span: Span }
  | { kind: 'while'; condition: Expression; body: Statement[]; span: Span }
  | { kind: 'return'; value: Expression; span: Span }
  | { kind: 'expression'; value: Expression; span: Span };
export interface FunctionNode { name: string; params: string[]; body: Statement[]; span: Span }
export interface SyntaxTree { statements: Statement[]; functions: FunctionNode[]; span: Span }

const keywords = new Set(['fn', 'let', 'if', 'else', 'while', 'return', 'true', 'false']);
const precedence: Record<string, number> = {
  '==': 1, '!=': 1, '<': 2, '<=': 2, '>': 2, '>=': 2,
  '+': 3, '-': 3, '*': 4, '/': 4, '%': 4,
};
const combine = (start: Span, end: Span): Span => ({ ...start, end: end.end });

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0, line = 1, column = 1;
  const advance = () => {
    if (source[offset] === '\n') { line++; column = 1; } else { column++; }
    offset++;
  };
  while (offset < source.length) {
    const char = source[offset]!;
    if (/\s/.test(char)) { advance(); continue; }
    if (source.slice(offset, offset + 2) === '//') {
      while (offset < source.length && source[offset] !== '\n') advance();
      continue;
    }
    const start = { start: offset, end: offset, line, column };
    const remaining = source.slice(offset);
    const numeric = /^\d+(?:\.\d+)?/.exec(remaining);
    const name = /^[A-Za-z_][A-Za-z_0-9]*/.exec(remaining);
    let text: string;
    let kind: Token['kind'];
    if (numeric) { text = numeric[0]; kind = 'number'; }
    else if (name) { text = name[0]; kind = 'name'; }
    else {
      const pair = remaining.slice(0, 2);
      text = ['==', '!=', '<=', '>='].includes(pair) ? pair : char;
      if (!['==', '!=', '<=', '>=', '+', '-', '*', '/', '%', '<', '>', '=', '!', '(', ')', '{', '}', ',', ';'].includes(text)) {
        throw new LanguageError(`Caractere inesperado: ${char}`, { ...start, end: offset + 1 });
      }
      kind = 'symbol';
    }
    for (let i = 0; i < text.length; i++) advance();
    tokens.push({ text, kind, span: { ...start, end: offset } });
  }
  tokens.push({ text: '<fim>', kind: 'eof', span: { start: offset, end: offset, line, column } });
  return tokens;
}

class Parser {
  private cursor = 0;
  private nesting = 0;
  constructor(private readonly tokens: Token[]) {}
  private get current(): Token { return this.tokens[this.cursor]!; }
  private take(): Token { return this.tokens[this.cursor++]!; }
  private match(text: string): boolean {
    if (this.current.text !== text) return false;
    this.take(); return true;
  }
  private expect(text: string): Token {
    if (this.current.text !== text) throw new LanguageError(`Esperado '${text}', encontrado '${this.current.text}'`, this.current.span);
    return this.take();
  }
  private name(): Token {
    if (this.current.kind !== 'name' || keywords.has(this.current.text)) {
      throw new LanguageError('Esperado um identificador', this.current.span);
    }
    return this.take();
  }
  /** Bound parser nesting independently of program execution. */
  private nested<T>(work: () => T): T {
    if (++this.nesting > 128) throw new LanguageError('Limite de aninhamento sintático excedido', this.current.span);
    try { return work(); } finally { this.nesting--; }
  }
  parse(): SyntaxTree {
    const statements: Statement[] = [], functions: FunctionNode[] = [];
    const first = this.current.span;
    while (this.current.kind !== 'eof') {
      if (this.current.text === 'fn') functions.push(this.function());
      else statements.push(this.statement());
    }
    return { statements, functions, span: combine(first, this.current.span) };
  }
  private function(): FunctionNode {
    const start = this.expect('fn');
    const name = this.name().text;
    this.expect('(');
    const params: string[] = [];
    if (this.current.text !== ')') {
      do {
        const param = this.name();
        if (params.includes(param.text)) throw new LanguageError(`Parâmetro duplicado: ${param.text}`, param.span);
        params.push(param.text);
      } while (this.match(','));
    }
    this.expect(')');
    const block = this.block();
    return { name, params, body: block.body, span: combine(start.span, block.end) };
  }
  private block(): { body: Statement[]; end: Span } {
    return this.nested(() => {
      this.expect('{');
      const body: Statement[] = [];
      while (this.current.text !== '}' && this.current.kind !== 'eof') body.push(this.statement());
      return { body, end: this.expect('}').span };
    });
  }
  private statement(): Statement {
    const start = this.current;
    if (this.match('let')) {
      const name = this.name().text;
      this.expect('=');
      const value = this.expression();
      return { kind: 'let', name, value, span: combine(start.span, this.expect(';').span) };
    }
    if (this.match('if')) {
      this.expect('('); const condition = this.expression(); this.expect(')');
      const then = this.block();
      const otherwise = this.match('else') ? this.block() : null;
      return { kind: 'if', condition, then: then.body, otherwise: otherwise?.body ?? [], span: combine(start.span, otherwise?.end ?? then.end) };
    }
    if (this.match('while')) {
      this.expect('('); const condition = this.expression(); this.expect(')');
      const block = this.block();
      return { kind: 'while', condition, body: block.body, span: combine(start.span, block.end) };
    }
    if (this.match('return')) {
      const value = this.expression();
      return { kind: 'return', value, span: combine(start.span, this.expect(';').span) };
    }
    if (this.current.kind === 'name' && this.tokens[this.cursor + 1]?.text === '=') {
      const name = this.name().text; this.expect('=');
      const value = this.expression();
      return { kind: 'assign', name, value, span: combine(start.span, this.expect(';').span) };
    }
    const value = this.expression();
    return { kind: 'expression', value, span: combine(start.span, this.expect(';').span) };
  }
  private expression(minimum = 1): Expression {
    return this.nested(() => {
      let left = this.primary();
      while ((precedence[this.current.text] ?? 0) >= minimum) {
        const operator = this.take().text;
        const right = this.expression(precedence[operator]! + 1);
        left = { kind: 'binary', operator, left, right, span: combine(left.span, right.span) };
      }
      return left;
    });
  }
  private primary(): Expression {
    const token = this.current;
    if (this.match('-') || this.match('!')) {
      const operand = this.nested(() => this.primary());
      return { kind: 'unary', operator: token.text, operand, span: combine(token.span, operand.span) };
    }
    if (this.match('(')) {
      const expression = this.expression(); this.expect(')'); return expression;
    }
    if (token.kind === 'number') {
      this.take();
      const value = Number(token.text);
      if (!Number.isFinite(value)) throw new LanguageError('Número fora do intervalo finito', token.span);
      return { kind: 'literal', value, span: token.span };
    }
    if (this.match('true') || this.match('false')) return { kind: 'literal', value: token.text === 'true', span: token.span };
    if (token.kind === 'name' && !keywords.has(token.text)) {
      const name = this.name().text;
      if (!this.match('(')) return { kind: 'variable', name, span: token.span };
      const args: Expression[] = [];
      if (this.current.text !== ')') do { args.push(this.expression()); } while (this.match(','));
      return { kind: 'call', name, args, span: combine(token.span, this.expect(')').span) };
    }
    throw new LanguageError(`Esperada uma expressão, encontrado '${token.text}'`, token.span);
  }
}

export function parse(source: string): SyntaxTree {
  if (source.length > 50_000) throw new LanguageError('O programa excede o limite de 50.000 caracteres', { start: 0, end: 0, line: 1, column: 1 });
  return new Parser(tokenize(source)).parse();
}
