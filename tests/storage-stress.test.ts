import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { stressFixtures, stressRuntime } from '../scripts/stress-fixtures';
import { RecordingJournal, LIVE_BLOCK_BYTES } from '../src/core/recording-journal';
import { LiveRecording } from '../src/core/live-recording';
import { DebugSession } from '../src/core/debugger';
import { ExecutionLibrary } from '../src/core/execution-library';
import { CheckpointCache } from '../src/core/checkpoint-cache';
import { PagedHistoryStore } from '../src/core/paged-history';
import { HistoryBudgetError } from '../src/core/history';
import { encode, exportHistory, importHistory } from '../src/core/portable-history';
import { encodedBytes } from '../src/core/storage-accounting';
import * as machine from '../src/core/machine';

const stressSteps = Number(process.env.REWIND_STRESS_STEPS ?? 20000);
const fast = { yieldControl: async () => {} }, details = { name: 'Estresse', filename: 'stress.py' };
const resources: Array<{ close(): Promise<void> }> = [];
function setup() {
  const factory = new IDBFactory(), journal = new RecordingJournal(factory, 'stress');
  resources.push(journal); return { factory, journal };
}
const sameState = (state: unknown, oracle: DebugSession) => expect(encode(state)).toEqual(encode(oracle.state));
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(resources.splice(0).map(r => r.close())); });

