import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { DebugSession } from '../src/core/debugger';
import { ExecutionComparison } from '../src/core/comparison';
import { alignComparison } from '../src/core/comparison-alignment';
import type { ComparisonPoint, ComparisonSource } from '../src/core/comparison-types';
import * as machine from '../src/core/machine';

const example = (name: string) => readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8');
const input = (source: string, language = 'python'): ComparisonSource => ({ name: 'Teste', source, language });
function ready(comparison: ExecutionComparison, batch = 31) {
  let ticks = 0;
  while (!comparison.ready) { comparison.prepareBatch(batch); if (++ticks > 10000) throw new Error('Preparação não terminou'); }
  return comparison;
}
function states(source: string, language: string) {
  const session = new DebugSession(source, { language });
  const result = [structuredClone(session.state)];
  while (session.canForward) { session.forward(); result.push(structuredClone(session.state)); }
  return result;
}

describe('alinhamento de execuções', () => {
  it.each(['python', 'rewind'])('mostra a decisão divergente na quinta condição em %s, antes de mudar os locais', language => {
    const names = language === 'python' ? ['python-sum-bug.py', 'python-sum-fixed.py'] : ['sum-bug.rw', 'sum-fixed.rw'];
    const comparison = ready(new ExecutionComparison(input(example(names[0]!), language), input(example(names[1]!), language)));
    expect(comparison.firstDifference).not.toBeNull();
    expect(comparison.left.finalResult).toEqual({ present: true, value: language === 'python' ? 10n : 10 });
    expect(comparison.right.finalResult).toEqual({ present: true, value: language === 'python' ? 15n : 15 });
    expect(comparison.left.state.frames[0]!.locals).not.toHaveProperty('result');
    comparison.seekRow(comparison.firstDifference!);
    const row = comparison.rows[comparison.cursor]!;
    const a = comparison.left.points[row.leftPoint!]!, b = comparison.right.points[row.rightPoint!]!;
    expect(a.phase).toBe('decision'); expect(b.phase).toBe('decision');
    expect(a.occurrence).toBe(5); expect(b.occurrence).toBe(5);
    expect(a.outcome).toBe(false); expect(b.outcome).toBe(true);
    expect(comparison.left.state.frames.at(-1)!.locals.i).toBe(language === 'python' ? 5n : 5);
    expect(comparison.left.state.frames).toEqual(comparison.right.state.frames);
    expect(comparison.differences().map(diff => diff.category)).toEqual(['decision']);
    expect(comparison.rows.some(item => item.leftPoint === null && item.rightPoint !== null)).toBe(true);
    const returnRow = comparison.rows.findIndex(item => item.leftPoint !== null && item.rightPoint !== null && comparison.left.points[item.leftPoint]!.phase === 'return');
    comparison.seekRow(returnRow);
    expect(comparison.left.cursor).not.toBe(comparison.right.cursor);
    expect(comparison.differences().some(diff => diff.category === 'operands')).toBe(true);
    comparison.seekRow(comparison.rows.length - 1);
    expect(comparison.left.state.frames[0]!.locals.result).toBe(language === 'python' ? 10n : 10);
    expect(comparison.right.state.frames[0]!.locals.result).toBe(language === 'python' ? 15n : 15);
  });
  it('ignora linhas e endereços de bytecode deslocados por comentários e comandos extras', () => {
    const a = 'def f(n):\n    return n + 1\nresult = f(2)\nprint(result)';
    const b = '# duas linhas extras\n\n' + a;
    const equal = ready(new ExecutionComparison(input(a), input(b)));
    expect(equal.firstDifference).toBeNull();
    expect(equal.left.identity.fingerprint).not.toBe(equal.right.identity.fingerprint);
    const extra = ready(new ExecutionComparison(input(a), input('unused = 0\n' + a)));
    const call = extra.rows.find(row => row.leftPoint !== null && row.rightPoint !== null && extra.left.points[row.leftPoint]!.phase === 'call')!;
    expect(call.leftCursor).not.toBe(call.rightCursor);
    expect(extra.rows.some(row => row.leftPoint === null && row.rightPoint !== null)).toBe(true);
    expect(extra.rows.at(-1)!.leftPoint).not.toBeNull(); expect(extra.rows.at(-1)!.rightPoint).not.toBeNull();
  });
  it('não confunde IDs de frames deslocados por uma chamada extra com chamadas equivalentes', () => {
    const code = 'def f(x):\n    return x + 1\nresult = f(2)';
    const added = 'def unused():\n    return 0\n' + code.replace('result =', 'unused()\nresult =');
    const comparison = ready(new ExecutionComparison(input(code), input(added)));
    const index = comparison.rows.findIndex(row => row.leftPoint !== null && row.rightPoint !== null && comparison.left.points[row.leftPoint]!.phase === 'call');
    comparison.seekRow(index);
    expect(comparison.left.state.frames.at(-1)!.id).toBe(1);
    expect(comparison.right.state.frames.at(-1)!.id).toBe(2);
    expect(comparison.differences().some(diff => diff.category === 'stack')).toBe(false);
  });
  it('distingue comandos idênticos em then/else e não fabrica pares para caminhos diferentes', () => {
    const a = 'if True:\n    x = 1\nelse:\n    x = 2\nresult = x';
    const comparison = ready(new ExecutionComparison(input(a), input(a.replace('True', 'False'))));
    const writes = comparison.rows.filter(row => {
      const point = row.leftPoint === null ? comparison.right.points[row.rightPoint!]! : comparison.left.points[row.leftPoint]!;
      return point.phase === 'write' && point.description.includes('x =');
    });
    expect(writes).toHaveLength(2);
    expect(writes.every(row => row.leftPoint === null || row.rightPoint === null)).toBe(true);
  });
  it('usa uma decisão de fluxo mesmo quando muda o número de decisões internas de curto-circuito', () => {
    const a = 'x = 1\nif x and x:\n    result = 1\nelse:\n    result = 0';
    const comparison = ready(new ExecutionComparison(input(a), input(a.replace('x and x', 'x and x and x'))));
    expect(comparison.firstDifference).toBeNull();
    expect(comparison.left.points.filter(point => point.phase === 'decision')).toHaveLength(1);
    expect(comparison.right.points.filter(point => point.phase === 'decision')).toHaveLength(1);
  });
  it('chaves de pontos são únicas em recursão, chamadas repetidas e chamadas dentro de argumentos', () => {
    const code = example('python-factorial.py') + '\nother = factorial(factorial(3))';
    const comparison = ready(new ExecutionComparison(input(code), input(code)));
    expect(comparison.firstDifference).toBeNull();
    for (const run of [comparison.left, comparison.right]) expect(new Set(run.points.map(point => point.key)).size).toBe(run.points.length);
    expect(comparison.rows.every(row => row.leftPoint !== null && row.rightPoint !== null)).toBe(true);
  });
  it('reencontra a chamada externa quando a função que calcula seu argumento é alterada', () => {
    const a = 'def f(x):\n    return x\ndef h(x):\n    return x + 1\nresult = f(h(3))';
    const comparison = ready(new ExecutionComparison(input(a), input(a.replace('f(h(3))', 'f(f(3))'))));
    const calls = comparison.rows.flatMap((row, index) => row.leftPoint !== null && row.rightPoint !== null && comparison.left.points[row.leftPoint]!.phase === 'call' ? [index] : []);
    expect(calls).toHaveLength(2);
    comparison.seekRow(calls[1]!);
    expect(comparison.left.state.frames.at(-1)!.name).toBe('f');
    expect(comparison.right.state.frames.at(-1)!.name).toBe('f');
    expect(comparison.left.state.frames.at(-1)!.locals.x).toBe(4n);
    expect(comparison.right.state.frames.at(-1)!.locals.x).toBe(3n);
    expect(comparison.differences().some(diff => diff.category === 'stack')).toBe(false);
    expect(comparison.differences().some(diff => diff.category === 'variables')).toBe(true);
  });
  it('preserva ordem e representa cada evento exatamente uma vez ao reencontrar um retorno', () => {
    const point = (key: string, cursor: number): ComparisonPoint => ({ key, cursor, phase: 'write', line: 1, occurrence: 1, description: key, outcome: null });
    const a = ['initial', 'a', 'b', 'return', 'terminal'].map(point);
    const b = ['initial', 'b', 'a', 'extra', 'return', 'terminal'].map(point);
    const rows = alignComparison(a, b);
    expect(rows.flatMap(row => row.leftPoint === null ? [] : [row.leftPoint])).toEqual(a.map((_, i) => i));
    expect(rows.flatMap(row => row.rightPoint === null ? [] : [row.rightPoint])).toEqual(b.map((_, i) => i));
    for (const row of rows) if (row.leftPoint !== null && row.rightPoint !== null) expect(a[row.leftPoint]!.key).toBe(b[row.rightPoint]!.key);
    expect(rows.at(-2)!.leftPoint).toBe(3); expect(rows.at(-2)!.rightPoint).toBe(4);
  });
});

