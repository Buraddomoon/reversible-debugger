import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DebugSession } from '../src/core/debugger';
import { initialState } from '../src/core/machine';
import { MAX_SOURCE_CHARS } from '../src/core/language';
import { formatValue, getRuntime } from '../src/core/runtime';

const example = (name: string) => readFileSync(new URL(`../examples/python-${name}.py`, import.meta.url), 'utf8');
const python = (source: string) => new DebugSession(source, { language: 'python', version: '3' });
const clone = (session: DebugSession) => structuredClone(session.state);
function finish(session: DebugSession) { while (session.canForward) session.runBatch(); return session; }

describe('Python 3 no núcleo reversível', () => {
  it.each([['sum-bug', 10n], ['sum-fixed', 15n], ['factorial', 120n]])('executa %s, desfaz tudo e reaplica sem mudar o histórico', (name, expected) => {
    const session = python(example(String(name)));
    const states = [clone(session)];
    while (session.canForward) { session.forward(); states.push(clone(session)); }
    expect(session.state.frames[0]!.locals.result).toBe(expected);
    const records = [...session.history];
    for (let i = states.length - 2; i >= 0; i--) { session.backward(); expect(clone(session)).toEqual(states[i]); }
    expect(clone(session)).toEqual(initialState());
    for (let i = 1; i < states.length; i++) { session.forward(); expect(clone(session)).toEqual(states[i]); }
    expect(session.history).toEqual(records);
  });
  it('preserva inteiros além da precisão do JavaScript', () => {
    const session = finish(python('result = 9007199254740993 + 1'));
    expect(session.state.frames[0]!.locals.result).toBe(9007199254740994n);
    session.rewind(); finish(session);
    expect(session.state.frames[0]!.locals.result).toBe(9007199254740994n);
  });
  it('não lê uma global quando uma atribuição torna o nome local em toda a função', () => {
    const session = finish(python('x = 10\ndef f():\n    y = x\n    x = 1\n    return y\nresult = f()'));
    expect(session.state.control.error).toContain('local ainda não inicializada: x');
    const fault = clone(session); session.backward(); expect(session.state.control.status).toBe('running');
    session.forward(); expect(clone(session)).toEqual(fault);
  });
  it('só disponibiliza a função depois que def foi executado', () => {
    const session = finish(python('result = f()\ndef f():\n    return 42'));
    expect(session.state.control.error).toContain('Variável inexistente: f');
  });
  it('avalia a função antes dos argumentos e respeita a sombra de builtins em execução', () => {
    expect(finish(python('result = missing(1 / 0)')).state.control.error).toContain('Variável inexistente: missing');
    const session = finish(python('before = abs(-2)\ndef abs(x):\n    return x + 10\nresult = before + abs(3)'));
    expect(session.state.frames[0]!.locals.result).toBe(15n);
    expect(finish(python('f = abs\nresult = f(-5)')).state.frames[0]!.locals.result).toBe(5n);
  });
  it('valida aridade e nomes chamáveis em execução', () => {
    expect(finish(python('def f(x):\n    return x\nresult = f()')).state.control.error).toContain('espera 1 argumento');
    expect(finish(python('f = 42\nresult = f()')).state.control.error).toContain('não é uma função');
  });
  it('atribuições locais não alteram os globais e funções podem ler globais', () => {
    const session = finish(python('x = 10\ndef f(x):\n    x += 1\n    return x\ndef g():\n    return x\nresult = f(2) + g()'));
    expect(session.state.frames[0]!.locals.result).toBe(13n);
    expect(session.state.frames[0]!.locals.x).toBe(10n);
  });
  it('chama aliases e funções recebidas por parâmetro sem closures', () => {
    const session = finish(python('def double(x):\n    return x * 2\ndef apply(f, x):\n    return f(x)\nother = double\nresult = apply(other, 21)'));
    expect(session.state.frames[0]!.locals.result).toBe(42n);
  });
  it('retorna None implicitamente, aceita return vazio e blocos pass', () => {
    expect(finish(python('def f():\n    pass\nresult = f()')).state.frames[0]!.locals.result).toBeNull();
    expect(finish(python('def f():\n    return\nresult = f()')).state.frames[0]!.locals.result).toBeNull();
  });
  it('registra print na memória reversível e remove a saída ao desfazer', () => {
    const session = python('result = 42\nprint(result, True, None, 1e30, 1e-7)\nprint()');
    const states = [clone(session)];
    while (session.canForward) { session.forward(); states.push(clone(session)); }
    expect(session.state.output.join('')).toBe('42 True None 1e+30 1e-07\n\n');
    for (let i = states.length - 2; i >= 0; i--) { session.backward(); expect(clone(session)).toEqual(states[i]); }
    expect(session.state.output).toEqual([]);
    finish(session); expect(session.state.output.join('')).toBe('42 True None 1e+30 1e-07\n\n');
  });
  it('preserva o sinal correto em abs(-0.0) e a formatação Python', () => {
    const session = finish(python('result = abs(-0.0)'));
    expect(Object.is(session.state.frames[0]!.locals.result, 0)).toBe(true);
    expect(formatValue(-0, 'python')).toBe('-0.0');
    expect(formatValue(1e30, 'python')).toBe('1e+30');
    expect(formatValue(1e-7, 'python')).toBe('1e-07');
  });
  it('respeita comentários, CRLF, chamadas multilinha e posições do arquivo original', () => {
    const session = python('# comentário\r\ndef double(x):\r\n    return x * 2\r\nresult = double(\r\n    21, # argumento\r\n)\r\n');
    finish(session); expect(session.state.frames[0]!.locals.result).toBe(42n);
    const argument = session.history.find(step => step.op === 'PUSH' && step.span.line === 5)!;
    expect(session.program.source.slice(argument.span.start, argument.span.end)).toBe('21');
  });
  it.each([
    ['import os', 'import'], ['result = [1, 2]', 'suportado'], ['def f():\nreturn 1', 'indentado'],
    ['  result = 1', 'Indentação'], ['result = 0 < 1 < 2', 'encadeadas'],
    ['def f(x, x):\n    pass', 'Parâmetro duplicado'], ['result = 012', 'zeros à esquerda'],
    ['def f():\n\treturn 1', 'tabulações'], ['result = (1 + 2', 'não foi fechado'],
  ])('diagnostica recursos ou sintaxe inválidos: %s', (source, message) => {
    expect(() => python(source)).toThrow(message);
    expect(() => python(source)).toThrow(/linha \d+, coluna \d+/);
  });
  it('mantém divisão por zero e limites aritméticos atômicos e reversíveis', () => {
    for (const source of ['result = 1 / 0', 'result = 1 // 0', 'result = 1 % 0', 'result = 2 ** 1000000000', 'result = int(None)']) {
      const session = python(source);
      let before = clone(session);
      while (session.canForward) { before = clone(session); session.forward(); }
      expect(session.state.control.status).toBe('error');
      expect(session.state.operands).toEqual(before.operands);
      expect(session.state.frames).toEqual(before.frames);
      const error = clone(session); session.backward(); expect(clone(session)).toEqual(before);
      session.forward(); expect(clone(session)).toEqual(error);
    }
  });
  it('rejeita cadeias de elif excessivas com diagnóstico da linguagem', () => {
    expect(() => python('if False:\n    pass\n' + 'elif False:\n    pass\n'.repeat(130))).toThrow('condicionais');
  });
  it('retrocede em lotes até o estado exato inicial e mantém os registros para replay', () => {
    const session = finish(python(example('factorial'))), final = clone(session), count = session.history.length;
    while (session.canBackward) expect(session.backwardBatch(3)).toBeGreaterThan(0);
    expect(clone(session)).toEqual(initialState()); expect(session.history).toHaveLength(count);
    expect(session.backwardBatch(3)).toBe(0);
    finish(session); expect(clone(session)).toEqual(final);
    expect(() => session.backwardBatch(0)).toThrow('lote');
  });
  it('reinicia a execução e apaga apenas o estado/histórico, preservando o programa e seu código', () => {
    const session = finish(python('result = 42\nprint(result)'));
    const program = session.program;
    expect(session.history.length).toBeGreaterThan(0);
    session.restart();
    expect(session.program).toBe(program);
    expect(session.state).toEqual(initialState());
    expect(session.cursor).toBe(0); expect(session.history).toHaveLength(0);
    finish(session);
    expect(session.state.frames[0]!.locals.result).toBe(42n);
    expect(session.state.output).toEqual(['42\n']);
  });
  it('aceita 1 milhão de caracteres, compila expressões longas e rejeita apenas acima do limite', () => {
    const program = '#'.concat('x'.repeat(MAX_SOURCE_CHARS - 'result = 42\n'.length - 2), '\nresult = 42\n');
    expect(program).toHaveLength(MAX_SOURCE_CHARS);
    expect(finish(python(program)).state.frames[0]!.locals.result).toBe(42n);
    expect(() => python(`${program} `)).toThrow('1.000.000');
    const expression = `result = ${Array.from({ length: 3000 }, () => '1').join(' + ')}`;
    expect(finish(python(expression)).state.frames[0]!.locals.result).toBe(3000n);
  });
  it('recusa linguagens e versões indisponíveis em vez de executar com outro parser', () => {
    expect(() => new DebugSession('result = 1', { language: 'javascript' })).toThrow('não suportada');
    expect(() => new DebugSession('result = 1', { language: 'python', version: '2' })).toThrow('não suportada');
    expect(getRuntime('python')).toEqual({ language: 'python', version: '3' });
    expect(formatValue(12345678901234567890n, 'python')).toBe('12345678901234567890');
    expect(formatValue(true, 'python')).toBe('True'); expect(formatValue(null, 'python')).toBe('None');
  });
  it('navegação gerada em Python corresponde ao estado completo de cada cursor', () => {
    fc.assert(fc.property(fc.constantFrom('sum-bug', 'sum-fixed', 'factorial'), fc.array(fc.boolean(), { minLength: 50, maxLength: 180 }), (name, moves) => {
      const reference = python(example(name)), states = [clone(reference)];
      while (reference.canForward) { reference.forward(); states.push(clone(reference)); }
      const session = python(example(name));
      for (const forward of moves) { if (forward) session.forward(); else session.backward(); expect(clone(session)).toEqual(states[session.cursor]); }
    }), { seed: 20261008, numRuns: 100 });
  });
});

