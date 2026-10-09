import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DebugSession, HistoryLimitError } from '../src/core/debugger';
import { compile } from '../src/core/compiler';
import { initialState } from '../src/core/machine';

const source = (name: string) => readFileSync(new URL(`../examples/${name}.rw`, import.meta.url), 'utf8');
const snapshot = (session: DebugSession) => structuredClone(session.state);
function finish(session: DebugSession) {
  while (session.canForward) session.runBatch();
  return session;
}
function snapshots(session: DebugSession) {
  const states = [snapshot(session)];
  while (session.canForward) { session.forward(); states.push(snapshot(session)); }
  return states;
}

describe('semântica da linguagem', () => {
  it.each([
    ['sum-bug', 10], ['sum-fixed', 15], ['factorial', 120], ['euclid', 6],
  ])('%s produz %s', (name, result) => {
    const session = finish(new DebugSession(source(String(name))));
    expect(session.state.control.status).toBe('halted');
    expect(session.state.frames).toHaveLength(1);
    expect(session.state.operands).toEqual([]);
    expect(session.state.frames[0]!.locals.result).toBe(result);
  });
  it('respeita precedência, associatividade, decimais, sinal e comentários', () => {
    const session = finish(new DebugSession('// comentário\nlet result = 20 - 4 - 2 * (3 + 1) + -0.5;'));
    expect(session.state.frames[0]!.locals.result).toBe(7.5);
  });
  it('executa ambos os caminhos condicionais e operadores booleanos', () => {
    const session = finish(new DebugSession('fn choose(x) { if (!(x == 1)) { return false; } else { return true; } } let yes = choose(1); let no = choose(2);'));
    expect(session.state.frames[0]!.locals).toMatchObject({ yes: true, no: false });
  });
  it('mantém escopo lexical por função, permite sombra e altera globais explicitamente', () => {
    const session = finish(new DebugSession('let x = 10; let y = 0; fn inner() { return x; } fn outer(x) { y = x; return inner() + x; } let result = outer(2);'));
    expect(session.state.frames[0]!.locals).toMatchObject({ x: 10, y: 2, result: 12 });
  });
  it('preserva operandos do chamador em chamadas dentro de expressões', () => {
    const session = finish(new DebugSession('fn double(x) { return x * 2; } let result = 10 + double(3) * double(double(2));'));
    expect(session.state.frames[0]!.locals.result).toBe(58);
  });
  it('define retorno implícito como zero e descarta chamadas usadas como comando', () => {
    const session = finish(new DebugSession('fn empty() { let x = 1; } empty(); let result = empty();'));
    expect(session.state.frames[0]!.locals.result).toBe(0);
    expect(session.state.operands).toEqual([]);
  });
  it('aceita identificadores que coincidem com propriedades de objetos JavaScript', () => {
    const session = new DebugSession('fn constructor(__proto__) { let toString = 2; __proto__ = __proto__ + toString; return __proto__; } let __proto__ = 8; let result = constructor(__proto__);');
    const states = snapshots(session);
    expect(session.state.frames[0]!.locals.result).toBe(10);
    session.rewind();
    for (let i = 1; i < states.length; i++) { session.forward(); expect(snapshot(session)).toEqual(states[i]); }
  });
  it.each([
    ['let x = ;', 'expressão'], ['fn x(a, a) { return a; }', 'Parâmetro duplicado'],
    ['fn x() {} fn x() {}', 'Função duplicada'], ['let x = missing();', 'Função inexistente'],
    ['fn x(a) { return a; } let result = x();', 'espera 1 argumento'],
    ['return 1;', 'dentro de uma função'], ['let while = 1;', 'identificador'],
    ['let x = 1', "Esperado ';'"], ['let x = @;', 'Caractere inesperado'],
  ])('rejeita %s com diagnóstico localizado', (program, message) => {
    expect(() => compile(program)).toThrow(message);
    expect(() => compile(program)).toThrow(/linha \d+, coluna \d+/);
  });
  it('limita o tamanho e a profundidade sintática', () => {
    expect(() => compile(' '.repeat(50_001))).toThrow('50.000');
    expect(() => compile(`let x = ${'('.repeat(140)}1${')'.repeat(140)};`)).toThrow('aninhamento');
  });
});

