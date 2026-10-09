import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { DebugSession, HistoryLimitError } from '../src/core/debugger';
import { CheckpointHistory } from '../src/core/history';
import { initialState } from '../src/core/machine';
import * as machine from '../src/core/machine';
import { historyEvent } from '../src/core/history-events';

const example = (name: string) => readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8');
const snapshot = (session: DebugSession) => structuredClone(session.state);
function record(session: DebugSession) {
  const states = [snapshot(session)];
  while (session.canForward) { session.forward(); states.push(snapshot(session)); }
  return states;
}

describe('busca exata por cursor', () => {
  it.each([
    ['sum-bug.rw', 'rewind'], ['factorial.rw', 'rewind'], ['runtime-error.rw', 'rewind'],
    ['python-sum-bug.py', 'python'], ['python-factorial.py', 'python'],
  ])('restaura todos os estados de %s a partir das duas pontas', (name, language) => {
    const session = new DebugSession(example(name), { language, checkpointInterval: 5 });
    const states = record(session);
    const history = [...session.history];
    for (let target = 0; target < states.length; target++) {
      for (const origin of [0, states.length - 1]) {
        session.seek(origin); session.seek(target);
        expect(snapshot(session)).toEqual(states[target]);
        expect(session.cursor).toBe(target);
      }
    }
    expect(session.history).toEqual(history);
    expect(session.history.every((step, index) => step === history[index])).toBe(true);
  });
  it('restaura saída, bindings ausentes, inteiros exatos, -0, infinidade e NaN', () => {
    const session = new DebugSession('x = 90071992547409931234567890\ny = -0.0\nz = 1e308 * 1e308\nw = z - z\nprint(x, y, z, w)\nresult = 1 / 0', { language: 'python', checkpointInterval: 2 });
    const states = record(session);
    expect(session.state.control.status).toBe('error');
    expect(session.state.output).toHaveLength(1);
    expect(session.state.frames[0]!.locals.x).toBe(90071992547409931234567890n);
    expect(Object.is(session.state.frames[0]!.locals.y, -0)).toBe(true);
    expect(session.state.frames[0]!.locals.z).toBe(Infinity);
    expect(session.state.frames[0]!.locals.w).toBeNaN();
    for (let i = states.length - 1; i >= 0; i--) {
      session.seek(0); session.seek(i);
      expect(snapshot(session)).toEqual(states[i]);
    }
  });
  it('não executa instruções ao saltar nem altera os registros', () => {
    const session = new DebugSession(example('python-factorial.py'), { language: 'python', checkpointInterval: 4 });
    const states = record(session);
    const execute = vi.spyOn(machine, 'executeInstruction');
    try {
      for (const target of [0, 30, 7, states.length - 1, 12, 0]) {
        session.seek(target); expect(snapshot(session)).toEqual(states[target]);
      }
      expect(execute).not.toHaveBeenCalled();
    } finally { execute.mockRestore(); }
  });
  it('permite continuar uma execução parcialmente registrada após um salto', () => {
    const code = example('python-factorial.py');
    const reference = record(new DebugSession(code, { language: 'python' }));
    const session = new DebugSession(code, { language: 'python', checkpointInterval: 4 });
    session.runBatch(25); session.seek(9);
    while (session.canForward) {
      session.forward(); expect(snapshot(session)).toEqual(reference[session.cursor]);
    }
    expect(session.history).toHaveLength(reference.length - 1);
  });
  it('preserva nomes como __proto__ após restaurar e continuar a gravação', () => {
    const code = 'fn constructor(__proto__) { let toString = 2; __proto__ = __proto__ + toString; return __proto__; } let __proto__ = 8; let result = constructor(__proto__);';
    const states = record(new DebugSession(code));
    const session = new DebugSession(code, { checkpointInterval: 2 });
    session.runBatch(8); session.seek(4);
    while (session.canForward) {
      session.forward(); expect(snapshot(session)).toEqual(states[session.cursor]);
    }
    expect(session.state.frames[0]!.locals.result).toBe(10);
  });
  it('rejeita posições não registradas sem mudar estado ou cursor', () => {
    const session = new DebugSession('let x = 1;'); session.forward();
    const state = snapshot(session);
    for (const target of [-1, 2, 0.5, NaN, Infinity]) {
      expect(() => session.seek(target)).toThrow(RangeError);
      expect(snapshot(session)).toEqual(state); expect(session.cursor).toBe(1);
    }
    expect(session.seek(1).appliedSteps).toBe(0);
  });
  it('restaura o estado no limite do histórico sem impedir replay', () => {
    const session = new DebugSession('while (true) {}', { maxSteps: 31, checkpointInterval: 4 });
    session.runBatch(31); const boundary = snapshot(session);
    session.seek(0); session.seek(31); expect(snapshot(session)).toEqual(boundary);
    expect(() => session.forward()).toThrow(HistoryLimitError);
    session.seek(20); session.forward(); expect(session.cursor).toBe(21);
    expect(session.history).toHaveLength(31);
  });
});

