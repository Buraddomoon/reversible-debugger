import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { DebugSession } from '../src/core/debugger';
import { ExecutionComparison } from '../src/core/comparison';
import { measureMachine } from '../src/core/storage-accounting';
import * as machine from '../src/core/machine';

const code = 'def f(a):\n    a.append(a)\n    i = 0\n    while i < 18:\n        a[0] = i\n        i += 1\n        print(a[0])\n    return a\nx = [1]\ny = f(x)\nresult = 1 / 0';
const snapshot = (session: DebugSession) => structuredClone(session.state);
function record(source = code) {
  const session = new DebugSession(source, { language: 'python', checkpointInterval: Number.MAX_SAFE_INTEGER });
  const states = [snapshot(session)];
  while (session.canForward) { session.forward(); states.push(snapshot(session)); }
  return { session, states };
}
function finishSeek(session: DebugSession, target: number, size = 7) {
  let plan = session.beginSeek(target);
  while (!plan.done) plan = session.seekBatch(plan.id, size)!;
  return plan;
}

describe('navegação cooperativa do histórico', () => {
  it('cada lote nos dois sentidos publica um estado exato, sem executor ou alteração da reserva', () => {
    const { session, states } = record(), stats = session.storageStats, history = [...session.history];
    const spy = vi.spyOn(machine, 'executeInstruction');
    try {
      for (const target of [0, states.length - 1, 150, 300, 90, states.length - 1]) {
        let plan = session.beginSeek(target);
        expect(snapshot(session)).toEqual(states[session.cursor]);
        while (!plan.done) {
          const previous = plan.appliedSteps; plan = session.seekBatch(plan.id, 3)!;
          expect(plan.appliedSteps - previous).toBeLessThanOrEqual(3);
          expect(snapshot(session)).toEqual(states[session.cursor]);
          expect(session.machinePayload).toEqual(measureMachine(session.state));
          expect(session.storageStats).toEqual(stats);
        }
        expect(session.cursor).toBe(target); expect(plan.appliedSteps).toBe(plan.totalSteps);
      }
      expect(session.history).toEqual(history); expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it('cancelar mantém o último cursor válido e invalida o lote atrasado', () => {
    const { session, states } = record(); session.seek(0);
    const plan = session.beginSeek(session.history.length), partial = session.seekBatch(plan.id, 2)!;
    expect(partial.done).toBe(false); session.cancelSeek(plan.id);
    const cursor = session.cursor, state = snapshot(session);
    expect(session.seekBatch(plan.id)).toBeNull(); expect(snapshot(session)).toEqual(state);
    expect(state).toEqual(states[cursor]); expect(session.seekProgress).toBeNull();
    session.forward(); expect(snapshot(session)).toEqual(states[cursor + 1]);
  });
  it('o último destino vence; cancelar a requisição antiga não cancela a nova', () => {
    const { session, states } = record(); session.seek(0);
    const old = session.beginSeek(session.history.length); session.seekBatch(old.id, 2);
    const current = session.beginSeek(90);
    session.cancelSeek(old.id); expect(session.seekProgress?.id).toBe(current.id);
    expect(session.seekBatch(old.id)).toBeNull();
    let next = current; while (!next.done) next = session.seekBatch(next.id, 4)!;
    expect(snapshot(session)).toEqual(states[90]);
  });
  it.each(['forward', 'backward', 'seek', 'restart', 'budget'])('%s interrompe uma requisição anterior', action => {
    const { session } = record(); session.seek(0);
    const plan = session.beginSeek(session.history.length); session.seekBatch(plan.id, 2);
    if (action === 'forward') session.forward();
    else if (action === 'backward') session.backward();
    else if (action === 'seek') session.seek(1);
    else if (action === 'restart') session.restart();
    else session.setHistoryBudget(session.storageStats.limitBytes);
    const state = snapshot(session), cursor = session.cursor;
    expect(session.seekBatch(plan.id)).toBeNull(); expect(snapshot(session)).toEqual(state); expect(session.cursor).toBe(cursor);
  });
  it('destinos/opções inválidos não alteram a posição nem cancelam o pedido válido', async () => {
    const { session } = record(); session.seek(0); const plan = session.beginSeek(200), state = snapshot(session);
    for (const target of [-1, .5, Infinity, session.history.length + 1]) expect(() => session.beginSeek(target)).toThrow(RangeError);
    for (const [size, time] of [[0, 6], [1001, 6], [1, 0], [1, 17], [1, NaN]]) expect(() => session.seekBatch(plan.id, size, time)).toThrow();
    await expect(session.seekAsync(200, { batchSize: 0 })).rejects.toThrow();
    expect(snapshot(session)).toEqual(state); expect(session.seekProgress?.id).toBe(plan.id);
  });
  it('tempo e contagem limitam o lote, mantendo transações indivisíveis', () => {
    const { session } = record(); session.seek(0); const plan = session.beginSeek(200);
    let time = 0; const clock = vi.spyOn(performance, 'now').mockImplementation(() => time++);
    try { const progress = session.seekBatch(plan.id, 100, 2)!; expect(progress.appliedSteps).toBe(2); expect(progress.done).toBe(false); }
    finally { clock.mockRestore(); }
  });
  it('mistura destinos e cancelamentos gerados e mantém o estado completo', () => {
    const { session, states } = record();
    fc.assert(fc.property(fc.array(fc.tuple(fc.nat(states.length - 1), fc.integer({ min: 1, max: 10 }), fc.boolean()), { minLength: 10, maxLength: 50 }), moves => {
      for (const [target, size, cancel] of moves) {
        let plan = session.beginSeek(target);
        if (!plan.done) plan = session.seekBatch(plan.id, size)!;
        expect(snapshot(session)).toEqual(states[session.cursor]);
        if (cancel) session.cancelSeek(plan.id);
        else { while (!plan.done) plan = session.seekBatch(plan.id, size)!; expect(snapshot(session)).toEqual(states[target]); }
      }
    }), { seed: 20261014, numRuns: 30 });
  });
  it('abort já solicitado não muda o estado; abort entre lotes mantém o último estado mostrado', async () => {
    const { session, states } = record();
    const aborted = new AbortController(); aborted.abort();
    const before = snapshot(session);
    await expect(session.seekAsync(200, { signal: aborted.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(snapshot(session)).toEqual(before);
    session.seek(0); const controller = new AbortController();
    await expect(session.seekAsync(session.history.length, { signal: controller.signal, batchSize: 3, onProgress: () => controller.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(session.cursor).toBe(3); expect(snapshot(session)).toEqual(states[3]); expect(session.seekProgress).toBeNull();
  });
  it('restart durante yield não permite que a operação antiga restaure o programa anterior', async () => {
    const { session } = record(); session.seek(0);
    await expect(session.seekAsync(session.history.length, { batchSize: 2, yieldControl: async () => { session.restart(); } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(session.cursor).toBe(0); expect(session.history).toHaveLength(0); expect(session.state).toEqual(machine.initialState());
  });
  it('uma promise substituída rejeita sem cancelar a navegação que a substituiu', async () => {
    const { session, states } = record(); session.seek(0);
    let release!: () => void;
    const pending = session.seekAsync(session.history.length, { batchSize: 2, yieldControl: () => new Promise<void>(resolve => { release = resolve; }) });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const newer = session.beginSeek(90); release(); await rejected;
    expect(session.seekProgress?.id).toBe(newer.id);
    let plan = newer; while (!plan.done) plan = session.seekBatch(plan.id)!;
    expect(snapshot(session)).toEqual(states[90]);
  });
  it('seekAsync produz o estado final e progresso crescente com yields', async () => {
    const { session, states } = record(); session.seek(0); const seen: number[] = [], yieldControl = vi.fn(async () => {});
    const spy = vi.spyOn(machine, 'executeInstruction');
    try {
      const result = await session.seekAsync(session.history.length, { batchSize: 11, yieldControl, onProgress: progress => { seen.push(progress.appliedSteps); expect(snapshot(session)).toEqual(states[progress.cursor]); } });
      expect(result.done).toBe(true); expect(result.appliedSteps).toBe(session.history.length);
      expect(seen).toEqual([...seen].sort((a, b) => a - b)); expect(yieldControl).toHaveBeenCalled(); expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it('fork preparado para salto compartilha somente payloads congelados e preserva o original', () => {
    const { session, states } = record(); const original = snapshot(session), stats = session.storageStats;
    const fork = session.forkForSeek(100); expect(fork.cursor).toBe(0);
    expect(fork.storageStats).toEqual(stats); finishSeek(fork, 100);
    expect(snapshot(fork)).toEqual(states[100]); expect(snapshot(session)).toEqual(original);
    expect(fork.state.heap).not.toBe(session.state.heap);
  });
  it('restauração de arquivo também pode ser interrompida durante o salto final', async () => {
    const { session } = record('i = 0\nwhile i < 70:\n    i += 1');
    const controller = new AbortController(); let yields = 0;
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      await expect(DebugSession.restoreRecording(session.program.source, { ...session.runtime, maxSteps: session.maxSteps, maxFrames: session.maxFrames, maxHistoryBytes: session.storageStats.estimatedBytes }, session.history, 200, { signal: controller.signal, yieldControl: async () => { if (++yields === Math.floor(session.history.length / 256) + 1) controller.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
    } finally { clock.mockRestore(); }
  });
});

describe('publicação atômica dos dois lados da comparação', () => {
  const prepare = () => {
    const source = 'i = 0\nwhile i < 70:\n    i += 1\nresult = i';
    const input = { name: 'Loop', source, language: 'python', version: '3' };
    const comparison = new ExecutionComparison(input, input, { checkpointInterval: Number.MAX_SAFE_INTEGER });
    while (!comparison.ready) comparison.prepareBatch();
    return comparison;
  };
  it('lotes parciais e cancelamento preservam o ponto exibido e ambos os estados', () => {
    const comparison = prepare(), a = structuredClone(comparison.left.state), b = structuredClone(comparison.right.state);
    const plan = comparison.beginSeekRow(comparison.rows.length - 1), progress = comparison.seekRowBatch(plan.id, 2)!;
    expect(progress.done).toBe(false); expect(comparison.cursor).toBe(0);
    expect(comparison.left.state).toEqual(a); expect(comparison.right.state).toEqual(b);
    comparison.cancelNavigation(plan.id); expect(comparison.seekRowBatch(plan.id)).toBeNull(); expect(comparison.cursor).toBe(0);
    expect(comparison.left.state).toEqual(a); expect(comparison.right.state).toEqual(b);
  });
  it('só publica quando os dois destinos estão prontos e ignora pedidos substituídos', () => {
    const comparison = prepare();
    const old = comparison.beginSeekRow(comparison.rows.length - 1); comparison.seekRowBatch(old.id, 2);
    let plan = comparison.beginSeekRow(Math.floor(comparison.rows.length / 2));
    comparison.cancelNavigation(old.id); expect(comparison.seekRowBatch(old.id)).toBeNull();
    const spy = vi.spyOn(machine, 'executeInstruction');
    try {
      while (!plan.done) plan = comparison.seekRowBatch(plan.id, 3)!;
      const row = comparison.rows[plan.target]!;
      expect(comparison.cursor).toBe(plan.target); expect(comparison.left.cursor).toBe(row.leftCursor); expect(comparison.right.cursor).toBe(row.rightCursor);
      expect(comparison.left.state).toEqual(comparison.right.state); expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});