describe('reversibilidade de todo o estado', () => {
  it.each(['sum-bug', 'sum-fixed', 'factorial', 'euclid', 'runtime-error'])('desfaz e reaplica cada instrução de %s', name => {
    const session = new DebugSession(source(name));
    const states = snapshots(session);
    const history = JSON.stringify(session.history);
    for (let i = states.length - 2; i >= 0; i--) {
      session.backward(); expect(snapshot(session)).toEqual(states[i]); expect(session.cursor).toBe(i);
    }
    expect(snapshot(session)).toEqual(initialState());
    expect(session.backward()).toBeNull();
    for (let i = 1; i < states.length; i++) {
      session.forward(); expect(snapshot(session)).toEqual(states[i]);
    }
    expect(session.forward()).toBeNull();
    expect(JSON.stringify(session.history)).toBe(history);
    expect(session.history).toHaveLength(states.length - 1);
  });
  it('restaura identificadores, pontos de retorno e temporários de chamadas recursivas', () => {
    const session = new DebugSession(source('factorial'));
    let calls = 0, returns = 0;
    while (session.canForward) {
      const before = snapshot(session);
      const step = session.forward()!;
      const after = snapshot(session);
      if (step.op === 'CALL' || step.op === 'RETURN') {
        if (step.op === 'CALL') calls++; else returns++;
        session.backward(); expect(snapshot(session)).toEqual(before);
        session.forward(); expect(snapshot(session)).toEqual(after);
      }
    }
    expect(calls).toBe(5); expect(returns).toBe(5);
  });
  it('remove uma declaração ao desfazer e preserva o valor -0', () => {
    const session = new DebugSession('let x = -0;');
    session.forward(); session.forward(); session.forward();
    expect(Object.is(session.state.frames[0]!.locals.x, -0)).toBe(true);
    session.backward(); expect(Object.hasOwn(session.state.frames[0]!.locals, 'x')).toBe(false);
    session.forward(); expect(Object.is(session.state.frames[0]!.locals.x, -0)).toBe(true);
  });
  it('mantém os registros imutáveis sem guardar snapshots da máquina', () => {
    const session = finish(new DebugSession(source('factorial')));
    expect(Object.isFrozen(session.program)).toBe(true);
    for (const step of session.history) {
      expect(Object.isFrozen(step)).toBe(true);
      expect(Object.isFrozen(step.changes)).toBe(true);
      expect(step).not.toHaveProperty('state');
      expect(step).not.toHaveProperty('snapshot');
    }
  });
  it('usa deltas de tamanho constante nas atribuições independentemente das demais variáveis', () => {
    const size = (locals: number) => {
      const session = finish(new DebugSession(`${Array.from({ length: locals }, (_, i) => `let v${i} = ${i};`).join('\n')} let x = 0; x = 1;`));
      return JSON.stringify(session.history.find(step => step.op === 'STORE')!.changes).length;
    };
    expect(Math.abs(size(10) - size(1000))).toBeLessThan(20); // Only program-counter digit widths grow.
  });
  it('preserva histórico ao reiniciar e permite reaplicar sem duplicar registros', () => {
    const session = finish(new DebugSession(source('sum-bug')));
    const final = snapshot(session), history = session.history.length;
    session.rewind(); expect(session.cursor).toBe(0); expect(session.history).toHaveLength(history);
    finish(session); expect(snapshot(session)).toEqual(final); expect(session.history).toHaveLength(history);
  });
});

describe('erros e limites', () => {
  it.each([
    ['let result = 1 / 0;', 'Divisão por zero'], ['let result = 1 % 0;', 'Divisão por zero'],
    ['let result = absent;', 'Variável inexistente'], ['let x = 1; let x = 2;', 'já declarada'],
    ['x = 2;', 'Variável inexistente'], ['let result = true + 1;', 'exige números'],
    ['if (1) { let x = 1; }', 'precisa ser booleana'], ['let result = !1;', 'exige um booleano'],
    ['let result = true == 1;', 'mesmo tipo'],
    ['let result = 100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000 * 10;', 'intervalo finito'],
  ])('erros em %s são atômicos e reversíveis', (program, message) => {
    const session = new DebugSession(program);
    let before = snapshot(session);
    while (session.canForward) { before = snapshot(session); session.forward(); }
    expect(session.state.control.status).toBe('error');
    expect(session.state.control.error).toContain(message);
    expect(session.state.frames).toEqual(before.frames);
    expect(session.state.operands).toEqual(before.operands);
    const error = snapshot(session);
    session.backward(); expect(snapshot(session)).toEqual(before);
    session.forward(); expect(snapshot(session)).toEqual(error);
  });
  it('limita chamadas recursivas sem depender da pilha do JavaScript', () => {
    const session = finish(new DebugSession('fn recurse() { return recurse(); } let x = recurse();', { maxFrames: 8 }));
    expect(session.state.frames).toHaveLength(8);
    expect(session.state.control.error).toContain('8 frames');
    session.backward(); expect(session.state.control.status).toBe('running');
  });
  it('limita loops infinitos sem perder a possibilidade de voltar e reaplicar', () => {
    const session = new DebugSession('while (true) {}', { maxSteps: 30 });
    for (let i = 0; i < 30; i++) session.forward();
    const boundary = snapshot(session);
    expect(() => session.forward()).toThrow(HistoryLimitError);
    expect(snapshot(session)).toEqual(boundary);
    session.backward(); session.forward(); expect(snapshot(session)).toEqual(boundary);
    session.rewind(); expect(snapshot(session)).toEqual(initialState());
  });
});

describe('propriedades geradas', () => {
  it('executa somas e restaura o estado inicial para diferentes limites e incrementos', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 25 }), fc.integer({ min: -8, max: 8 }), (limit, increment) => {
      const session = new DebugSession(`fn sum(n) { let i = 0; let total = 0; while (i < n) { total = total + ${increment}; i = i + 1; } return total; } let result = sum(${limit});`);
      const states = snapshots(session);
      expect(session.state.frames[0]!.locals.result).toBe(limit * increment || 0);
      for (let i = states.length - 2; i >= 0; i--) { session.backward(); expect(snapshot(session)).toEqual(states[i]); }
    }), { numRuns: 100, seed: 20261006 });
  });
  it('qualquer sequência de avançar e voltar corresponde ao estado do cursor', () => {
    fc.assert(fc.property(
      fc.constantFrom('sum-bug', 'sum-fixed', 'factorial', 'euclid', 'runtime-error'),
      fc.array(fc.boolean(), { minLength: 30, maxLength: 250 }),
      (name, moves) => {
        const oracle = new DebugSession(source(name)), states = snapshots(oracle);
        const session = new DebugSession(source(name));
        for (const forward of moves) {
          if (forward) session.forward(); else session.backward();
          expect(snapshot(session)).toEqual(states[session.cursor]);
        }
      },
    ), { numRuns: 150, seed: 424242 });
  });
});
