import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import fc from 'fast-check';
import { DebugSession } from '../src/core/debugger';
import { ExecutionLibrary } from '../src/core/execution-library';
import { CheckpointCache } from '../src/core/checkpoint-cache';
import { PagedHistoryStore } from '../src/core/paged-history';
import { initialState } from '../src/core/machine';
import * as machine from '../src/core/machine';

const fast = { yieldControl: async () => {} }, details = { name: 'Paginado', filename: 'paginas.py' };
const resources: Array<{ close(): Promise<void> }> = [];
function setup() { const factory = new IDBFactory(), library = new ExecutionLibrary({ factory, name: 'recordings' }), checkpoints = new CheckpointCache(factory, 'derived'); resources.push(library, checkpoints); return { factory, library, checkpoints }; }
function record(source: string, maxSteps = 20_000) {
  const session = new DebugSession(source, { language: 'python', maxSteps }), states = [structuredClone(session.state)];
  while (session.canForward && session.history.length < maxSteps) { session.forward(); states.push(structuredClone(session.state)); } return { session, states };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(resources.splice(0).map(r => r.close())); });

describe('histórico paginado e checkpoints persistidos', () => {
  for (const source of [
    'def sum_to(n):\n    i = 1\n    total = 0\n    while i < n:\n        total += i\n        i += 1\n    return total\nresult = sum_to(5)\nprint(result)',
    'a = [1, 2]\nb = a\na.append(a)\ndef mutate(x):\n    x[0] = 99\n    return x\nc = mutate(b)\nprint(c)\nresult = c[99]',
    'a = 90071992547409931234567890\nb = -0.0\nc = 1e308 * 1e308\nd = c - c\ne = None\nconstructor = print\n__proto__ = a\nprint(a, b, d)',
    'def fact(n):\n    if n <= 1:\n        return 1\n    return n * fact(n - 1)\nresult = fact(7)',
  ]) it(`restaura todos os campos nos dois sentidos sem executor: ${source.slice(0, 25)}`, async () => {
    const { library, checkpoints } = setup(), { session, states } = record(source); session.seek(Math.floor(session.history.length / 2));
    const saved = await library.save(session, details, fast), execute = vi.spyOn(machine, 'executeInstruction');
    const store = await PagedHistoryStore.open(library, checkpoints, saved.id, { cacheBytes: 1024 }, fast);
    expect(store.cursor).toBe(saved.cursor); expect(store.state).toEqual(states[saved.cursor]);
    for (let i = 0; i < states.length; i++) { await store.seek(i, fast); expect(store.state).toEqual(states[i]); expect(store.stats.bytes).toBeLessThanOrEqual(1024); }
    for (let i = states.length - 1; i >= 0; i--) { await store.seek(i, fast); expect(store.state).toEqual(states[i]); }
    expect(execute).not.toHaveBeenCalled(); expect(store.stats.estimatedBytes).toBeLessThanOrEqual(store.stats.limitTotalBytes);
  });
  it('primeira abertura indexa sem reter tudo; reabertura lê somente o bloco do cursor', async () => {
    const { library, checkpoints } = setup(), { session, states } = record('i = 0\nwhile i < 180:\n    i += 1\nresult = i'); session.seek(520);
    const saved = await library.save(session, details, fast), read = vi.spyOn(library, 'readBlock');
    const first = await PagedHistoryStore.open(library, checkpoints, saved.id, { cacheBytes: 150_000 }, fast);
    expect(first.stats.indexBuilt).toBe(true); expect(read.mock.calls.length).toBeGreaterThanOrEqual(saved.blocks); expect(first.stats.blocks).toBeLessThan(saved.blocks);
    first.dispose(); read.mockClear();
    const second = await PagedHistoryStore.open(library, checkpoints, saved.id, { cacheBytes: 150_000 }, fast);
    expect(second.stats.indexBuilt).toBe(false); expect(read.mock.calls.length).toBeLessThanOrEqual(2); expect(second.state).toEqual(states[520]);
    await second.seek(521, fast); const afterOne = read.mock.calls.length; await second.seek(520, fast); expect(read.mock.calls.length).toBe(afterOne); expect(second.stats.hits).toBeGreaterThan(0);
    await second.seek(second.count, fast); expect(second.stats.evictions).toBeGreaterThan(0); expect(second.stats.bytes).toBeLessThanOrEqual(150_000);
  });
  it('saltos gerados cruzam blocos, checkpoints e despejos sem perder o futuro', async () => {
    const { library, checkpoints } = setup(), { session, states } = record('a = [0]\nb = a\ni = 0\nwhile i < 60:\n    b[0] = i\n    i += 1\nresult = a[0]');
    const saved = await library.save(session, details, fast), store = await PagedHistoryStore.open(library, checkpoints, saved.id, { cacheBytes: 120_000 }, fast);
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 0, max: session.history.length }), { maxLength: 30 }), async targets => { for (const target of targets) { await store.seek(target, fast); expect(store.state).toEqual(states[target]); expect(store.stats.bytes).toBeLessThanOrEqual(120_000); } }), { numRuns: 12, seed: 20261014 });
    await store.seek(0, fast); await store.seek(store.count, fast); expect(store.state).toEqual(states.at(-1)); expect(await library.list()).toEqual([saved]);
  });
  it('cancelamento conserva VM/cursor publicados mesmo durante leitura atrasada', async () => {
    const { library, checkpoints } = setup(), { session } = record('i = 0\nwhile i < 100:\n    i += 1'); session.seek(1);
    const saved = await library.save(session, details, fast), store = await PagedHistoryStore.open(library, checkpoints, saved.id, { cacheBytes: 1 }, fast), before = structuredClone(store.state);
    const controller = new AbortController(); let unblock!: () => void, started!: () => void;
    const entered = new Promise<void>(r => { started = r; }), wait = new Promise<void>(r => { unblock = r; }), original = library.readBlock.bind(library);
    vi.spyOn(library, 'readBlock').mockImplementation(async (...args) => { started(); await wait; return original(...args); });
    const navigation = store.seek(550, { ...fast, signal: controller.signal }); const rejection = expect(navigation).rejects.toThrow(); await entered; controller.abort(); unblock(); await rejection;
    expect(store.cursor).toBe(1); expect(store.state).toEqual(before);
  });
  it('último destino vence e progresso privado não modifica o estado publicado', async () => {
    const { library, checkpoints } = setup(), { session, states } = record('i = 0\nwhile i < 100:\n    i += 1'); session.seek(0);
    const saved = await library.save(session, details, fast), store = await PagedHistoryStore.open(library, checkpoints, saved.id, {}, fast);
    let replaced = false, next: Promise<void> | null = null;
    const old = store.seek(230, { ...fast, onSeekProgress: p => { expect(store.state).toEqual(states[0]); if (!replaced && p.completed >= 16) { replaced = true; next = store.seek(3, fast); } } });
    await expect(old).rejects.toThrow(/substituída/); await next; expect(store.cursor).toBe(3); expect(store.state).toEqual(states[3]);
  });
  it('cancelar na confirmação final conserva o cursor do Worker para o próximo pedido', async () => {
    const { library, checkpoints } = setup(), { session, states } = record('i = 0\nwhile i < 40:\n    i += 1'); session.seek(0);
    const saved = await library.save(session, details, fast), store = await PagedHistoryStore.open(library, checkpoints, saved.id, {}, fast), controller = new AbortController();
    await expect(store.seek(200, { ...fast, signal: controller.signal, beforePublish: async prepared => { expect(prepared.state).toEqual(states[200]); expect(store.cursor).toBe(0); expect(store.state).toEqual(states[0]); controller.abort(); } })).rejects.toThrow();
    expect(store.cursor).toBe(0); expect(store.state).toEqual(states[0]); await store.seek(1, fast); expect(store.state).toEqual(states[1]);
  });
  it('despejo de checkpoints derivados volta à origem sem perder a gravação', async () => {
    const { library, checkpoints } = setup(), { session, states } = record('i = 0\nwhile i < 100:\n    i += 1');
    const saved = await library.save(session, details, fast), store = await PagedHistoryStore.open(library, checkpoints, saved.id, {}, fast);
    vi.spyOn(checkpoints, 'readCheckpoint').mockResolvedValue(null); await store.seek(0, fast); await store.seek(550, fast); expect(store.state).toEqual(states[550]);
    expect(await library.list()).toEqual([saved]);
  });
  it('checkpoint adulterado recusa o salto preservando estado e dados originais', async () => {
    const { library, checkpoints } = setup(), { session } = record('i = 0\nwhile i < 100:\n    i += 1'); session.seek(0);
    const saved = await library.save(session, details, fast), store = await PagedHistoryStore.open(library, checkpoints, saved.id, {}, fast);
    vi.spyOn(checkpoints, 'readCheckpoint').mockResolvedValue('{"malformed":true}'); await expect(store.seek(550, fast)).rejects.toThrow(); expect(store.state).toEqual(initialState()); expect(store.cursor).toBe(0); expect(await library.list()).toEqual([saved]);
  });
  it('bloco ausente/corrompido após abrir não publica uma restauração parcial', async () => {
    const { library, checkpoints } = setup(), { session } = record('i = 0\nwhile i < 100:\n    i += 1'); session.seek(0);
    const saved = await library.save(session, details, fast), store = await PagedHistoryStore.open(library, checkpoints, saved.id, { cacheBytes: 1 }, fast);
    vi.spyOn(library, 'readBlock').mockRejectedValue(new Error('checksum não confere')); await expect(store.seek(550, fast)).rejects.toThrow(/checksum/); expect(store.cursor).toBe(0); expect(store.state).toEqual(initialState());
  });
  it('indexação interrompida não publica índice incompleto e a tentativa seguinte recupera', async () => {
    const { library, checkpoints } = setup(), { session } = record('i = 0\nwhile i < 80:\n    i += 1'); const saved = await library.save(session, details, fast), controller = new AbortController();
    await expect(PagedHistoryStore.open(library, checkpoints, saved.id, {}, { ...fast, signal: controller.signal, onProgress: () => controller.abort() })).rejects.toThrow();
    expect(await checkpoints.find(`${saved.id}:${(await library.openRecording(saved.id)).checksum}`)).toBeNull();
    const next = await PagedHistoryStore.open(library, checkpoints, saved.id, {}, fast); expect(next.stats.indexBuilt).toBe(true); expect(next.state).toEqual(session.state);
  });
  it('limite de cache muda sem truncar registros, e orçamento insuficiente recusa abertura', async () => {
    const { library, checkpoints } = setup(), { session } = record('i = 0\nwhile i < 80:\n    i += 1'); const saved = await library.save(session, details, fast), store = await PagedHistoryStore.open(library, checkpoints, saved.id, {}, fast);
    const before = structuredClone(store.state); store.setCacheBudget(1); expect(store.stats.bytes).toBe(0); expect(store.state).toEqual(before);
    expect(() => store.setCacheBudget(0)).toThrow(); expect(() => store.setCacheBudget(8 * 1024 * 1024 + 1)).toThrow(); await expect(store.seek(-1, fast)).rejects.toThrow(); expect(store.state).toEqual(before);
    await expect(PagedHistoryStore.open(library, checkpoints, saved.id, { maxHistoryBytes: 500 }, fast)).rejects.toThrow(/Orçamento/); expect(await library.list()).toEqual([saved]);
  });
  it('vazio e parcial mantêm início/fronteira sem executar código', async () => {
    const { library, checkpoints } = setup();
    for (const source of ['', 'while True:\n    pass']) {
      const { session } = record(source, 30); if (!source) session.restart(); const saved = await library.save(session, details, fast), store = await PagedHistoryStore.open(library, checkpoints, saved.id, {}, fast);
      expect(store.count).toBe(session.history.length); expect(store.state).toEqual(session.state); await store.seek(0, fast); expect(store.state).toEqual(initialState()); await store.seek(store.count, fast); expect(store.state).toEqual(session.state);
    }
  });
  it('transação indivisível maior que o cache é lida isoladamente e pode ser desfeita', async () => {
    const { library, checkpoints } = setup(), source = `a = [${Array.from({ length: 800 }, () => '1'.repeat(700)).join(',')}]`;
    const session = new DebugSession(source, { language: 'python' }); while (session.canForward) session.runBatch(); const final = structuredClone(session.state);
    const saved = await library.save(session, details, fast), store = await PagedHistoryStore.open(library, checkpoints, saved.id, { cacheBytes: 64 * 1024 }, fast);
    await store.seek(800, fast); await store.seek(801, fast); expect(store.stats.largeBlocks).toBeGreaterThan(0); expect(store.stats.bytes).toBeLessThanOrEqual(64 * 1024);
    await store.seek(800, fast); await store.seek(store.count, fast); expect(store.state).toEqual(final); expect(store.stats.estimatedBytes).toBeLessThanOrEqual(store.stats.limitTotalBytes);
  });
});