describe('diferenças observáveis e limites', () => {
  it('identifica código/runtime/estado inicial e não guarda snapshots em cada ponto', () => {
    const comparison = ready(new ExecutionComparison(input('result = 1'), input('result = 1')));
    expect(comparison.left.identity).toEqual(comparison.right.identity);
    expect(Object.isFrozen(comparison.left.identity.initial.frames)).toBe(true);
    for (const point of comparison.left.points) {
      expect(Object.isFrozen(point)).toBe(true); expect(point).not.toHaveProperty('state'); expect(point).not.toHaveProperty('snapshot');
    }
    expect(Object.isFrozen(comparison.rows)).toBe(true);
    expect(comparison.firstDifference).toBeNull();
  });
  it.each([
    ['x = 90071992547409931234567890', 'x = 90071992547409931234567891'],
    ['x = -0.0', 'x = 0.0'], ['x = 1', 'x = 1.0'], ['x = None', 'x = 0'],
  ])('compara valores e tipos exatos: %s / %s', (a, b) => {
    const comparison = ready(new ExecutionComparison(input(a), input(b)));
    expect(comparison.firstDifference).not.toBeNull(); comparison.seekRow(comparison.firstDifference!);
    expect(comparison.differences().some(diff => diff.category === 'variables')).toBe(true);
  });
  it('NaN e infinitos iguais, funções e builtins não diferem por identidade de objetos clonados', () => {
    const code = 'x = 1e308 * 1e308\nnan = x - x\nf = print\ndef g():\n    return None\nh = g\nprint(nan)';
    const comparison = ready(new ExecutionComparison(input(code), input(code), { checkpointInterval: 2 }));
    expect(comparison.firstDifference).toBeNull();
  });
  it('mostra saídas e erros em sessões isoladas e restaura o erro ao navegar', () => {
    const a = 'print(1)\nresult = 1 / 0', b = 'print(2)\nresult = 42';
    const comparison = ready(new ExecutionComparison(input(a), input(b)));
    comparison.seekRow(comparison.firstDifference!);
    expect(comparison.differences().some(diff => diff.category === 'output')).toBe(true);
    comparison.seekRow(comparison.rows.length - 1);
    const final = structuredClone(comparison.left.state);
    expect(final.control.status).toBe('error');
    comparison.seekRow(0); expect(comparison.left.state.output).toEqual([]);
    comparison.seekRow(comparison.rows.length - 1); expect(comparison.left.state).toEqual(final);
  });
  it('o limite interrompe a gravação sem transformar o programa em um erro da VM', () => {
    const comparison = ready(new ExecutionComparison(input('while True:\n    pass'), input('while False:\n    pass'), { maxSteps: 17 }));
    expect(comparison.left.limitReached).toBe(true); expect(comparison.left.history).toHaveLength(17);
    expect(comparison.left.points.at(-1)!.phase).toBe('limit');
    comparison.seekRow(comparison.rows.length - 1);
    expect(comparison.left.state.control.status).toBe('running');
    expect(comparison.right.state.control.status).toBe('halted');
    comparison.seekRow(0); expect(comparison.left.cursor).toBe(0);
  });
  it('cancelar para o trabalho e posições inválidas não alteram os estados', () => {
    const comparison = new ExecutionComparison(input('while True:\n    pass'), input('result = 1'));
    comparison.prepareBatch(1); const before = structuredClone(comparison.left.state);
    expect(() => comparison.seekRow(0)).toThrow('preparação');
    comparison.cancel(); comparison.prepareBatch(1000); expect(comparison.stage).toBe('cancelled');
    expect(comparison.left.state).toEqual(before);
    const done = ready(new ExecutionComparison(input('result = 1'), input('result = 2')));
    const initial = structuredClone(done.left.state);
    for (const target of [-1, done.rows.length, 0.5, NaN]) expect(() => done.seekRow(target)).toThrow(RangeError);
    expect(done.left.state).toEqual(initial);
    for (const size of [0, 1001, 1.5]) expect(() => done.prepareBatch(size)).toThrow('lote');
  });
  it('rejeita fontes inválidas e comparação entre runtimes distintos', () => {
    expect(() => new ExecutionComparison(input('result ='), input('result = 1'))).toThrow();
    expect(() => new ExecutionComparison(input('result = 1'), input('let result = 1;', 'rewind'))).toThrow('mesma linguagem');
  });
});

