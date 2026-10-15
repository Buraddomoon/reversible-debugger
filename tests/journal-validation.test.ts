import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { RecordingJournal } from '../src/core/recording-journal';
import { LiveRecording } from '../src/core/live-recording';
import { JournalValidationCache } from '../src/core/journal-validation-cache';
import { DebugSession } from '../src/core/debugger';
import { digest } from '../src/core/portable-history';
import * as machine from '../src/core/machine';
const runtime = { language: 'python', version: '3' } as const, details = { name: 'Segmentos', filename: 'segmentos.py' }, fast = { yieldControl: async () => {} };
const resources: Array<{ close(): Promise<void> }> = [];
function setup() { const factory = new IDBFactory(), journal = new RecordingJournal(factory, 'segments'); resources.push(journal); return { factory, journal }; }
async function record(journal: RecordingJournal, source = 'i = 0\nwhile i < 50:\n    print(i)\n    i += 1', steps = 280) {
  const live = await LiveRecording.start(journal, source, runtime, details, { bufferBytes: 4096 }, fast);
  while (live.count < steps && live.ledger.canRecord) await live.seek(live.count + 1, fast);
  await live.close(); return live;
}
async function mutate(factory: IDBFactory, name: string, store: string, key: IDBValidKey, change: (raw: any) => any) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = factory.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  try { await new Promise<void>((resolve, reject) => { const tx = db.transaction(store, 'readwrite'), table = tx.objectStore(store), r = table.get(key); r.onsuccess = () => { table.put(change(r.result)); }; tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); } finally { db.close(); }
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(resources.splice(0).map(r => r.close())); });
describe('prefixos validados e segmentos novos', () => {
  it('retomada reutiliza o prefixo sem executar ou reler todos os blocos', async () => {
    const { journal } = setup(), live = await record(journal), read = vi.spyOn(journal, 'readBlock'), execute = vi.spyOn(machine, 'executeInstruction');
    const resumed = await LiveRecording.resume(journal, live.entry.id, {}, fast);
    expect(resumed.state).toEqual(live.state); expect(resumed.events).toEqual(live.events); expect(resumed.ledger.validation).toMatchObject({ reusedSteps: 280, checkedSteps: 0, blockReads: 0 }); expect(read).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled();
    await resumed.seek(40, fast); const oracle = new DebugSession(live.source.source, runtime); for (let n = 0; n < 40; n++) oracle.forward(); expect(resumed.state).toEqual(oracle.state);
  });
  it('cache antigo valida somente o sufixo novo e preserva o prefixo/futuro', async () => {
    const { journal } = setup(), live = await record(journal, undefined, 140), prefix = await journal.validation.read(await journal.open(live.entry.id));
    const next = await LiveRecording.resume(journal, live.entry.id, {}, fast); for (let n = 0; n < 35; n++) await next.seek(next.count + 1, fast); await next.close();
    await journal.validation.delete(live.entry.id); await journal.validation.publish(prefix!.prefix);
    const resumed = await LiveRecording.resume(journal, live.entry.id, {}, fast); expect(resumed.state).toEqual(next.state); expect(resumed.events).toEqual(next.events); expect(resumed.ledger.validation.reusedSteps).toBe(140); expect(resumed.ledger.validation.checkedSteps).toBe(35); expect(resumed.ledger.validation.blockReads).toBeGreaterThan(0);
  });
  for (const kind of ['ausente', 'checksum', 'versão', 'identidade', 'fronteira', 'estado'] as const) it(`cache ${kind} usa validação integral sem perder o original`, async () => {
    const { factory, journal } = setup(), live = await record(journal, undefined, 35);
    if (kind === 'ausente') await journal.validation.delete(live.entry.id);
    else {
      const snapshot = await journal.open(live.entry.id), cached = (await journal.validation.read(snapshot))!.prefix;
      if (kind === 'checksum') await mutate(factory, 'segments.validation-cache', 'prefixes', live.entry.id, r => ({ ...r, content: '{}' }));
      else {
        const p = { ...cached };
        if (kind === 'versão') p.validator = 'future/9'; if (kind === 'identidade') p.sourceHash = '0'.repeat(64); if (kind === 'fronteira') p.frontier--; if (kind === 'estado') p.state = '{}';
        const content = JSON.stringify(p), checksum = await digest(content);
        await mutate(factory, 'segments.validation-cache', 'prefixes', live.entry.id, r => ({ ...r, content, checksum, bytes: new TextEncoder().encode(content).length }));
      }
    }
    const resumed = await LiveRecording.resume(journal, live.entry.id, {}, fast); expect(resumed.state).toEqual(live.state); expect(resumed.ledger.validation.reusedSteps).toBe(0); expect(resumed.ledger.validation.checkedSteps).toBe(35); expect((await journal.open(live.entry.id)).head.frontier).toBe(35);
  });
  it('conferência explícita ignora cache válido e valida todos os deltas', async () => {
    const { journal } = setup(), live = await record(journal, undefined, 140), resumed = await LiveRecording.resume(journal, live.entry.id, { validateAll: true }, fast);
    expect(resumed.state).toEqual(live.state); expect(resumed.ledger.validation).toMatchObject({ reusedSteps: 0, checkedSteps: 140 });
  });
  it('corrupção num bloco antigo é recusada na leitura e na conferência integral', async () => {
    const { factory, journal } = setup(), live = await record(journal), resumed = await LiveRecording.resume(journal, live.entry.id, {}, fast), before = structuredClone(resumed.state);
    await mutate(factory, 'segments', 'blocks', [live.entry.id, 0], r => ({ ...r, content: '[]' }));
    await expect(resumed.seek(1, fast)).rejects.toThrow('corrompido'); expect(resumed.state).toEqual(before); expect(resumed.cursor).toBe(280); await resumed.close();
    await expect(LiveRecording.resume(journal, live.entry.id, { validateAll: true }, fast)).rejects.toThrow('corrompido'); expect((await journal.list())[0]!.owner).toBeNull();
  });
  it('falha na quota do cache não desfaz o commit durável e a retomada continua', async () => {
    const { journal } = setup(), live = await record(journal, undefined, 20), resumed = await LiveRecording.resume(journal, live.entry.id, {}, fast);
    const put = IDBObjectStore.prototype.put; vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<typeof put>) { if (this.name === 'prefixes') throw new DOMException('Quota', 'QuotaExceededError'); return put.apply(this, args); });
    await resumed.seek(21, fast); expect(await resumed.flush()).toBe(true); expect(resumed.ledger.durable).toBe(21); expect(resumed.ledger.pauseReason).toBeNull(); expect(resumed.ledger.validation.cacheWarning).toBeTruthy(); expect((await journal.open(live.entry.id)).head.frontier).toBe(21); vi.restoreAllMocks(); await resumed.close();
  });
  it('cancelar conferência parcial não publica cache nem assume escritor', async () => {
    const { journal } = setup(), live = await record(journal), abort = new AbortController(); await journal.validation.delete(live.entry.id);
    await expect(LiveRecording.resume(journal, live.entry.id, { validateAll: true }, { ...fast, signal: abort.signal, onProgress: () => abort.abort() })).rejects.toThrow(); expect((await journal.list())[0]!.owner).toBeNull(); expect(await journal.validation.read(await journal.open(live.entry.id))).toBeNull();
  });
  it('limites pequenos recusam checkpoint reutilizado antes de assumir escritor', async () => {
    const { journal } = setup(), live = await record(journal); await expect(LiveRecording.resume(journal, live.entry.id, { maxHistoryBytes: 1 }, fast)).rejects.toThrow('Orçamento'); expect((await journal.list())[0]!.owner).toBeNull();
  });
  it('despejo e publicação antiga afetam somente dados derivados', async () => {
    const { factory, journal } = setup(), a = await record(journal, undefined, 20), first = (await journal.validation.read(await journal.open(a.entry.id)))!.prefix;
    const next = await LiveRecording.resume(journal, a.entry.id, {}, fast); await next.seek(21, fast); await next.close(); await journal.validation.publish(first); expect((await journal.validation.read(await journal.open(a.entry.id)))!.prefix.frontier).toBe(21);
    const limited = new JournalValidationCache(factory, 'tiny-cache', { bytes: 8000, entries: 1 }); resources.push(limited); await limited.publish(first);
    const b = await record(journal, undefined, 20), second = (await journal.validation.read(await journal.open(b.entry.id)))!.prefix; await limited.publish(second); expect(await limited.read(await journal.open(a.entry.id))).toBeNull(); expect((await journal.open(a.entry.id)).head.frontier).toBe(21); expect(await limited.read(await journal.open(b.entry.id))).not.toBeNull();
  });
  it('checkpoint parcial bem formado mas divergente é reconstruído pela origem', async () => {
    const { journal } = setup(), live = await record(journal, undefined, 140), prefix = (await journal.validation.read(await journal.open(live.entry.id)))!.prefix;
    const next = await LiveRecording.resume(journal, live.entry.id, {}, fast); for (let n = 0; n < 20; n++) await next.seek(next.count + 1, fast); await next.close();
    const state = JSON.parse(prefix.state); state.frames[0].locals.i = { $bigint: '9' }; const bad = { ...prefix, state: JSON.stringify(state) }; await journal.validation.delete(live.entry.id); await journal.validation.publish(bad);
    const resumed = await LiveRecording.resume(journal, live.entry.id, {}, fast); expect(resumed.state).toEqual(next.state); expect(resumed.ledger.validation.reusedSteps).toBe(0); expect(resumed.ledger.validation.checkedSteps).toBe(160);
  });
  it('banco auxiliar de versão futura não é apagado e não bloqueia a gravação', async () => {
    const { factory, journal } = setup(), live = await record(journal, undefined, 20); await journal.validation.close();
    const db = await new Promise<IDBDatabase>(resolve => { const r = factory.open('segments.validation-cache', 2); r.onupgradeneeded = () => r.result.createObjectStore('future'); r.onsuccess = () => resolve(r.result); }); db.close();
    const resumed = await LiveRecording.resume(journal, live.entry.id, {}, fast); expect(resumed.state).toEqual(live.state); expect(resumed.ledger.validation.checkedSteps).toBe(20); expect(resumed.ledger.validation.cacheWarning).toBeTruthy();
    const preserved = await new Promise<IDBDatabase>(resolve => { const r = factory.open('segments.validation-cache', 2); r.onsuccess = () => resolve(r.result); }); expect(preserved.objectStoreNames.contains('future')).toBe(true); preserved.close();
  });
});
