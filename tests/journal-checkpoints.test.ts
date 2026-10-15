import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { RecordingJournal } from '../src/core/recording-journal';
import { JournalCheckpoints } from '../src/core/journal-checkpoints';
import { LiveRecording } from '../src/core/live-recording';
import { DebugSession } from '../src/core/debugger';
import * as machine from '../src/core/machine';
const runtime = { language: 'python', version: '3' } as const, fast = { yieldControl: async () => {} }, details = { name: 'Saltos', filename: 'saltos.py' };
const source = 'a = [0]\nb = a\ni = 0\nwhile i < 110:\n    b[0] = i\n    print(i)\n    i += 1';
const resources: Array<{ close(): Promise<void> }> = [];
async function setup() {
  const factory = new IDBFactory(), journal = new RecordingJournal(factory, 'seek'); resources.push(journal);
  const live = await LiveRecording.start(journal, source, runtime, details, {}, fast);
  while (live.ledger.canRecord) await live.seek(live.count + 1, fast);
  return { factory, journal, live };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(resources.splice(0).map(r => r.close())); });
describe('checkpoints esparsos de sessões graváveis', () => {
  it('salta a partir do checkpoint próximo e restaura todos os campos sem executor', async () => {
    const { journal, live } = await setup(), oracle = new DebugSession(source, runtime); while (oracle.canForward) oracle.forward();
    const points = await journal.checkpoints.list(await journal.open(live.entry.id)); expect(points.length).toBeGreaterThan(5); const execute = vi.spyOn(machine, 'executeInstruction');
    for (const target of [700, 400, 900, 1, live.count, 0, 650]) { await live.seek(target, fast); oracle.seek(target); expect(live.state).toEqual(oracle.state); if (target === 700) { expect(live.ledger.navigation.appliedSteps).toBeLessThan(128); expect(live.ledger.navigation.restoredFrom).toBeGreaterThan(0); } }
    expect(execute).not.toHaveBeenCalled();
  });
  it('reabre com checkpoints e futuro preservados', async () => {
    const { journal, live } = await setup(); await live.seek(700, fast); const state = structuredClone(live.state), count = live.count; await live.close();
    const resumed = await LiveRecording.resume(journal, live.entry.id, {}, fast); expect(resumed.state).toEqual(state); expect(resumed.count).toBe(count); expect(resumed.ledger.navigation.appliedSteps).toBeLessThan(128); await resumed.seek(count, fast); expect(resumed.ledger.durable).toBe(count);
  });
  it('despejo dos checkpoints permite replay integral sem apagar deltas', async () => {
    const { journal, live } = await setup(); await journal.checkpoints.delete(live.entry.id); await live.seek(700, fast);
    const oracle = new DebugSession(source, runtime); while (oracle.cursor < 700) oracle.forward(); expect(live.state).toEqual(oracle.state); expect(live.ledger.navigation.restoredFrom).toBe(0); expect((await journal.open(live.entry.id)).head.frontier).toBe(live.count);
  });
  it('corrupção do checkpoint usa deltas e cancelamento preserva a posição anterior', async () => {
    const { factory, journal, live } = await setup(), snapshot = await journal.open(live.entry.id), points = await journal.checkpoints.list(snapshot), point = points.reduce((a, b) => Math.abs(a.cursor - 700) < Math.abs(b.cursor - 700) ? a : b);
    const db = await new Promise<IDBDatabase>(resolve => { const r = factory.open('seek.seek-checkpoints'); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>(resolve => { const tx = db.transaction('states', 'readwrite'); tx.objectStore('states').put({ runId: live.entry.id, cursor: point.cursor, content: '{}' }); tx.oncomplete = () => resolve(); }); db.close();
    await live.seek(700, fast); const oracle = new DebugSession(source, runtime); while (oracle.cursor < 700) oracle.forward(); expect(live.state).toEqual(oracle.state);
    const before = structuredClone(live.state), abort = new AbortController(); await expect(live.seek(900, { ...fast, signal: abort.signal, beforePublish: async () => abort.abort() })).rejects.toThrow(); expect(live.cursor).toBe(700); expect(live.state).toEqual(before);
  });
  it('quota real dos checkpoints não desfaz a gravação durável', async () => {
    const factory = new IDBFactory(), journal = new RecordingJournal(factory, 'quota'); resources.push(journal); const live = await LiveRecording.start(journal, source, runtime, details, {}, fast), put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<typeof put>) { if (this.name === 'states') throw new DOMException('Quota', 'QuotaExceededError'); return put.apply(this, args); });
    for (let i = 0; i < 128; i++) await live.seek(live.count + 1, fast); expect(live.ledger.durable).toBe(128); expect(live.ledger.pendingSteps).toBe(0); expect(live.ledger.pauseReason).toBeNull(); expect(live.ledger.navigation.warning).toBeTruthy(); expect(await journal.checkpoints.list(await journal.open(live.entry.id))).toEqual([]);
  });
  it('reduz checkpoints por contagem e bytes, mantendo o estado mais recente', async () => {
    const { factory, journal, live } = await setup(), snapshot = await journal.open(live.entry.id), normal = await journal.checkpoints.list(snapshot), small = new JournalCheckpoints(factory, 'small', { maxPoints: 3, interval: 128, maxRunBytes: 10000 }); resources.push(small);
    for (const point of normal) { const state = await journal.checkpoints.read(snapshot, point); const { encode } = await import('../src/core/portable-history'); await small.put(snapshot, point.cursor, JSON.stringify(encode(state))); }
    const points = await small.list(snapshot); expect(points.length).toBeLessThanOrEqual(3); expect(points.reduce((n, p) => n + p.bytes, 0)).toBeLessThanOrEqual(10000); expect(await small.read(snapshot, points.at(-1)!)).not.toBeNull(); expect((await journal.open(live.entry.id)).head.frontier).toBe(live.count);
  });
});
