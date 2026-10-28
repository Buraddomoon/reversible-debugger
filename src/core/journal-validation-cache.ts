import { STRING_VM } from './vm-version';
import type { Program } from './compiler';
import { MAX_EXECUTION_STEPS } from './execution-limits';
import { digest, decode } from './portable-history';
import { utf8Bytes } from './history-blocks';
import type { JournalSnapshot } from './recording-journal';
import type { HistoryEvent } from './history-events';
import type { MachineState } from './machine';
import { measureMachine } from './storage-accounting';
import { fields, integer, requireTrace, text, validateMachineState } from './trace-validation';

// Change this identity whenever the trace validator's semantics change.
export const JOURNAL_VALIDATOR = 'rewind-journal-validator/1';
export const journalValidator = (program: Program) => program.vm === STRING_VM ? 'rewind-journal-validator/2' : JOURNAL_VALIDATOR;
export const VALIDATION_ENTRY_BYTES = 8 * 1024 * 1024;
export const VALIDATION_DISK_BYTES = 64 * 1024 * 1024;
export interface ValidatedPrefix {
  validator: string; runId: string; sourceHash: string; frontier: number; seal: string;
  state: string; maxMachineBytes: number; maxStepBytes: number; events: readonly HistoryEvent[];
}
interface Row { id: string; content: string; checksum: string; bytes: number; touched: number }
interface CacheEntry { id: string; bytes: number; touched: number; frontier: number; sourceHash: string }
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

/** Recomputable proof of a previously validated prefix. Never stores source deltas.
 * One atomic replacement per recording; eviction affects only derived data. */
