import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { DEFAULT_EXECUTION_LIMITS, validateExecutionLimits } from '../src/core/execution-limits';
import { DebugSession, HistoryLimitError } from '../src/core/debugger';
import { ExecutionControl } from '../src/core/execution-control';
import { LiveRecording } from '../src/core/live-recording';
import { RecordingJournal } from '../src/core/recording-journal';
import { ExecutionLibrary } from '../src/core/execution-library';
import { CheckpointCache } from '../src/core/checkpoint-cache';
import { PagedHistoryStore } from '../src/core/paged-history';
import { captureRecording, validateManifest } from '../src/core/history-blocks';
import { digest, encode, exportHistory, importHistory } from '../src/core/portable-history';
import { readExecutionSettings, writeExecutionSettings, removeExecutionSettings } from '../src/ui/execution-settings';
import * as machine from '../src/core/machine';

const runtime = { language: 'python', version: '3' } as const, fast = { yieldControl: async () => {} }, details = { name: 'Limites', filename: 'limits.py' };
const resources: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(resources.splice(0).map(r => r.close())); });
describe('limites configuráveis sem perda do futuro', () => {
  for (const maxSteps of [0, -1, 1.5, NaN, Infinity, 50001]) it(`recusa limite de passos inválido ${maxSteps}`, () => {
    expect(() => new DebugSession('', { maxSteps })).toThrow();
  });
  for (const maxFrames of [1, 2.5, NaN, Infinity, 257]) it(`recusa limite de pilha inválido ${maxFrames}`, () => {
    expect(() => validateExecutionLimits({ maxSteps: 50000, maxFrames })).toThrow();
  });
  it('mantém padrão, aumenta sem reexecutar e recusa redução incompatível atomicamente', () => {
    expect(new DebugSession('').maxSteps).toBe(20000);
    const s = new DebugSession('while True:\n    pass', { ...runtime, maxSteps: 17 }), c = new ExecutionControl(s);
    c.start('continue'); expect(c.runBatch(100).stop?.reason).toBe('budget');
    const before = JSON.stringify(encode(s.state)), records = [...s.history];
    expect(() => s.setExecutionLimits({ maxSteps: 16, maxFrames: 32 })).toThrow(/histórico/);
    expect([s.maxSteps, s.maxFrames]).toEqual([17, 256]);
    s.setExecutionLimits({ maxSteps: 31, maxFrames: 32 });
    expect(JSON.stringify(encode(s.state))).toBe(before); expect(s.history).toEqual(records);
    c.start('continue'); c.runBatch(100); expect(s.cursor).toBe(31);
    expect(() => s.forward()).toThrow(HistoryLimitError);
    const execute = vi.spyOn(machine, 'executeInstruction'); s.seek(0); s.seek(31); expect(execute).not.toHaveBeenCalled();
    const fork = s.forkRecording(); expect([fork.maxSteps, fork.maxFrames]).toEqual([31, 32]);
    expect(() => fork.setExecutionLimits(DEFAULT_EXECUTION_LIMITS)).toThrow(/importada/);
    fork.restart(); expect([fork.maxSteps, fork.maxFrames]).toEqual([31, 32]);
  });
  it('considera profundidade do futuro ao reduzir a pilha', () => {
    const s = new DebugSession('def f(n):\n    if n <= 0:\n        return 1\n    return f(n - 1)\nresult = f(5)', runtime);
    while (s.canForward) s.forward(); s.seek(0);
    expect(() => s.setExecutionLimits({ maxSteps: 50000, maxFrames: 3 })).toThrow(/futuro/);
    expect([s.maxSteps, s.maxFrames]).toEqual([20000, 256]);
    s.setExecutionLimits({ maxSteps: 50000, maxFrames: 7 }); s.seek(s.history.length); expect(s.state.frames[0]!.locals.result).toBe(1n);
  });
  it('mantém escrita legada e recusa limite ampliado disfarçado em arquivo v2', async () => {
    const s = new DebugSession('result = 42', runtime); while (s.canForward) s.forward();
    const old = JSON.parse(await exportHistory(s, details, fast)); expect(old.version).toBe(2);
    expect((await importHistory(JSON.stringify(old), fast)).session.state).toEqual(s.state);
    old.payload.limits.maxSteps = 50000; old.checksum = await digest(JSON.stringify(old.payload));
    await expect(importHistory(JSON.stringify(old), fast)).rejects.toThrow(/limites/);
    s.setExecutionLimits({ maxSteps: 50000, maxFrames: 64 }); const extended = JSON.parse(await exportHistory(s, details, fast));
    expect(extended.version).toBe(3); expect((await importHistory(JSON.stringify(extended), fast)).session.maxSteps).toBe(50000);
    extended.version = 99; await expect(importHistory(JSON.stringify(extended), fast)).rejects.toThrow(/versão/);
  });
  it('persiste configurações por programa sem escrever em dados ilegíveis', () => {
    const data = new Map<string, string>(); vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) });
    expect(readExecutionSettings('a')).toEqual(DEFAULT_EXECUTION_LIMITS);
    expect(writeExecutionSettings('a', { maxSteps: 50000, maxFrames: 32 })).toBeNull();
    expect(readExecutionSettings('a')).toEqual({ maxSteps: 50000, maxFrames: 32 }); expect(readExecutionSettings('b')).toEqual(DEFAULT_EXECUTION_LIMITS);
    removeExecutionSettings('a'); expect(readExecutionSettings('a')).toEqual(DEFAULT_EXECUTION_LIMITS);
    data.set('rewind.execution-limits.v1', '{broken'); expect(readExecutionSettings('a')).toEqual(DEFAULT_EXECUTION_LIMITS);
    expect(writeExecutionSettings('a', DEFAULT_EXECUTION_LIMITS)).toBeTruthy(); expect(data.get('rewind.execution-limits.v1')).toBe('{broken');
  });
  it('recusa sessão inválida antes de criar dados persistidos', async () => {
    const journal = new RecordingJournal(new IDBFactory(), 'invalid-limits'); resources.push(journal);
    await expect(LiveRecording.start(journal, 'result = 1', runtime, details, { maxSteps: 50001 }, fast)).rejects.toThrow(/passos/);
    await expect(LiveRecording.start(journal, 'result = 1', runtime, details, { maxFrames: 257 }, fast)).rejects.toThrow(/pilha/);
    expect(await journal.list()).toEqual([]);
  });
  it('recusa limite ampliado num manifesto legado com checksum recalculado', async () => {
    const s = new DebugSession('result = 1', { ...runtime, maxSteps: 50000 });
    const snapshot = await captureRecording(s, details, 'limits-manifest', 0);
    const manifest = { header: { ...snapshot.header, version: 1 }, blocks: [] };
    const content = JSON.stringify(manifest);
    await expect(validateManifest(content, await digest(content), 'limits-manifest')).rejects.toThrow(/limites/);
  });
  it('exportação e captura congelam limites antes do primeiro await', async () => {
    const s = new DebugSession('while True:\n    pass', { ...runtime, maxSteps: 50000, maxFrames: 32 });
    for (let i = 0; i < 17; i++) s.forward();
    const capturing = captureRecording(s, details, 'capture', 0);
    s.restart(); s.setExecutionLimits({ maxSteps: 10, maxFrames: 16 });
    const capture = await capturing; expect(capture.header.version).toBe(2); expect(capture.header.limits).toEqual({ maxSteps: 50000, maxFrames: 32 }); expect(capture.records).toHaveLength(17);
    s.setExecutionLimits({ maxSteps: 50000, maxFrames: 32 }); for (let i = 0; i < 17; i++) s.forward();
    let changed = false;
    const exported = await exportHistory(s, details, { yieldControl: async () => { if (!changed) { changed = true; s.restart(); s.setExecutionLimits({ maxSteps: 10, maxFrames: 16 }); } } });
    expect(JSON.parse(exported).version).toBe(3); const imported = await importHistory(exported, fast);
    expect(imported.session.maxSteps).toBe(50000); expect(imported.session.history).toHaveLength(17); expect(imported.session.cursor).toBe(17);
  });
  it('preserva 50 mil passos em journal, cache, captura e arquivo, misturados com legado', async () => {
    const source = 'i = 0\nwhile True:\n    i += 1', factory = new IDBFactory(), journal = new RecordingJournal(factory, 'limits'); resources.push(journal);
    const legacy = await LiveRecording.start(journal, 'result = 42', runtime, details, {}, fast); while (legacy.ledger.canRecord) await legacy.seek(legacy.count + 1, fast); await legacy.close();
    const live = await LiveRecording.start(journal, source, runtime, details, { maxSteps: 50000, maxFrames: 64, cacheBytes: 16384 }, fast);
    while (live.ledger.canRecord) await live.seek(live.count + 1, fast);
    expect(live.count).toBe(50000); expect(live.ledger.durable).toBe(50000);
    expect((await journal.open(live.entry.id)).source.version).toBe(2); expect((await journal.open(legacy.entry.id)).source.version).toBe(1);
    expect(await journal.list()).toHaveLength(2);
    const targets = [0, 19999, 20000, 20001, 32769, 49999, 50000], states = new Map<number, string>();
    for (const target of targets) { await live.seek(target, fast); states.set(target, JSON.stringify(encode(live.state))); }
    await live.close(); const execute = vi.spyOn(machine, 'executeInstruction');
    const resumed = await LiveRecording.resume(journal, live.entry.id, { validateAll: true, cacheBytes: 16384 }, fast);
    for (const target of [...targets].reverse()) { await resumed.seek(target, fast); expect(JSON.stringify(encode(resumed.state))).toBe(states.get(target)); }
    expect(execute).not.toHaveBeenCalled(); await resumed.close(); execute.mockRestore();
    const session = new DebugSession(source, { ...runtime, maxSteps: 50000, maxFrames: 64 });
    for (let i = 0; i < 50000; i++) session.forward();
    for (const target of targets) { session.seek(target); expect(JSON.stringify(encode(session.state))).toBe(states.get(target)); }
    const text = await exportHistory(session, details, fast); expect(JSON.parse(text).version).toBe(3);
    const imported = await importHistory(text, fast); expect(imported.session.maxSteps).toBe(50000); expect(imported.session.maxFrames).toBe(64);
    for (const target of targets) { imported.session.seek(target); expect(JSON.stringify(encode(imported.session.state))).toBe(states.get(target)); }
    const library = new ExecutionLibrary({ factory, name: 'capture-limits' }), checkpoints = new CheckpointCache(factory, 'points-limits'); resources.push(library, checkpoints);
    const oldSession = new DebugSession('result = 1', runtime); while (oldSession.canForward) oldSession.forward();
    const old = await library.save(oldSession, details, fast); expect((await library.openRecording(old.id)).manifest.header.version).toBe(1);
    const saved = await library.save(session, details, fast); expect((await library.openRecording(saved.id)).manifest.header.version).toBe(2);
    expect(await library.list()).toHaveLength(2);
    const reader = await PagedHistoryStore.open(library, checkpoints, saved.id, { cacheBytes: 16384 }, fast);
    for (const target of targets) { await reader.seek(target, fast); expect(JSON.stringify(encode(reader.state))).toBe(states.get(target)); }
    reader.dispose();
  }, 60_000);
});