describe('checkpoints esparsos e isolados', () => {
  it('usa checkpoint próximo em saltos distantes e deltas locais em saltos curtos', () => {
    const session = new DebugSession(example('factorial.rw'), { checkpointInterval: 8 });
    record(session); session.seek(0);
    const far = session.seek(33);
    expect(far.checkpoint).toBe(32); expect(far.appliedSteps).toBe(1);
    const local = session.seek(34);
    expect(local.checkpoint).toBeNull(); expect(local.appliedSteps).toBe(1);
    const backwards = session.seek(23);
    expect(backwards.checkpoint).toBe(24); expect(backwards.appliedSteps).toBe(1);
  });
  it('limita o número de checkpoints sem perder estados de partes antigas', () => {
    const session = new DebugSession('let x = 0; while (x < 80) { x = x + 1; }', { checkpointInterval: 2, maxCheckpoints: 4 });
    const states = [snapshot(session)];
    while (session.canForward) {
      session.forward(); states.push(snapshot(session));
      expect(session.historyStats.checkpointCursors.length).toBeLessThanOrEqual(4);
    }
    expect(session.historyStats.checkpointInterval).toBeGreaterThan(2);
    expect(session.historyStats.checkpointCursors[0]).toBe(0);
    for (let target = 0; target < states.length; target += 7) {
      session.seek(states.length - 1); const result = session.seek(target);
      expect(snapshot(session)).toEqual(states[target]);
      expect(result.appliedSteps).toBeLessThan(session.historyStats.checkpointInterval);
    }
  });
  it('cópias restauradas e a máquina inicial não alteram um checkpoint', () => {
    const origin = initialState();
    const store = new CheckpointHistory(origin);
    origin.frames[0]!.locals.x = 42;
    const restored = store.restoreCheckpoint(0);
    restored.frames[0]!.locals.x = 99; restored.operands.push(1);
    expect(store.restoreCheckpoint(0)).toEqual(initialState());
  });
  it('restaurar, continuar e voltar repetidamente não contamina frames salvos', () => {
    const session = new DebugSession(example('factorial.rw'), { checkpointInterval: 3 });
    const states = record(session);
    for (let repeat = 0; repeat < 4; repeat++) {
      session.seek(12); session.runBatch(20); session.backwardBatch(15);
      session.seek(12); expect(snapshot(session)).toEqual(states[12]);
      session.seek(states.length - 1); expect(snapshot(session)).toEqual(states.at(-1));
    }
  });
  it('reiniciar elimina registros e checkpoints e recupera o intervalo original', () => {
    const session = new DebugSession(example('factorial.rw'), { checkpointInterval: 2, maxCheckpoints: 3 });
    const states = record(session); const program = session.program;
    session.restart();
    expect(session.program).toBe(program); expect(session.history).toHaveLength(0);
    expect(session.historyStats).toEqual({ checkpointInterval: 2, checkpointCursors: [0] });
    expect(snapshot(session)).toEqual(initialState());
    expect(() => session.seek(1)).toThrow(RangeError);
    expect(record(session)).toEqual(states);
  });
  it.each([{ checkpointInterval: 0 }, { checkpointInterval: 1.5 }, { maxCheckpoints: 1 }])('valida a configuração %j', options => {
    expect(() => new DebugSession('', options)).toThrow(/checkpoint/i);
  });
});

describe('navegação gerada com saltos', () => {
  it('mistura saltos, avanço, retrocesso e continuação, comparando todo o estado', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 12 }), fc.integer({ min: 2, max: 8 }),
      fc.array(fc.oneof(fc.constant(-2), fc.constant(-1), fc.integer({ min: 0, max: 120 })), { minLength: 50, maxLength: 180 }),
      (interval, budget, moves) => {
        const code = example('python-factorial.py');
        const states = record(new DebugSession(code, { language: 'python' }));
        const session = new DebugSession(code, { language: 'python', checkpointInterval: interval, maxCheckpoints: budget });
        session.runBatch(20);
        for (const move of moves) {
          if (move === -2) session.backward();
          else if (move === -1) session.forward();
          else session.seek(move % (session.history.length + 1));
          expect(snapshot(session)).toEqual(states[session.cursor]);
        }
        while (session.canForward) session.runBatch();
        expect(snapshot(session)).toEqual(states.at(-1));
      },
    ), { numRuns: 100, seed: 20261009 });
  });
});

describe('eventos da linha do tempo', () => {
  it('projeta chamadas, decisões, retornos e fim no cursor após a instrução', () => {
    const session = new DebugSession(example('factorial.rw')); record(session);
    const events = session.history.flatMap((step, index) => historyEvent(step, index + 1) ?? []);
    expect(events.filter(event => event.kind === 'call')).toHaveLength(5);
    expect(events.filter(event => event.kind === 'return')).toHaveLength(5);
    expect(events.filter(event => event.kind === 'decision')).toHaveLength(5);
    expect(events.at(-1)!.kind).toBe('end');
    for (const event of events) {
      session.seek(event.cursor);
      expect(session.lastStep!.description).toBe(event.description);
      expect(session.lastStep!.span.line).toBe(event.line);
    }
  });
  it('distingue uma falha de chamada de uma entrada real e print de frames', () => {
    const session = new DebugSession('print(42)\nresult = abs(1, 2)', { language: 'python' }); record(session);
    const events = session.history.flatMap((step, index) => historyEvent(step, index + 1) ?? []);
    expect(events.map(event => event.kind)).toEqual(['output', 'error']);
  });
});