export class JournalValidationCache {
  private database: Promise<IDBDatabase> | null = null;
  constructor(private readonly factory: IDBFactory, private readonly name: string,
    private readonly limits = { bytes: VALIDATION_DISK_BYTES, entries: 16 }) {
    integer(limits.bytes, 1, VALIDATION_DISK_BYTES); integer(limits.entries, 1, 16);
  }
  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      const r = this.factory.open(this.name, 1); let abandoned = false;
      const fail = () => { abandoned = true; this.database = null; reject(new Error('Cache de validação indisponível; a retomada verificará os blocos originais.')); };
      r.onerror = fail; r.onblocked = fail;
      r.onupgradeneeded = () => { if (abandoned) r.transaction?.abort(); else { r.result.createObjectStore('prefixes', { keyPath: 'id' }); r.result.createObjectStore('catalog', { keyPath: 'id' }); } };
      r.onsuccess = () => { if (abandoned) { r.result.close(); return; } const db = r.result; db.onversionchange = () => { db.close(); this.database = null; }; resolve(db); };
    }); return this.database;
  }
  private async transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await this.open(), tx = db.transaction(['prefixes', 'catalog'], mode);
    const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Cache de validação interrompido')); }); void done.catch(() => {});
    try { const result = await work(tx.objectStore('prefixes'), tx); await done; return result; }
    catch (cause) { try { tx.abort(); } catch { /* Already committed. */ } await done.catch(() => {}); throw cause; }
  }
  async read(recording: JournalSnapshot): Promise<{ prefix: ValidatedPrefix; state: MachineState } | null> {
    const raw = await this.transaction('readonly', store => request(store.get(recording.entry.id)));
    if (raw === undefined) return null;
    const row = fields(raw, ['id', 'content', 'checksum', 'bytes', 'touched']); text(row.content, VALIDATION_ENTRY_BYTES); text(row.checksum, 64); integer(row.bytes, 1, VALIDATION_ENTRY_BYTES); integer(row.touched, 0, Number.MAX_SAFE_INTEGER);
    requireTrace(row.id === recording.entry.id && utf8Bytes(row.content) === row.bytes && await digest(row.content) === row.checksum, 'cache de validação corrompido');
    const p = fields(JSON.parse(row.content), ['validator', 'runId', 'sourceHash', 'frontier', 'seal', 'state', 'maxMachineBytes', 'maxStepBytes', 'events']);
    // Incompatible identities are cache misses, never an excuse to trust a new format.
    if (p.validator !== journalValidator(recording.program) || p.runId !== recording.entry.id || p.sourceHash !== recording.entry.sourceHash) return null;
    integer(p.frontier, 0, recording.head.frontier);
    const boundary = recording.head.blocks.find(b => b.first + b.count === p.frontier);
    requireTrace(p.seal === (p.frontier === 0 ? recording.entry.sourceHash : boundary?.seal), 'prefixo validado não pertence à cadeia atual');
    integer(p.maxMachineBytes, 1, 256 * 1024 * 1024); integer(p.maxStepBytes, 0, 32 * 1024 * 1024); text(p.state, VALIDATION_ENTRY_BYTES);
    requireTrace(p.frontier !== recording.head.frontier || p.state === recording.head.state, 'checkpoint reutilizado difere da fronteira durável');
    const state = decode(JSON.parse(p.state)); validateMachineState(state, recording.program, recording.source.maxFrames);
    requireTrace(measureMachine(state).totalBytes <= p.maxMachineBytes, 'checkpoint excede reserva validada');
    requireTrace(Array.isArray(p.events) && p.events.length <= p.frontier && utf8Bytes(JSON.stringify(p.events)) <= 4 * 1024 * 1024, 'eventos do prefixo inválidos');
    let cursor = 0;
    for (const event of p.events) { const e = fields(event, ['cursor', 'kind', 'line', 'description']); integer(e.cursor, cursor + 1, p.frontier); cursor = e.cursor; integer(e.line, 1, 1_000_001); text(e.description, 240); requireTrace(['call', 'return', 'mutation', 'decision', 'output', 'error', 'end'].includes(String(e.kind)), 'evento de prefixo inválido'); }
    return { prefix: p as unknown as ValidatedPrefix, state };
  }
  async publish(prefix: ValidatedPrefix): Promise<void> {
    const content = JSON.stringify(prefix), bytes = utf8Bytes(content);
    if (bytes > VALIDATION_ENTRY_BYTES || bytes > this.limits.bytes) throw new Error('Prefixo excede a quota do cache de validação; os passos duráveis foram preservados.');
    const row: Row = { id: prefix.runId, content, bytes, checksum: await digest(content), touched: Date.now() };
    await this.transaction('readwrite', async (store, tx) => {
      // Only lightweight metadata is scanned; other sessions' checkpoints are never loaded.
      const catalog = tx.objectStore('catalog'), rows = (await request<unknown[]>(catalog.getAll())).map(raw => {
        const e = fields(raw, ['id', 'bytes', 'touched', 'frontier', 'sourceHash']); text(e.id, 100); text(e.sourceHash, 64); integer(e.bytes, 1, VALIDATION_ENTRY_BYTES); integer(e.touched, 0, Number.MAX_SAFE_INTEGER); integer(e.frontier, 0, MAX_EXECUTION_STEPS); return e as unknown as CacheEntry;
      });
      let count = rows.length + Number(!rows.some(r => r.id === row.id)), total = rows.reduce((n, r) => n + (r.id === row.id ? 0 : r.bytes), bytes);
      // Concurrent stale publications must not replace a more advanced prefix.
      const previous = rows.find(r => r.id === row.id);
      if (previous?.sourceHash === prefix.sourceHash && previous.frontier > prefix.frontier) return;
      for (const old of rows.filter(r => r.id !== row.id).sort((a, b) => a.touched - b.touched || a.id.localeCompare(b.id))) {
        if (count <= this.limits.entries && total <= this.limits.bytes) break;
        await request(store.delete(old.id)); await request(catalog.delete(old.id)); total -= old.bytes; count--;
      }
      await request(store.put(row));
      await request(catalog.put({ id: row.id, bytes, touched: row.touched, frontier: prefix.frontier, sourceHash: prefix.sourceHash } satisfies CacheEntry));
    });
  }
  async delete(id: string): Promise<void> { await this.transaction('readwrite', async (store, tx) => { await request(store.delete(id)); await request(tx.objectStore('catalog').delete(id)); }); }
  async close(): Promise<void> { const pending = this.database; this.database = null; if (pending) (await pending).close(); }
}