const native = spawnSync('python3', ['--version'], { timeout: 10_000 });
describe.skipIf(native.status !== 0)('comparação com o Python já instalado (sem instalações)', () => {
  it('produz os mesmos valores e tipos nos recursos suportados', () => {
    const sources = [
      ...['-7 // 3', '7 // -3', '-7 % 3', '7 % -3', '1.0 // 0.1', '1.0 % 0.1', '2 ** 80', '-2 ** 2', '2 ** -2', '2 ** 3 ** 2', 'True + 2', 'True == 1', '9007199254740993 > 9007199254740992.0', '0 or 5', '3 and 4', 'False and (1 / 0)', 'True or (1 / 0)', 'not 0 < 1', '(1 < 2) == True', 'None == 0', 'abs(-5)', 'int(-2.9)', 'float(4)', 'bool(None)', 'int()', 'float()', 'bool()', '0xFF + 0b10 + 0o7', '1e2 + .5'].map(expression => `result = ${expression}`),
      'x = 0\nif x:\n    result = 1\nelif x == 0:\n    result = 2\nelse:\n    result = 3',
      'def f():\n    return\nresult = f()', example('sum-bug'), example('sum-fixed'), example('factorial'),
    ];
    const oracle = spawnSync('python3', ['-c', 'import json, sys\nresults = []\nfor source in json.loads(sys.argv[1]):\n    scope = {}\n    exec(source, scope)\n    value = scope["result"]\n    results.append({"type": type(value).__name__, "value": str(value)})\nprint(json.dumps(results))', JSON.stringify(sources)], { encoding: 'utf8', timeout: 10_000 });
    expect(oracle.status, oracle.stderr).toBe(0);
    const results = JSON.parse(oracle.stdout) as Array<{ type: string; value: string }>;
    sources.forEach((source, index) => {
      const session = finish(python(source));
      expect(session.state.control.status, source).toBe('halted');
      const value = session.state.frames[0]!.locals.result;
      const expected = results[index]!;
      if (expected.type === 'int') expect(value, source).toBe(BigInt(expected.value));
      else if (expected.type === 'float') expect(value, source).toBe(Number(expected.value));
      else if (expected.type === 'bool') expect(value, source).toBe(expected.value === 'True');
      else expect(value, source).toBeNull();
    });
  });
});
