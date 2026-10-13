import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { DebugSession, HistoryBudgetError } from '../src/core/debugger';
import { DEFAULT_HISTORY_BYTES, MAX_HISTORY_BYTES } from '../src/core/history';
import { encodedBytes, measureMachine } from '../src/core/storage-accounting';
import { ExecutionControl } from '../src/core/execution-control';
import { ExecutionComparison } from '../src/core/comparison';
import { exportHistory, importHistory } from '../src/core/portable-history';
import * as machine from '../src/core/machine';
import * as accounting from '../src/core/storage-accounting';

const options = { language: 'python', checkpointInterval: Number.MAX_SAFE_INTEGER };
const fast = { yieldControl: async () => {} };
const clone = (session: DebugSession) => structuredClone(session.state);
function record(source: string, settings = {}) {
  const session = new DebugSession(source, { ...options, ...settings });
  const states = [clone(session)], sizes = [session.storageStats.estimatedBytes];
  while (session.canForward) {
    try { session.forward(); } catch (cause) { if (cause instanceof HistoryBudgetError) break; throw cause; }
    states.push(clone(session)); sizes.push(session.storageStats.estimatedBytes);
  }
  return { session, states, sizes };
}
const looping = 'a = []\nb = a\ni = 0\nwhile i < 30:\n    a.append(i)\n    b[-1] = i + 1\n    print(a[-1])\n    i += 1\nresult = len(a)';

