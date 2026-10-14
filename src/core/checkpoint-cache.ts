import { digest } from './portable-history';
import { utf8Bytes } from './history-blocks';
import { fields, integer, requireTrace, text } from './trace-validation';

export const CHECKPOINT_DB = 'rewind.checkpoint-cache';
export const DERIVED_DISK_BYTES = 64 * 1024 * 1024;
export const CHECKPOINT_BYTES_PER_RUN = 8 * 1024 * 1024;
export const INDEX_BYTES_PER_RUN = 8 * 1024 * 1024;
export interface CheckpointDescriptor { cursor: number; bytes: number; checksum: string }
interface CacheCatalog { token: string; key: string; status: 'writing' | 'ready'; bytes: number; checkpointBytes: number; touched: number }
export interface CachedIndex { token: string; content: string; checksum: string }
const req = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

/** Derived data has its own bounded disk cache. Eviction never touches recordings. */
export class CheckpointCache {
  private database: Promise<IDBDatabase> | null = null;
  private readonly diskLimit: number;
  private readonly entriesLimit: number;
  constructor(private readonly factory: IDBFactory = globalThis.indexedDB, private readonly name = CHECKPOINT_DB, options: { maxDiskBytes?: number; maxEntries?: number } = {}) {
    this.diskLimit = options.maxDiskBytes ?? DERIVED_DISK_BYTES; this.entriesLimit = options.maxEntries ?? 16;
    integer(this.diskLimit, 1, DERIVED_DISK_BYTES); integer(this.entriesLimit, 1, 16);
  }
  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      const r = this.factory.open(this.name, 1); let abandoned = false;
      const fail = (cause: unknown) => { abandoned = true; this.database = null; reject(cause); };
      r.onerror = () => fail(new Error(`Cache de checkpoints indisponível (${r.error?.name}). As execuções salvas foram preservadas.`));
      r.onblocked = () => fail(new Error('Cache aberto em outra versão; feche as outras abas e tente novamente.'));
      r.onupgradeneeded = () => {
        if (abandoned) { r.transaction?.abort(); return; }
        const db = r.result; db.createObjectStore('catalog', { keyPath: 'token' }); db.createObjectStore('indexes', { keyPath: 'token' });
        db.createObjectStore('checkpoints', { keyPath: ['token', 'cursor'] }).createIndex('token', 'token');
      };
      r.onsuccess = () => { const db = r.result; if (abandoned) { db.close(); return; } db.onversionchange = () => { db.close(); this.database = null; }; resolve(db); };
    }); return this.database;
  }
  private async tx<T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await this.open(), tx = db.transaction(stores, mode);
    const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Cache interrompido')); }); void done.catch(() => {});
    try { const value = await work(tx); await done; return value; }
    catch (error) { try { tx.abort(); } catch { /* Already closed. */ } await done.catch(() => {}); if (error instanceof DOMException && error.name === 'QuotaExceededError') throw new Error('Sem espaço para checkpoints auxiliares. Abra o debugger completo; a gravação original foi preservada.'); throw error; }
  }
  private async rows(tx: IDBTransaction): Promise<CacheCatalog[]> {
    const rows = await req<unknown[]>(tx.objectStore('catalog').getAll());
    return rows.map(raw => {
      const r = fields(raw, ['token', 'key', 'status', 'bytes', 'checkpointBytes', 'touched']); text(r.token, 100); text(r.key, 200); integer(r.bytes, 0, INDEX_BYTES_PER_RUN + CHECKPOINT_BYTES_PER_RUN); integer(r.checkpointBytes, 0, CHECKPOINT_BYTES_PER_RUN); integer(r.touched, 0, Number.MAX_SAFE_INTEGER); requireTrace(r.status === 'writing' || r.status === 'ready', 'status do cache inválido'); requireTrace(r.checkpointBytes <= r.bytes && (r.status === 'writing' ? r.bytes === r.checkpointBytes : r.bytes - r.checkpointBytes <= INDEX_BYTES_PER_RUN), 'reserva do cache inconsistente'); return r as unknown as CacheCatalog;
    });
  }
  private async remove(tx: IDBTransaction, token: string): Promise<void> {
    await req(tx.objectStore('catalog').delete(token)); await req(tx.objectStore('indexes').delete(token));
    const keys = await req(tx.objectStore('checkpoints').index('token').getAllKeys(token)); await Promise.all(keys.map(k => req(tx.objectStore('checkpoints').delete(k))));
  }
  private async fit(tx: IDBTransaction, rows: CacheCatalog[], extra: number, newEntry = false): Promise<void> {
    let total = rows.reduce((n, r) => n + r.bytes, extra), count = rows.length + Number(newEntry);
    for (const r of rows.filter(r => r.status === 'ready').sort((a, b) => a.touched - b.touched)) {
      if (total <= this.diskLimit && count <= this.entriesLimit) break;
      await this.remove(tx, r.token); total -= r.bytes; count--;
    }
    if (total > this.diskLimit || count > this.entriesLimit) throw new Error('Cache ocupado por outras indexações. Tente novamente após concluírem.');
  }
  async find(key: string): Promise<CachedIndex | null> {
    return this.tx(['catalog', 'indexes'], 'readwrite', async tx => {
      const rows = await this.rows(tx), match = rows.filter(r => r.key === key && r.status === 'ready').sort((a, b) => b.touched - a.touched)[0];
      if (!match) return null;
      const raw = fields(await req(tx.objectStore('indexes').get(match.token)), ['token', 'content', 'checksum']); text(raw.content, INDEX_BYTES_PER_RUN); text(raw.checksum, 64); requireTrace(raw.token === match.token, 'índice de outro cache');
      await req(tx.objectStore('catalog').put({ ...match, touched: Date.now() })); return raw as unknown as CachedIndex;
    });
  }
  async begin(key: string): Promise<string> {
    return this.tx(['catalog', 'indexes', 'checkpoints'], 'readwrite', async tx => {
      let rows = await this.rows(tx);
      for (const r of rows) if (r.status === 'writing' && r.touched + 300_000 <= Date.now()) await this.remove(tx, r.token);
      rows = await this.rows(tx); await this.fit(tx, rows, 0, true);
      const token = crypto.randomUUID(); await req(tx.objectStore('catalog').add({ token, key, status: 'writing', bytes: 0, checkpointBytes: 0, touched: Date.now() } satisfies CacheCatalog)); return token;
    });
  }
  async checkpoint(token: string, cursor: number, content: string): Promise<CheckpointDescriptor | null> {
    const bytes = utf8Bytes(content); if (bytes > CHECKPOINT_BYTES_PER_RUN) return null;
    const checksum = await digest(content);
    return this.tx(['catalog', 'indexes', 'checkpoints'], 'readwrite', async tx => {
      const rows = await this.rows(tx), r = rows.find(r => r.token === token); requireTrace(r?.status === 'writing', 'cache de indexação interrompido');
      if (r.checkpointBytes + bytes > CHECKPOINT_BYTES_PER_RUN) return null;
      await this.fit(tx, rows, bytes);
      await req(tx.objectStore('checkpoints').add({ token, cursor, content, checksum })); await req(tx.objectStore('catalog').put({ ...r, bytes: r.bytes + bytes, checkpointBytes: r.checkpointBytes + bytes, touched: Date.now() }));
      return { cursor, bytes, checksum };
    });
  }
  async publish(token: string, content: string): Promise<CachedIndex> {
    const bytes = utf8Bytes(content); requireTrace(bytes <= INDEX_BYTES_PER_RUN, 'índice auxiliar excede 8 MiB'); const checksum = await digest(content);
    await this.tx(['catalog', 'indexes', 'checkpoints'], 'readwrite', async tx => {
      const rows = await this.rows(tx), r = rows.find(r => r.token === token); requireTrace(r?.status === 'writing', 'cache interrompido'); await this.fit(tx, rows, bytes);
      await req(tx.objectStore('indexes').add({ token, content, checksum })); await req(tx.objectStore('catalog').put({ ...r, bytes: r.bytes + bytes, status: 'ready', touched: Date.now() }));
    }); return { token, content, checksum };
  }
  async readCheckpoint(token: string, expected: CheckpointDescriptor): Promise<string | null> {
    const raw = await this.tx(['checkpoints'], 'readonly', tx => req(tx.objectStore('checkpoints').get([token, expected.cursor])));
    if (raw === undefined) return null; // Derived cache was evicted; origin remains usable.
    const row = fields(raw, ['token', 'cursor', 'content', 'checksum']); text(row.content, CHECKPOINT_BYTES_PER_RUN);
    requireTrace(row.token === token && row.cursor === expected.cursor && row.checksum === expected.checksum && utf8Bytes(row.content) === expected.bytes && await digest(row.content) === expected.checksum, 'checkpoint corrompido'); return row.content;
  }
  async discard(token: string): Promise<void> { await this.tx(['catalog', 'indexes', 'checkpoints'], 'readwrite', tx => this.remove(tx, token)); }
  async close(): Promise<void> { const pending = this.database; this.database = null; if (pending) (await pending).close(); }
}
