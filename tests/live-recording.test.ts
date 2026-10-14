import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { HistoryBudgetError } from '../src/core/history';
import fc from 'fast-check';
import { RecordingJournal, WriterConflictError } from '../src/core/recording-journal';
import { LiveRecording } from '../src/core/live-recording';
import { DebugSession } from '../src/core/debugger';
import * as machine from '../src/core/machine';
const fast = { yieldControl: async () => {} }, runtime = { language: 'python', version: '3' } as const, details = { name: 'Sessão de teste', filename: 'sessao.py' };
const resources: RecordingJournal[] = [];
function setup(options: { maxDiskBytes?: number; maxEntries?: number } = {}) { const factory = new IDBFactory(), journal = new RecordingJournal(factory, 'journal', options); resources.push(journal); return { factory, journal }; }
function oracle(source: string, maxSteps = 20_000) { const session = new DebugSession(source, { ...runtime, maxSteps }), states = [structuredClone(session.state)]; while (session.canForward && session.history.length < maxSteps) { session.forward(); states.push(structuredClone(session.state)); } return { session, states }; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(resources.splice(0).map(j => j.close())); });
describe('gravação incremental durável', () => {
  for (const source of [
    'def sum_to(n):\n    total = 0\n    i = 1\n    while i < n:\n        total += i\n        i += 1\n    return total\nresult = sum_to(5)\nprint(result)',
    'a = [1, 2]\nb = a\na.append(a)\ndef change(x):\n    x[0] = 99\n    return x\nc = change(b)\nprint(c)\nresult = c[99]',
    'def fact(n):\n    if n <= 1:\n        return 1\n    return n * fact(n - 1)\nresult = fact(6)',
    'a = 90071992547409931234567890\nb = -0.0\nc = 1e308 * 1e308\nd = c - c\ne = None\n__proto__ = a\nconstructor = print\nprint(a, b, d)',
  ]) it(`grava uma vez, restaura todos os estados e retoma: ${source.slice(0, 24)}`, async () => {
    const { journal } = setup(), { session, states } = oracle(source), live = await LiveRecording.start(journal, source, runtime, details, { bufferBytes: 4096, cacheBytes: 2048 }, fast), execute = vi.spyOn(machine, 'executeInstruction');
    while (live.ledger.canRecord) { await live.seek(live.count + 1, fast); expect(live.state).toEqual(states[live.cursor]); expect(live.ledger.pendingBytes <= 4096 || live.ledger.oversized).toBe(true); }
    expect(execute).toHaveBeenCalledTimes(session.history.length); execute.mockClear();
    for (let i = states.length - 1; i >= 0; i--) { await live.seek(i, fast); expect(live.state).toEqual(states[i]); }
    for (let i = 0; i < states.length; i++) { await live.seek(i, fast); expect(live.state).toEqual(states[i]); }
    expect(execute).not.toHaveBeenCalled(); await live.seek(3, fast); await live.close();
    const resumed = await LiveRecording.resume(journal, live.entry.id, { cacheBytes: 2048 }, fast); expect(resumed.cursor).toBe(3); expect(resumed.state).toEqual(states[3]); expect(resumed.count).toBe(session.history.length); expect(execute).not.toHaveBeenCalled(); await resumed.close();
  });
  it('falha atômica de escrita mantém buffer, estado, futuro e prefixo anterior', async () => {
    const { journal } = setup(), { states } = oracle('i = 0\nwhile i < 60:\n    print(i)\n    i += 1'), live = await LiveRecording.start(journal, 'i = 0\nwhile i < 60:\n    print(i)\n    i += 1', runtime, details, {}, fast);
    for (let i = 0; i < 20; i++) await live.seek(live.count + 1, fast); await live.flush(); const durable = live.ledger.durable;
    for (let i = 0; i < 15; i++) await live.seek(live.count + 1, fast); const frontier = live.count, before = structuredClone(live.state), write = vi.spyOn(journal, 'commit').mockRejectedValue(new Error('Disco cheio'));
    expect(await live.flush()).toBe(false); expect(live.ledger.durable).toBe(durable); expect(live.ledger.pendingSteps).toBe(15); expect(live.ledger.canRecord).toBe(false); expect(live.state).toEqual(before); expect((await journal.open(live.entry.id)).head.frontier).toBe(durable);
    await live.seek(0, fast); await live.seek(frontier, fast); expect(live.state).toEqual(states[frontier]); write.mockRestore(); expect(await live.flush()).toBe(true); expect(live.ledger.durable).toBe(frontier); expect(live.ledger.pendingSteps).toBe(0); expect(live.ledger.canRecord).toBe(true);
  });
  it('pré-flush não reexecuta a instrução preparada e não excede o buffer', async () => {
    const { journal } = setup(), { session } = oracle('i = 0\nwhile i < 30:\n    i += 1'), live = await LiveRecording.start(journal, 'i = 0\nwhile i < 30:\n    i += 1', runtime, details, { bufferBytes: 900 }, fast), execute = vi.spyOn(machine, 'executeInstruction');
    while (live.ledger.canRecord) await live.seek(live.count + 1, fast); expect(execute).toHaveBeenCalledTimes(session.history.length); expect(live.ledger.pendingSteps).toBe(0); expect(live.ledger.durable).toBe(live.count);
  });
  it('confirmação cancelada desfaz a instrução especulativa sem registrá-la', async () => {
    const { journal } = setup(), live = await LiveRecording.start(journal, 'result = 42', runtime, details, {}, fast), initial = structuredClone(live.state), abort = new AbortController();
    await expect(live.seek(1, { ...fast, signal: abort.signal, beforePublish: async prepared => { expect(prepared.cursor).toBe(1); expect(live.cursor).toBe(0); abort.abort(); } })).rejects.toThrow(); expect(live.cursor).toBe(0); expect(live.count).toBe(0); expect(live.state).toEqual(initial); expect(live.ledger.pendingSteps).toBe(0); await live.seek(1, fast); expect(live.count).toBe(1);
  });
  it('resposta perdida após commit é reconciliada sem duplicar blocos/saída', async () => {
    const { journal } = setup(), live = await LiveRecording.start(journal, 'print(42)\nresult = 1', runtime, details, {}, fast); for (let i = 0; i < 3; i++) await live.seek(live.count + 1, fast);
    const original = journal.commit.bind(journal); vi.spyOn(journal, 'commit').mockImplementation(async (...args) => { await original(...args); throw new Error('Resposta perdida'); }); expect(await live.flush()).toBe(true); const disk = await journal.open(live.entry.id); expect(disk.head.frontier).toBe(3); expect(disk.head.blocks).toHaveLength(1); expect(live.ledger.pendingSteps).toBe(0); expect(await live.flush()).toBe(true); expect((await journal.open(live.entry.id)).head.blocks).toHaveLength(1);
  });
  it('duas abas não assumem o mesmo escritor, e a retomada valida a revisão', async () => {
    const { factory, journal } = setup(), other = new RecordingJournal(factory, 'journal'); resources.push(other); const live = await LiveRecording.start(journal, 'result = 42', runtime, details, {}, fast);
    await expect(LiveRecording.resume(other, live.entry.id, {}, fast)).rejects.toBeInstanceOf(WriterConflictError); await live.seek(1, fast); await live.close(); const next = await LiveRecording.resume(other, live.entry.id, {}, fast); expect(next.count).toBe(1); expect(next.cursor).toBe(1); await next.close();
  });
  it('processo interrompido recupera somente a fronteira durável após a lease expirar', async () => {
    const { journal } = setup(), { states } = oracle('i = 0\nwhile i < 20:\n    i += 1'), live = await LiveRecording.start(journal, 'i = 0\nwhile i < 20:\n    i += 1', runtime, details, {}, fast);
    for (let i = 0; i < 12; i++) await live.seek(live.count + 1, fast); await live.flush(); for (let i = 0; i < 5; i++) await live.seek(live.count + 1, fast);
    const date = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5001); const recovered = await LiveRecording.resume(journal, live.entry.id, {}, fast); expect(recovered.count).toBe(12); expect(recovered.state).toEqual(states[12]); await expect(journal.renew(live.entry.id, live.owner)).rejects.toBeInstanceOf(WriterConflictError); expect(live.count).toBe(17); date.mockRestore(); await recovered.close();
  });
  it('navegação gerada cruza blocos duráveis e futuros voláteis sem executor', async () => {
    const { journal } = setup(), { states } = oracle('a = [0]\nb = a\ni = 0\nwhile i < 40:\n    b[0] = i\n    i += 1'), live = await LiveRecording.start(journal, 'a = [0]\nb = a\ni = 0\nwhile i < 40:\n    b[0] = i\n    i += 1', runtime, details, { bufferBytes: 4096, cacheBytes: 2048 }, fast);
    for (let i = 0; i < 220; i++) await live.seek(live.count + 1, fast); const execute = vi.spyOn(machine, 'executeInstruction'); await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 0, max: live.count }), { maxLength: 30 }), async targets => { for (const target of targets) { await live.seek(target, fast); expect(live.state).toEqual(states[target]); expect(live.stats.bytes).toBeLessThanOrEqual(2048); } }), { numRuns: 10, seed: 20261014 }); expect(execute).not.toHaveBeenCalled();
  });
  it('quota real aborta bloco/head juntos, permitindo retry com o mesmo buffer', async () => {
    const { journal } = setup(), live = await LiveRecording.start(journal, 'result = 42', runtime, details, {}, fast); await live.seek(1, fast); const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: any, key?: IDBValidKey) { if (this.name === 'heads') throw new DOMException('Cheio', 'QuotaExceededError'); return put.call(this, value, key); }); expect(await live.flush()).toBe(false); expect((await journal.open(live.entry.id)).head.frontier).toBe(0); expect(live.ledger.pendingSteps).toBe(1); vi.restoreAllMocks(); expect(await live.flush()).toBe(true); expect((await journal.open(live.entry.id)).head.frontier).toBe(1);
  });
  it('captura por lotes inclui futuro volátil e restaura no cursor selecionado', async () => {
    const { journal } = setup(), { states } = oracle('result = 40 + 2\nprint(result)'), live = await LiveRecording.start(journal, 'result = 40 + 2\nprint(result)', runtime, details, {}, fast); for (let i = 0; i < 5; i++) await live.seek(live.count + 1, fast); await live.seek(1, fast);
    const records = await live.readRange(0, live.count, fast), session = await DebugSession.restoreRecording(live.source.source, { ...runtime, maxSteps: 20_000, maxFrames: 256 }, records, live.cursor, fast); expect(session.history).toHaveLength(5); expect(session.state).toEqual(states[1]); session.seek(5); expect(session.state).toEqual(states[5]);
  });
  it('orçamento recusa a próxima instrução antes da confirmação, preservando o estado', async () => {
    const { journal } = setup(), source = 'i = 0\nwhile i < 100:\n    print(i)\n    i += 1', live = await LiveRecording.start(journal, source, runtime, details, { maxHistoryBytes: 7000 }, fast);
    let refused = false;
    for (let i = 0; i < 100; i++) {
      const before = structuredClone(live.state), count = live.count, accept = vi.fn(async () => {});
      try { await live.seek(count + 1, { ...fast, beforePublish: accept }); }
      catch (cause) { expect(cause).toBeInstanceOf(HistoryBudgetError); expect(accept).not.toHaveBeenCalled(); expect(live.state).toEqual(before); expect(live.count).toBe(count); refused = true; break; }
      expect(live.stats.estimatedBytes).toBeLessThanOrEqual(7000);
    }
    expect(refused).toBe(true); await live.seek(0, fast); await live.seek(live.count, fast);
  });
  it('quota de sessões e disco não substitui registros existentes', async () => {
    const { journal } = setup({ maxEntries: 1, maxDiskBytes: 4000 }), live = await LiveRecording.start(journal, 'i = 0\nwhile i < 50:\n    i += 1', runtime, details, {}, fast);
    await expect(LiveRecording.start(journal, 'result = 1', runtime, details, {}, fast)).rejects.toThrow('cheia');
    for (let i = 0; i < 15; i++) await live.seek(live.count + 1, fast);
    expect(await live.flush()).toBe(false); expect(live.ledger.pendingSteps).toBe(15); expect((await journal.open(live.entry.id)).head.frontier).toBe(0); expect(await journal.list()).toHaveLength(1);
  });
  it('limite de passos salva o prefixo parcial e permite replay e retomada', async () => {
    const { journal } = setup(), live = await LiveRecording.start(journal, 'while True:\n    print(1)', runtime, details, { maxSteps: 7 }, fast);
    while (live.ledger.canRecord) await live.seek(live.count + 1, fast);
    expect(live.count).toBe(7); expect(live.ledger.durable).toBe(7); expect(live.ledger.pendingSteps).toBe(0); expect(live.state.control.status).toBe('running');
    await live.seek(0, fast); await live.close(); const resumed = await LiveRecording.resume(journal, live.entry.id, {}, fast); expect(resumed.cursor).toBe(0); await resumed.seek(7, fast); expect(resumed.ledger.canRecord).toBe(false); await expect(resumed.seek(8, fast)).rejects.toThrow('7 passos');
  });
  it('rejeita checkpoint e bloco corrompidos sem tomar o escritor ou apagar dados', async () => {
    const { factory, journal } = setup(), live = await LiveRecording.start(journal, 'result = 42', runtime, details, {}, fast); await live.seek(1, fast); await live.close();
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = factory.open('journal', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const row = await new Promise<any>(resolve => { const r = db.transaction('blocks').objectStore('blocks').get([live.entry.id, 0]); r.onsuccess = () => resolve(r.result); });
    const put = (store: string, value: unknown) => new Promise<void>((resolve, reject) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    await put('blocks', { ...row, content: '[]' }); await expect(LiveRecording.resume(journal, live.entry.id, {}, fast)).rejects.toThrow('corrompido'); expect((await journal.list())[0]!.owner).toBeNull(); await put('blocks', row);
    const head = await new Promise<any>(resolve => { const r = db.transaction('heads').objectStore('heads').get(live.entry.id); r.onsuccess = () => resolve(r.result); });
    await put('heads', { ...head, content: '{}' }); await expect(LiveRecording.resume(journal, live.entry.id, {}, fast)).rejects.toThrow('corrompido'); expect(await journal.list()).toHaveLength(1); db.close();
  });
  it('continua após retomada sem reexecutar o prefixo e exclui apenas a sessão fechada', async () => {
    const { journal } = setup(), { states } = oracle('result = 40 + 2\nprint(result)'), live = await LiveRecording.start(journal, 'result = 40 + 2\nprint(result)', runtime, details, {}, fast);
    for (let i = 0; i < 3; i++) await live.seek(live.count + 1, fast); await expect(journal.delete(live.entry.id)).rejects.toThrow('Feche'); await live.seek(1, fast); await live.close();
    const execute = vi.spyOn(machine, 'executeInstruction'), resumed = await LiveRecording.resume(journal, live.entry.id, {}, fast); await resumed.seek(3, fast); expect(execute).not.toHaveBeenCalled(); await resumed.seek(4, fast); expect(execute).toHaveBeenCalledTimes(1); expect(resumed.state).toEqual(states[4]); await resumed.close(); await journal.delete(live.entry.id); expect(await journal.list()).toEqual([]);
  });
  it('orçamento inicial impossível não cria uma sessão no disco', async () => {
    const { journal } = setup(); await expect(LiveRecording.start(journal, 'result = 42', runtime, details, { maxHistoryBytes: 1 }, fast)).rejects.toBeInstanceOf(HistoryBudgetError); expect(await journal.list()).toEqual([]);
  });
  it('banco de versão futura é recusado sem apagar seus dados', async () => {
    const factory = new IDBFactory(), db = await new Promise<IDBDatabase>(resolve => { const r = factory.open('future', 2); r.onupgradeneeded = () => r.result.createObjectStore('sentinel'); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>(resolve => { const tx = db.transaction('sentinel', 'readwrite'); tx.objectStore('sentinel').put('preservado', 'data'); tx.oncomplete = () => resolve(); }); db.close();
    const journal = new RecordingJournal(factory, 'future'); resources.push(journal); await expect(journal.list()).rejects.toThrow('VersionError');
    const reopened = await new Promise<IDBDatabase>(resolve => { const r = factory.open('future', 2); r.onsuccess = () => resolve(r.result); });
    expect(await new Promise(resolve => { const r = reopened.transaction('sentinel').objectStore('sentinel').get('data'); r.onsuccess = () => resolve(r.result); })).toBe('preservado'); reopened.close();
  });
});