describe('orçamento e contabilização incremental', () => {
  it('configura 64 MiB por padrão e rejeita limites inválidos', () => {
    expect(new DebugSession('').storageStats.limitBytes).toBe(DEFAULT_HISTORY_BYTES);
    for (const limit of [0, -1, 1.5, NaN, Infinity, MAX_HISTORY_BYTES + 1]) expect(() => new DebugSession('', { maxHistoryBytes: limit })).toThrow(/Orçamento/);
    expect(() => new DebugSession('', { maxHistoryBytes: 1 })).toThrow(HistoryBudgetError);
  });
  it('contabiliza todos os tipos de delta em ida, volta e checkpoints', () => {
    const source = 'def f(a):\n    x = 90071992547409931234567890\n    a.append(a)\n    print(a, x)\n    return a\na = [-0.0, 1e308 * 1e308]\nb = f(a)\nb[0] = b\nresult = a[99]';
    const { session, states } = record(source, { checkpointInterval: 3 });
    expect(session.state.control.status).toBe('error');
    for (const cursor of [...states.keys(), ...states.keys()].reverse()) {
      session.seek(cursor);
      expect(session.machinePayload).toEqual(measureMachine(session.state));
      expect(session.machinePayload.totalBytes).toBeGreaterThanOrEqual(encodedBytes(session.state));
      expect(clone(session)).toEqual(states[cursor]);
    }
    session.restart(); expect(session.machinePayload).toEqual(measureMachine(session.state));
  });
  it.each([
    ['a = [1, 2]', 'BUILD_LIST'],
    ['a = [1]\na[0] = 99', 'LIST_SET'],
    ['a = [1]\na.append(a)', 'LIST_APPEND'],
    ['def f(a):\n    return a\na = [1]\nresult = f(a)', 'CALL'],
    ['def f(a):\n    return a\na = [1]\nresult = f(a)', 'RETURN'],
    ['a = [1]\nprint(a)', 'CALL'],
    ['a = [1]\nresult = a[0]', 'LIST_GET'],
    ['a = []\nresult = a[9]', 'LIST_GET'],
  ])('recusar %s / %s restaura exatamente o estado anterior', (source, op) => {
    const reference = record(source);
    const index = reference.session.history.findIndex(step => step.op === op);
    const limit = reference.sizes[index + 1]! - 1;
    const session = new DebugSession(source, { ...options, maxHistoryBytes: limit });
    for (let i = 0; i < index; i++) session.forward();
    const beforeStats = session.storageStats, records = [...session.history];
    expect(() => session.forward()).toThrow(HistoryBudgetError);
    expect(clone(session)).toEqual(reference.states[index]);
    expect(session.cursor).toBe(index); expect(session.history).toEqual(records);
    expect(session.storageStats).toEqual(beforeStats);
    expect(session.machinePayload).toEqual(measureMachine(session.state));
    expect(session.recordingStop).toMatchObject({ reason: 'budget', requiredBytes: reference.sizes[index + 1] });
    expect(session.canForward).toBe(false);
    expect(session.forward()).toBeNull();
    session.setHistoryBudget(DEFAULT_HISTORY_BYTES); session.forward();
    expect(clone(session)).toEqual(reference.states[index + 1]);
    expect(session.recordingStop).toBeNull();
  });
  it('aceita exatamente a fronteira de bytes e recusa o próximo passo', () => {
    const reference = record('x = 1\nx = 2');
    const session = new DebugSession('x = 1\nx = 2', { ...options, maxHistoryBytes: reference.sizes[1] });
    session.forward(); expect(session.storageStats.estimatedBytes).toBe(reference.sizes[1]);
    expect(() => session.forward()).toThrow(HistoryBudgetError);
    expect(clone(session)).toEqual(reference.states[1]);
  });
  it('não percorre todo o estado para contabilizar cada instrução', () => {
    const session = new DebugSession(looping, { language: 'python', checkpointInterval: 2 });
    const scan = vi.spyOn(accounting, 'measureMachine');
    try {
      session.runBatch(500); expect(scan).not.toHaveBeenCalled();
      session.seek(0); expect(scan).toHaveBeenCalled();
    } finally { scan.mockRestore(); }
  });
  it('salto/replay preservam o orçamento e a reserva do maior estado', () => {
    const { session, states } = record(looping, { maxHistoryBytes: 16_384, checkpointInterval: 2, maxCheckpoints: 16 });
    expect(session.recordingStop).not.toBeNull(); expect(session.history.length).toBeGreaterThan(5);
    const retained = session.storageStats;
    expect(retained.estimatedBytes).toBeLessThanOrEqual(retained.limitBytes);
    expect(session.historyStats.checkpointCursors[0]).toBe(0);
    const spy = vi.spyOn(machine, 'executeInstruction');
    try {
      fc.assert(fc.property(fc.array(fc.nat(states.length - 1), { minLength: 10, maxLength: 100 }), targets => {
        for (const target of targets) {
          session.seek(target); expect(clone(session)).toEqual(states[target]);
          expect(session.storageStats).toEqual(retained);
          expect(session.machinePayload).toEqual(measureMachine(session.state));
        }
      }), { seed: 20261013, numRuns: 30 });
      session.seek(0); expect(session.machinePayload.totalBytes).toBeLessThan(retained.reservedMachineBytes);
      expect(session.canForward).toBe(true); session.seek(session.history.length); expect(session.canForward).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it('reduz cópias auxiliares antes de recusar deltas, sem perder passos', () => {
    const { session, states } = record(looping, { maxHistoryBytes: 16_384, checkpointInterval: 1, maxCheckpoints: 128 });
    expect(session.storageStats.skippedCheckpoints).toBeGreaterThan(0);
    expect(session.historyStats.checkpointCursors).toEqual([0]);
    for (let cursor = states.length - 1; cursor >= 0; cursor--) { session.seek(cursor); expect(clone(session)).toEqual(states[cursor]); }
    const dense = record(looping, { checkpointInterval: 1, maxCheckpoints: 128 });
    expect(session.history).toEqual(dense.session.history.slice(0, session.history.length));
  });
  it('recusa reduzir abaixo do reservado, mesmo depois de voltar', () => {
    const { session } = record(looping); session.seek(0);
    const before = session.storageStats;
    expect(() => session.setHistoryBudget(before.estimatedBytes - 1)).toThrow(/reservado/);
    expect(session.storageStats).toEqual(before); expect(session.cursor).toBe(0);
    session.setHistoryBudget(before.estimatedBytes); expect(session.storageStats.limitBytes).toBe(before.estimatedBytes);
  });
  it('aumentar o limite permite continuar sem duplicar registros nem refazer o futuro', () => {
    const { session, states } = record(looping, { maxHistoryBytes: 16_384 });
    const reference = record(looping), retained = [...session.history];
    session.seek(0); session.setHistoryBudget(DEFAULT_HISTORY_BYTES);
    expect(session.recordingStop).toBeNull();
    while (session.canForward) { session.forward(); expect(clone(session)).toEqual(reference.states[session.cursor]); }
    expect(session.history.slice(0, states.length - 1)).toEqual(retained);
    expect(session.history).toEqual(reference.session.history);
  });
  it('reiniciar libera payload e conserva o limite; forks mantêm índices/contadores próprios', () => {
    const { session } = record(looping, { maxHistoryBytes: 16_384, checkpointInterval: 2 });
    const retained = session.storageStats, copy = session.forkRecording();
    expect(copy.storageStats).toEqual(retained); expect(copy.machinePayload).toEqual(session.machinePayload);
    copy.setHistoryBudget(DEFAULT_HISTORY_BYTES); copy.restart(); copy.runBatch(4);
    expect(session.storageStats).toEqual(retained); expect(session.recordingStop).not.toBeNull();
    session.restart();
    expect(session.storageStats.limitBytes).toBe(16_384); expect(session.storageStats.estimatedBytes).toBeLessThan(1000);
    expect(session.recordingStop).toBeNull(); expect(session.canForward).toBe(true);
  });
  it('controle por comando para por orçamento preservando o intervalo efetivamente aplicado', () => {
    const session = new DebugSession(looping, { ...options, maxHistoryBytes: 8192 });
    const controller = new ExecutionControl(session); controller.start('continue');
    let moved = 0;
    while (controller.running) { const result = controller.runBatch(256); moved += result.moved; }
    expect(controller.stop?.reason).toBe('budget'); expect(moved).toBe(session.cursor);
    expect(session.state.control.status).toBe('running');
    controller.start('reverse-continue'); while (controller.running) controller.runBatch(256);
    expect(session.cursor).toBe(0);
    controller.start('continue'); while (controller.running) controller.runBatch(256);
    expect(controller.stop?.reason).toBe('budget'); expect(session.cursor).toBe(moved);
  });
  it('importa v2 parcial e recusa falta de orçamento sem alterar a sessão aberta', async () => {
    const { session } = record(looping, { maxHistoryBytes: 8192 });
    session.seek(2); const content = await exportHistory(session, { name: 'Parcial', filename: 'parcial.py' }, fast);
    const restored = (await importHistory(content, { ...fast, maxHistoryBytes: 8192 })).session;
    expect(clone(restored)).toEqual(clone(session)); expect(restored.storageStats.limitBytes).toBe(8192);
    const full = record(looping); const large = await exportHistory(full.session, { name: 'Completo', filename: 'completo.py' }, fast);
    const before = clone(session), stats = session.storageStats;
    await expect(importHistory(large, { ...fast, maxHistoryBytes: 8192 })).rejects.toThrow(HistoryBudgetError);
    expect(clone(session)).toEqual(before); expect(session.storageStats).toEqual(stats);
    restored.seek(restored.history.length); expect(restored.state.control.status).toBe('running'); expect(restored.canForward).toBe(false);
    restored.setHistoryBudget(DEFAULT_HISTORY_BYTES); expect(restored.canForward).toBe(false); // Imported future cannot be invented.
  });
  it('comparação marca parada por orçamento como gravação incompleta e mantém replay', () => {
    const input = (source: string) => ({ name: source, source, language: 'python', version: '3' });
    const comparison = new ExecutionComparison(input(looping), input('result = 1'), { maxHistoryBytes: 8192 });
    while (!comparison.ready) comparison.prepareBatch();
    expect(comparison.left.limitReached).toBe(true); expect(comparison.left.points.at(-1)?.phase).toBe('limit');
    expect(comparison.left.state.control.status).toBe('running');
    const spy = vi.spyOn(machine, 'executeInstruction');
    try { comparison.seekRow(comparison.rows.length - 1); comparison.seekRow(0); expect(spy).not.toHaveBeenCalled(); }
    finally { spy.mockRestore(); }
  });
  it('comparação de gravações aplica o limite por lado sem modificar o original', () => {
    const { session } = record(looping), before = clone(session), stats = session.storageStats;
    const source = { name: 'Gravado', source: looping, language: 'python', version: '3', recording: session };
    expect(() => new ExecutionComparison(source, source, { maxHistoryBytes: 8192 })).toThrow(/reservado/);
    expect(clone(session)).toEqual(before); expect(session.storageStats).toEqual(stats);
  });
  it('passar sobre preserva os passos de um lote interrompido dentro da função', () => {
    const source = 'def f():\n' + looping.split('\n').map(line => `    ${line}`).join('\n') + '\n    return result\nresult = f()';
    const session = new DebugSession(source, { ...options, maxHistoryBytes: 8192 }), controller = new ExecutionControl(session);
    controller.start('into'); controller.runBatch(256);
    const origin = session.cursor;
    controller.start('over'); const result = controller.runBatch(256);
    expect(result.stop?.reason).toBe('budget'); expect(result.origin).toBe(origin);
    expect(result.moved).toBe(session.cursor - origin); expect(result.moved).toBeGreaterThan(1);
    expect(result.lastStep).toBe(session.lastStep); expect(session.state.frames.at(-1)?.name).toBe('f');
    expect(session.state.control.status).toBe('running');
    session.setHistoryBudget(DEFAULT_HISTORY_BYTES); controller.start('continue');
    while (controller.running) controller.runBatch(256);
    expect(clone(session)).toEqual(clone(record(source).session));
  });
});
