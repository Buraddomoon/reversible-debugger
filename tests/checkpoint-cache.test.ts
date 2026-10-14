import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { CheckpointCache } from '../src/core/checkpoint-cache';
import { ExecutionLibrary } from '../src/core/execution-library';
import { PagedHistoryStore } from '../src/core/paged-history';
import { DebugSession } from '../src/core/debugger';
import { digest } from '../src/core/portable-history';

const resources: Array<{ close(): Promise<void> }> = [], fast = { yieldControl: async () => {} };
function setup(options: { maxDiskBytes?: number; maxEntries?: number } = {}) { const factory = new IDBFactory(), cache = new CheckpointCache(factory, 'derived', options); resources.push(cache); return { factory, cache }; }
async function mutate(factory: IDBFactory, store: string, key: IDBValidKey, change: (raw: any) => any) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = factory.open('derived'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  try { await new Promise<void>((resolve, reject) => { const tx = db.transaction(store, 'readwrite'), table = tx.objectStore(store), r = table.get(key); r.onsuccess = () => { table.put(change(r.result)); }; tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); } finally { db.close(); }
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(resources.splice(0).map(r => r.close())); });

describe('cache auxiliar de checkpoints', () => {
  it('só publica índices completos, conserva checkpoints e verifica conteúdo/hash ao ler', async () => {
    const { factory, cache } = setup(), token = await cache.begin('run:hash');
    const point = await cache.checkpoint(token, 128, '{"state":"ready"}'); expect(point).not.toBeNull(); expect(await cache.find('run:hash')).toBeNull();
    const index = await cache.publish(token, '{"index":1}'); expect(await cache.find('run:hash')).toEqual(index); expect(await cache.readCheckpoint(token, point!)).toBe('{"state":"ready"}');
    await mutate(factory, 'checkpoints', [token, 128], raw => ({ ...raw, content: raw.content.replace('ready', 'other') }));
    await expect(cache.readCheckpoint(token, point!)).rejects.toThrow(/corrompido/);
  });
  it('evita crescimento ilimitado por bytes e por entradas, despejando somente dados derivados', async () => {
    const { cache } = setup({ maxDiskBytes: 1200, maxEntries: 2 });
    const a = await cache.begin('a'); const point = await cache.checkpoint(a, 1, 'a'.repeat(800)); await cache.publish(a, '{}');
    const b = await cache.begin('b'); await cache.checkpoint(b, 2, 'b'.repeat(800)); await cache.publish(b, '{}');
    expect(await cache.find('a')).toBeNull(); expect(await cache.readCheckpoint(a, point!)).toBeNull(); expect(await cache.find('b')).not.toBeNull();
    for (const key of ['c', 'd']) { const token = await cache.begin(key); await cache.publish(token, '{}'); }
    expect(await cache.find('b')).toBeNull(); expect(await cache.find('c')).not.toBeNull(); expect(await cache.find('d')).not.toBeNull();
  });
  it('reserva de outra aba em andamento não pode ser despejada para abrir uma nova', async () => {
    const { factory, cache } = setup({ maxEntries: 1 }), second = new CheckpointCache(factory, 'derived', { maxEntries: 1 }); resources.push(second);
    const results = await Promise.allSettled([cache.begin('a'), second.begin('b')]); expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const winner = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<string>).value; await cache.discard(winner); expect(await second.begin('next')).toBeTypeOf('string');
  });
  it('recupera apenas reservas expiradas e não remove índices prontos', async () => {
    const { factory, cache } = setup({ maxEntries: 2 }); const ready = await cache.begin('ready'); await cache.publish(ready, '{}'); const abandoned = await cache.begin('abandoned'); await cache.checkpoint(abandoned, 1, '{}');
    await mutate(factory, 'catalog', abandoned, raw => ({ ...raw, touched: Date.now() - 300_001 }));
    const fresh = await cache.begin('fresh'); expect(await cache.find('ready')).not.toBeNull(); expect(await cache.readCheckpoint(abandoned, { cursor: 1, bytes: 2, checksum: await digest('{}') })).toBeNull(); await cache.discard(fresh);
  });
  it('falha da quota real aborta checkpoint e mantém índice pronto', async () => {
    const { cache } = setup(); const ready = await cache.begin('ready'); await cache.publish(ready, '{}'); const pending = await cache.begin('pending');
    const add = IDBObjectStore.prototype.add; vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value: any, key?: IDBValidKey) { if (this.name === 'checkpoints') throw new DOMException('Cheio', 'QuotaExceededError'); return add.call(this, value, key); });
    await expect(cache.checkpoint(pending, 1, '{}')).rejects.toThrow(/debugger completo/); expect(await cache.find('ready')).not.toBeNull(); await cache.discard(pending);
  });
  it('índice adulterado é recusado e a gravação original ainda abre por inteiro', async () => {
    const { factory, cache } = setup(), library = new ExecutionLibrary({ factory, name: 'original' }); resources.push(library);
    const session = new DebugSession('result = 42', { language: 'python' }); while (session.canForward) session.runBatch();
    const saved = await library.save(session, { name: 'Teste', filename: 'teste.py' }, fast), opened = await PagedHistoryStore.open(library, cache, saved.id, {}, fast); opened.dispose();
    const cached = await cache.find(`${saved.id}:${(await library.openRecording(saved.id)).checksum}`); await mutate(factory, 'indexes', cached!.token, raw => ({ ...raw, content: '{}' }));
    await expect(PagedHistoryStore.open(library, cache, saved.id, {}, fast)).rejects.toThrow(/corrompido/); expect((await library.load(saved.id, fast)).session.state).toEqual(session.state);
  });
  it('cache de versão futura é recusado sem afetar arquivos/banco originais', async () => {
    const { factory, cache } = setup(); await cache.begin('ready'); await cache.close();
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = factory.open('derived', 2); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); db.close();
    await expect(cache.find('ready')).rejects.toThrow(/VersionError/);
  });
});