describe('estresse de estados e transações indivisíveis', () => {
  for (const fixture of stressFixtures) it(`preserva journal, checkpoint, captura e arquivo: ${fixture.id}`, async () => {
    const { journal, factory } = setup(), live = await LiveRecording.start(journal, fixture.source, stressRuntime, details, { maxSteps: stressSteps, cacheBytes: 1024, bufferBytes: 32768 }, fast);
    const oracle = new DebugSession(fixture.source, { ...stressRuntime, maxSteps: stressSteps, maxHistoryBytes: 64 * 1024 * 1024 });
    while (live.ledger.canRecord) await live.seek(live.count + 1, fast);
    while (oracle.canForward) oracle.forward();
    expect(live.count).toBe(oracle.cursor); sameState(live.state, oracle);
    expect(live.ledger.pauseReason).toBeNull();
    const snapshot = await journal.open(live.entry.id), points = await journal.checkpoints.list(snapshot);
    expect(points.reduce((n, p) => n + p.bytes, 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
    if (fixture.oversizedOp) {
      const large = snapshot.head.blocks.filter(b => b.bytes > LIVE_BLOCK_BYTES);
      expect(large.length).toBeGreaterThan(0); expect(large.every(b => b.count === 1)).toBe(true);
      const index = oracle.history.findIndex(s => s.op === fixture.oversizedOp && encodedBytes(s) > LIVE_BLOCK_BYTES);
      expect(index).toBeGreaterThan(0);
      for (const target of [index, index + 1, index, index + 1]) { await live.seek(target, fast); oracle.seek(target); sameState(live.state, oracle); }
      expect(live.stats.largeBlocks).toBeGreaterThan(0); expect(live.stats.bytes).toBeLessThanOrEqual(1024);
    } else {
      // Enough cumulative output to exceed 8 MiB if every point were retained.
      expect(points.length).toBeLessThan(snapshot.head.blocks.length / 2);
      expect(points.some(p => p.bytes > 500_000)).toBe(true);
    }
    const frontier = live.count, execute = vi.spyOn(machine, 'executeInstruction');
    for (const target of [0, frontier, Math.floor(frontier / 2), 1, frontier - 1, 0]) {
      await live.seek(target, fast); oracle.seek(target); sameState(live.state, oracle);
      expect(live.stats.estimatedBytes).toBeLessThanOrEqual(live.limitBytes);
    }
    const reads = vi.spyOn(journal, 'readBlock'), builder = DebugSession.recordingBuilder(fixture.source, { ...stressRuntime, maxSteps: stressSteps, maxFrames: 256 }, frontier, 0);
    for await (const batch of live.streamRecords(frontier, fast)) { expect(batch.length).toBeLessThanOrEqual(16); builder.append(batch); }
    expect(reads).toHaveBeenCalledTimes(snapshot.head.blocks.length); reads.mockRestore();
    const streamed = await builder.finish(fast);
    for (const target of [frontier, 0, Math.floor(frontier / 2), frontier]) { streamed.seek(target); oracle.seek(target); sameState(streamed.state, oracle); }
    expect(execute).not.toHaveBeenCalled();
    await live.close();
    const resumed = await LiveRecording.resume(journal, live.entry.id, { cacheBytes: 1024, validateAll: true }, fast);
    expect(resumed.cursor).toBe(0); await resumed.seek(frontier, fast); oracle.seek(frontier); sameState(resumed.state, oracle);
    expect(execute).not.toHaveBeenCalled(); await resumed.close(); execute.mockRestore();

    // Captures preserve VM2 semantics and select the envelope by declared limits.
    oracle.seek(0);
    const library = new ExecutionLibrary({ factory, name: 'saved-stress' }), cache = new CheckpointCache(factory, 'derived-stress');
    resources.push(library, cache);
    const saved = await library.save(oracle, details, fast), reader = await PagedHistoryStore.open(library, cache, saved.id, { cacheBytes: 1024 }, fast);
    for (const target of [frontier, 0, Math.floor(frontier / 2), frontier]) { await reader.seek(target, fast); oracle.seek(target); sameState(reader.state, oracle); }
    reader.dispose();
    const exported = await exportHistory(oracle, details, fast), imported = await importHistory(exported, fast);
    sameState(imported.session.state, oracle); imported.session.seek(0); oracle.seek(0); sameState(imported.session.state, oracle);
  }, 30_000);

  it('recusa delta grande pelo orçamento antes do ACK e restaura a VM especulativa', async () => {
    const fixture = stressFixtures[0], { journal } = setup(), live = await LiveRecording.start(journal, fixture.source, stressRuntime, details, { maxSteps: stressSteps, maxHistoryBytes: 2 * 1024 * 1024, cacheBytes: 1024, bufferBytes: 32768 }, fast);
    while (live.program.instructions[live.state.control.pc]?.op !== 'BUILD_LIST') await live.seek(live.count + 1, fast);
    const before = structuredClone(live.state), count = live.count, accept = vi.fn(async () => {});
    await expect(live.seek(count + 1, { ...fast, beforePublish: accept })).rejects.toBeInstanceOf(HistoryBudgetError);
    expect(accept).not.toHaveBeenCalled(); expect(live.state).toEqual(before); expect(live.count).toBe(count);
    await live.seek(0, fast); await live.seek(count, fast); expect(live.state).toEqual(before);
    await live.close(); const resumed = await LiveRecording.resume(journal, live.entry.id, { maxHistoryBytes: 2 * 1024 * 1024 }, fast);
    expect(resumed.state).toEqual(before); expect(resumed.count).toBe(count); await resumed.close();
  });

  it('cancelar a confirmação do delta grande restaura operandos, heap e IDs', async () => {
    const fixture = stressFixtures[0], { journal } = setup(), live = await LiveRecording.start(journal, fixture.source, stressRuntime, details, { maxSteps: stressSteps,}, fast);
    while (live.program.instructions[live.state.control.pc]?.op !== 'BUILD_LIST') await live.seek(live.count + 1, fast);
    const before = structuredClone(live.state), count = live.count, abort = new AbortController();
    await expect(live.seek(count + 1, { ...fast, signal: abort.signal, beforePublish: async prepared => {
      expect(prepared.state.control.nextObjectId).toBe(before.control.nextObjectId + 1); abort.abort();
    } })).rejects.toThrow();
    expect(live.state).toEqual(before); expect(live.count).toBe(count);
    await live.seek(count + 1, fast); expect(Object.keys(live.state.heap)).toEqual(['1']);
    await live.seek(count, fast); expect(live.state).toEqual(before);
  });

  it('quota no head do bloco grande aborta dados e permite retry sem duplicar o delta', async () => {
    const fixture = stressFixtures[0], { journal } = setup(), live = await LiveRecording.start(journal, fixture.source, stressRuntime, details, { maxSteps: stressSteps, bufferBytes: 32768 }, fast);
    while (live.program.instructions[live.state.control.pc]?.op !== 'BUILD_LIST') await live.seek(live.count + 1, fast);
    await live.flush(); const durable = live.count, previous = await journal.open(live.entry.id), put = IDBObjectStore.prototype.put;
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<typeof put>) {
      if (this.name === 'heads') throw new DOMException('Quota controlada', 'QuotaExceededError'); return put.apply(this, args);
    });
    await live.seek(durable + 1, fast); const state = structuredClone(live.state);
    expect(live.ledger.pauseReason).toMatch(/espaço/); expect(live.ledger.pendingSteps).toBe(1); expect(live.ledger.oversized).toBe(true);
    const disk = await journal.open(live.entry.id); expect(disk.head).toEqual(previous.head); expect(disk.entry.bytes).toBe(previous.entry.bytes);
    await live.seek(0, fast); await live.seek(durable + 1, fast); expect(live.state).toEqual(state);
    fault.mockRestore(); expect(await live.flush()).toBe(true);
    const retry = await journal.open(live.entry.id); expect(retry.head.frontier).toBe(durable + 1); expect(retry.head.blocks).toHaveLength(previous.head.blocks.length + 1);
    expect(await live.flush()).toBe(true); expect((await journal.open(live.entry.id)).head.blocks).toHaveLength(retry.head.blocks.length);
  });

  it('falha no pré-flush abandona o delta grande especulativo antes do ACK', async () => {
    const fixture = stressFixtures[0], { journal } = setup(), live = await LiveRecording.start(journal, fixture.source, stressRuntime, details, { maxSteps: stressSteps, bufferBytes: 32768 }, fast);
    while (live.program.instructions[live.state.control.pc]?.op !== 'BUILD_LIST') await live.seek(live.count + 1, fast);
    const before = structuredClone(live.state), count = live.count, pending = live.ledger.pendingSteps, disk = await journal.open(live.entry.id), accept = vi.fn(async () => {});
    expect(pending).toBeGreaterThan(0);
    const fault = vi.spyOn(journal, 'commit').mockRejectedValue(new DOMException('Pré-flush interrompido', 'QuotaExceededError'));
    await expect(live.seek(count + 1, { ...fast, beforePublish: accept })).rejects.toThrow();
    expect(accept).not.toHaveBeenCalled(); expect(live.state).toEqual(before); expect(live.count).toBe(count);
    expect(live.ledger.pendingSteps).toBe(pending); expect((await journal.open(live.entry.id)).head).toEqual(disk.head);
    await live.seek(0, fast); await live.seek(count, fast); expect(live.state).toEqual(before);
    fault.mockRestore(); expect(await live.flush()).toBe(true); await live.seek(count + 1, fast);
    expect(live.state.control.nextObjectId).toBe(before.control.nextObjectId + 1);
    expect(live.count).toBe(count + 1); expect(Object.keys(live.state.heap)).toEqual(['1']);
  });

  it('falhas auxiliares em checkpoint/prefixo grandes não desfazem o journal', async () => {
    const fixture = stressFixtures[1], { journal } = setup(), live = await LiveRecording.start(journal, fixture.source, stressRuntime, details, { maxSteps: stressSteps, bufferBytes: 32768 }, fast);
    vi.spyOn(journal.checkpoints, 'put').mockRejectedValue(new DOMException('Quota auxiliar', 'QuotaExceededError'));
    vi.spyOn(journal.validation, 'publish').mockRejectedValue(new DOMException('Quota auxiliar', 'QuotaExceededError'));
    while (live.ledger.canRecord) await live.seek(live.count + 1, fast);
    expect(live.state.control.status).toBe('halted'); expect(live.ledger.pendingSteps).toBe(0);
    expect(live.ledger.pauseReason).toBeNull(); expect(live.ledger.navigation.warning).toBeTruthy(); expect(live.ledger.validation.cacheWarning).toBeTruthy();
    const state = structuredClone(live.state); await live.close(); vi.restoreAllMocks();
    const resumed = await LiveRecording.resume(journal, live.entry.id, { cacheBytes: 1024 }, fast);
    expect(resumed.ledger.validation.reusedSteps).toBe(0); expect(resumed.state).toEqual(state); await resumed.close();
  });
});
