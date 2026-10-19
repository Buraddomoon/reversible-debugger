import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import fc from 'fast-check';
import { DebugSession } from '../src/core/debugger';
import { ExecutionControl, type RunMode } from '../src/core/execution-control';
import { PagedExecutionControl } from '../src/core/paged-execution-control';
import { LiveRecording } from '../src/core/live-recording';
import { RecordingJournal } from '../src/core/recording-journal';
import { PagedHistoryStore } from '../src/core/paged-history';
import { ExecutionLibrary } from '../src/core/execution-library';
import { CheckpointCache } from '../src/core/checkpoint-cache';
import * as machine from '../src/core/machine';

const fast = { yieldControl: async () => {} }, details = { name: 'Controles', filename: 'controles.py' };
const resources: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(resources.splice(0).map(resource => resource.close())); });
function setup() {
  const factory = new IDBFactory(), journal = new RecordingJournal(factory, 'journal'), library = new ExecutionLibrary({ factory, name: 'captures' }), checkpoints = new CheckpointCache(factory, 'cache');
  resources.push(journal, library, checkpoints); return { journal, library, checkpoints };
}
function reference(source: string, language = 'python') {
  const session = new DebugSession(source, { language }), states = [structuredClone(session.state)];
  while (session.canForward) { session.forward(); states.push(structuredClone(session.state)); }
  session.seek(0); return { session, states };
}
async function run(control: PagedExecutionControl, mode: RunMode, size = 16) {
  control.start(mode); let batches = 0;
  while (control.running) { const result = await control.runBatch(size); expect(result.moved).toBeLessThanOrEqual(size); if (++batches > 2000) throw new Error('Plano infinito'); }
  return control.stop!;
}
const nested = 'def double(n):\n    return n * 2\nresult = 10 + double(double(3))\nprint(result)';
const factorial = 'def fact(n):\n    if n <= 1:\n        return 1\n    return n * fact(n - 1)\nresult = fact(6)\nprint(result)';
const mutations = 'a = [0]\nb = a\na.append(a)\ndef change(x):\n    x[0] = x[0] + 1\n    print(x)\n    return x\ni = 0\nwhile i < 4:\n    change(b)\n    i += 1\nresult = b[99]';