describe('navegação exata nas duas sessões', () => {
  it('cada linha alinhada ou unilateral restaura todos os campos do estado de referência', () => {
    const a = example('python-sum-bug.py'), b = example('python-sum-fixed.py');
    const oracleA = states(a, 'python'), oracleB = states(b, 'python');
    const comparison = ready(new ExecutionComparison(input(a), input(b), { checkpointInterval: 3, maxCheckpoints: 4 }));
    const lengths = [comparison.left.history.length, comparison.right.history.length];
    const execute = vi.spyOn(machine, 'executeInstruction');
    try {
      for (const indexes of [comparison.rows.map((_, i) => i), comparison.rows.map((_, i) => i).reverse()]) {
        for (const index of indexes) {
          comparison.seekRow(index); const row = comparison.rows[index]!;
          expect(structuredClone(comparison.left.state)).toEqual(oracleA[row.leftCursor]);
          expect(structuredClone(comparison.right.state)).toEqual(oracleB[row.rightCursor]);
          expect(comparison.differences()).toHaveLength(row.differenceCount);
        }
      }
      expect(execute).not.toHaveBeenCalled();
      expect([comparison.left.history.length, comparison.right.history.length]).toEqual(lengths);
    } finally { execute.mockRestore(); }
  });
  it('saltos gerados e diferentes tamanhos de lote preservam estados e alinhamento', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 100 }), fc.array(fc.nat({ max: 1000 }), { minLength: 20, maxLength: 60 }), (batch, targets) => {
      const a = example('python-factorial.py'), b = a.replace('factorial(5)', 'factorial(4)');
      const oracleA = states(a, 'python'), oracleB = states(b, 'python');
      const comparison = ready(new ExecutionComparison(input(a), input(b), { checkpointInterval: 4 }), batch);
      for (const target of targets) {
        const index = target % comparison.rows.length; comparison.seekRow(index); const row = comparison.rows[index]!;
        expect(structuredClone(comparison.left.state)).toEqual(oracleA[row.leftCursor]);
        expect(structuredClone(comparison.right.state)).toEqual(oracleB[row.rightCursor]);
      }
    }), { numRuns: 50, seed: 20261011 });
  });
});