describe('política compartilhada em gravação contínua e replay paginado', () => {
  for (const kind of ['live', 'saved'] as const) for (const [language, source] of [
    ['python', nested], ['python', factorial], ['python', mutations],
    ['python', 'def empty():\n    pass\nresult = empty()'],
    ['python', 'i = 0\nwhile i < 4:\n    i += 1\nresult = i'],
    ['rewind', 'fn twice(n) { return n * 2; } let i = 0; while (i < 3) { i = twice(i + 1); } let result = i;'],
  ] as const) it(`${kind}: todos os controles em ${language}, ${source.slice(0, 22)}`, async () => {
    const { journal, library, checkpoints } = setup(), { session, states } = reference(source!, language);
    const runtime = session.runtime;
    const saved = kind === 'saved' ? await library.save(session, details, fast) : null;
    const store = kind === 'live' ? await LiveRecording.start(journal, source!, runtime, details, { cacheBytes: 1024, bufferBytes: 4096 }, fast)
      : await PagedHistoryStore.open(library, checkpoints, saved!.id, { cacheBytes: 1024 }, fast);
    const control = new PagedExecutionControl(store), classic = new ExecutionControl(session);
    for (const line of session.program.breakableLines) { classic.toggleBreakpoint(line); control.toggleBreakpoint(line); }
    const execute = vi.spyOn(machine, 'executeInstruction');
    let previousCount = store.count;
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom<RunMode>('continue', 'reverse-continue', 'into', 'over', 'out', 'back-statement'), { minLength: 20, maxLength: 35 }), async moves => {
      for (const mode of moves) {
        if (mode === 'out' && !classic.canStepOut) continue;
        control.start(mode); classic.start(mode);
        let batches = 0;
        while (classic.running || control.running) {
          const size = [1, 3, 16][batches++ % 3]!;
          const expected = classic.runBatch(size), actual = await control.runBatch(size);
          expect(actual).toEqual(expected); expect(store.cursor).toBe(session.cursor);
          expect(store.state).toEqual(states[store.cursor]); expect(control.snapshot.stop).toEqual(classic.stop);
          expect(control.mode).toBe(classic.mode); expect(store.count).toBeGreaterThanOrEqual(previousCount); previousCount = store.count;
          expect(store.stats.bytes).toBeLessThanOrEqual(1024);
          expect(store.stats.estimatedBytes).toBeLessThanOrEqual(store.stats.limitTotalBytes);
          if (batches > 2000) throw new Error('Plano infinito');
        }
      }
    }), { numRuns: 10, seed: 20261019 });
    control.breakpointsEnabled = false; await run(control, 'continue');
    expect(store.state).toEqual(states.at(-1)); expect(store.count).toBe(states.length - 1);
    expect(execute).toHaveBeenCalledTimes(kind === 'live' ? store.count : 0); execute.mockClear();
    await run(control, 'reverse-continue'); expect(store.cursor).toBe(0);
    await run(control, 'continue'); expect(store.state).toEqual(states.at(-1)); expect(execute).not.toHaveBeenCalled();
    expect('history' in store).toBe(false);
    if (store instanceof LiveRecording) { await store.close(); } else store.dispose();
  });

  it('passar sobre e sair mantêm o frame original através de vários lotes', async () => {
    const { journal } = setup(), { session, states } = reference(factorial);
    const live = await LiveRecording.start(journal, factorial, session.runtime, details, {}, fast), control = new PagedExecutionControl(live);
    await run(control, 'into', 1); await run(control, 'into', 1); const outer = live.state.frames.at(-1)!.id;
    await run(control, 'into', 1); await run(control, 'into', 1); expect(live.state.frames.at(-1)!.id).not.toBe(outer);
    await run(control, 'out', 1); expect(live.state.frames.at(-1)!.id).toBe(outer); expect(live.state.operands).toEqual([6n, 120n]);
    expect(live.state).toEqual(states[live.cursor]); await run(control, 'out', 1);
    expect(live.state.operands).toEqual([720n]); expect(live.state.frames[0]!.locals).not.toHaveProperty('result');
    await run(control, 'over', 1); expect(live.state.frames[0]!.locals.result).toBe(720n); await live.close();
  });

  it('breakpoint inicial, retomada, manual seek e configuração atômica', async () => {
    const { journal } = setup(), live = await LiveRecording.start(journal, 'result = 42', { language: 'python', version: '3' }, details, {}, fast), control = new PagedExecutionControl(live);
    control.configure([1], true); expect((await run(control, 'continue')).reason).toBe('breakpoint'); expect(live.count).toBe(0);
    control.pause(); expect(control.stop!.reason).toBe('breakpoint');
    expect(() => control.configure([1, 999], true)).toThrow('inválida'); expect(control.breakpoints).toEqual([1]);
    await live.seek(0, fast); control.cancel(); await run(control, 'continue'); expect(live.count).toBe(0);
    await run(control, 'continue'); expect(live.state.frames[0]!.locals.result).toBe(42n);
    control.configure([1], false); await run(control, 'reverse-continue'); await run(control, 'continue'); expect(control.stop!.reason).toBe('halted');
    control.configure([], true); expect(control.breakpoints).toEqual([]);
    for (const size of [0, 17, 1.5]) await expect(control.runBatch(size)).rejects.toThrow('lote');
    expect(() => control.start('out')).toThrow('função ativa'); await live.close();
  });

  it('fronteira de captura parcial não executa e não ultrapassa os passos gravados', async () => {
    const { library, checkpoints } = setup(), session = new DebugSession('while True:\n    pass', { language: 'python', maxSteps: 17 });
    for (let i = 0; i < 17; i++) session.forward(); session.seek(0);
    const saved = await library.save(session, details, fast), store = await PagedHistoryStore.open(library, checkpoints, saved.id, {}, fast), control = new PagedExecutionControl(store), execute = vi.spyOn(machine, 'executeInstruction');
    expect((await run(control, 'continue')).reason).toBe('recorded-end'); expect(store.cursor).toBe(17); expect(store.state.control.status).toBe('running');
    expect((await run(control, 'into')).reason).toBe('recorded-end');
    expect((await run(control, 'reverse-continue')).reason).toBe('start'); expect(store.cursor).toBe(0); expect(execute).not.toHaveBeenCalled(); store.dispose();
  });

  it('limite contínuo pausa o plano preservando todos os estados', async () => {
    const { journal } = setup(), live = await LiveRecording.start(journal, 'while True:\n    pass', { language: 'python', version: '3' }, details, { maxSteps: 17 }, fast), control = new PagedExecutionControl(live);
    expect((await run(control, 'continue')).reason).toBe('budget'); expect(live.cursor).toBe(17); expect(live.ledger.durable).toBe(17);
    const final = structuredClone(live.state), execute = vi.spyOn(machine, 'executeInstruction');
    await run(control, 'reverse-continue'); await run(control, 'continue'); expect(live.state).toEqual(final); expect(execute).not.toHaveBeenCalled(); await live.close();
  });

  it('falha de flush preserva prefixo e saída; retry retoma sem duplicar', async () => {
    const source = 'i = 0\nwhile i < 20:\n    print(i)\n    i += 1', { session, states } = reference(source), { journal } = setup();
    const live = await LiveRecording.start(journal, source, session.runtime, details, { bufferBytes: 4096 }, fast), control = new PagedExecutionControl(live);
    const write = vi.spyOn(journal, 'commit').mockRejectedValue(new Error('Disco cheio'));
    control.start('continue'); try { while (control.running) await control.runBatch(); } catch { /* Prefix is accepted; the worker publishes it with the failure. */ }
    expect(live.ledger.pauseReason).toMatch(/Disco cheio/); expect(live.state).toEqual(states[live.cursor]); expect(live.ledger.pendingSteps).toBeGreaterThan(0); expect(control.running).toBe(false);
    const count = live.count; write.mockRestore(); expect(await live.flush()).toBe(true);
    await run(control, 'continue'); expect(live.state).toEqual(states.at(-1)); expect(live.count).toBe(states.length - 1); expect(live.count).toBeGreaterThan(count); await live.close();
  });

  it('admissão por bytes pausa o journal sem converter limite em erro da VM', async () => {
    const { journal } = setup(), source = 'a = []\nextra = 0\ni = 0\nwhile i < 100:\n    a.append(i)\n    i += 1', { states } = reference(source);
    const live = await LiveRecording.start(journal, source, { language: 'python', version: '3' }, details, { maxHistoryBytes: 64 * 1024, bufferBytes: 4096, cacheBytes: 64 * 1024 }, fast), control = new PagedExecutionControl(live);
    expect((await run(control, 'continue')).reason).toBe('budget'); expect(live.state.control.status).toBe('running'); expect(live.ledger.canRecord).toBe(false);
    expect(live.ledger.pauseReason).toBeTruthy(); expect(live.state).toEqual(states[live.cursor]);
    const count = live.count;
    for (const mode of ['reverse-continue', 'continue'] as const) {
      control.start(mode); while (control.running) { await control.runBatch(); expect(live.stats.estimatedBytes).toBeLessThanOrEqual(live.stats.limitTotalBytes); expect(live.state).toEqual(states[live.cursor]); }
      expect(live.cursor).toBe(mode === 'continue' ? count : 0);
    }
    expect(live.state).toEqual(states[count]);
    await live.close();
  });

  it('erro de leitura entre lotes conserva o último estado e pode ser repetido', async () => {
    const { library, checkpoints } = setup(), { session, states } = reference('i = 0\nwhile i < 50:\n    i += 1');
    const saved = await library.save(session, details, fast), store = await PagedHistoryStore.open(library, checkpoints, saved.id, { cacheBytes: 1 }, fast), control = new PagedExecutionControl(store);
    control.start('continue'); await control.runBatch(); const cursor = store.cursor;
    const read = vi.spyOn(library, 'readBlock').mockRejectedValue(new Error('Bloco corrompido'));
    await expect(control.runBatch()).rejects.toThrow('Bloco corrompido'); expect(store.cursor).toBe(cursor); expect(store.state).toEqual(states[cursor]);
    expect(control.running).toBe(false); expect(control.snapshot.error).toBe('Bloco corrompido'); read.mockRestore();
    await run(control, 'continue'); expect(store.state).toEqual(states.at(-1)); expect(control.snapshot.error).toBeNull(); store.dispose();
  });
});
