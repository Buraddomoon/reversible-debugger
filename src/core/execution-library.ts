import { MAX_EXECUTION_STEPS } from './execution-limits';
import { DebugSession, recordingYield, type RecordingJob } from './debugger';
import { captureRecording, decodeBlock, encodeBlocks, utf8Bytes, validateManifest, type BlockDescriptor, type ExecutionHeader, type ExecutionManifest } from './history-blocks';
import { digest, MAX_TRACE_BYTES, type ImportedHistory, type TraceMetadata } from './portable-history';
import { fields, integer, requireTrace, text } from './trace-validation';
import type { DeepReadonly, Step } from './machine';

export const EXECUTION_DB = 'rewind.execution-library';
export const EXECUTION_DB_VERSION = 1;
export const MAX_SAVED_EXECUTIONS = 16;
export const MAX_DISK_BYTES = 128 * 1024 * 1024;
export const STAGING_LEASE_MS = 5 * 60 * 1000;
export interface SavedExecution {
  id: string; name: string; filename: string; language: string; version: string;
  createdAt: number; cursor: number; count: number; bytes: number; blocks: number;
}
interface CatalogRow extends SavedExecution { status: 'writing' | 'ready'; lease: number; written: number }
interface ManifestRow { id: string; content: string; checksum: string }
export interface LibraryStats { count: number; bytes: number; pending: number }
export interface StoredRecording { entry: SavedExecution; manifest: ExecutionManifest; checksum: string }
export interface LibraryReadJob extends RecordingJob {
  maxHistoryBytes?: number;
  onHeader?: (header: ExecutionHeader, bytes: number, checksum: string) => void;
  onChunk?: (records: readonly DeepReadonly<Step>[]) => Promise<void>;
}
function request<T>(req: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
function aborted(signal?: AbortSignal) { signal?.throwIfAborted(); }
function message(cause: unknown): Error {
  if (cause instanceof DOMException && cause.name === 'QuotaExceededError') return new Error('O navegador não tem espaço disponível. Exporte a execução ou exclua uma execução salva; nenhum histórico anterior foi removido.');
  return cause instanceof Error ? cause : new Error(String(cause));
}
function row(input: unknown): CatalogRow {
  const r = fields(input, ['id', 'name', 'filename', 'language', 'version', 'createdAt', 'cursor', 'count', 'bytes', 'blocks', 'status', 'lease', 'written']);
  text(r.id, 100); text(r.name, 160); text(r.filename, 240); text(r.language, 20); text(r.version, 20);
  integer(r.createdAt, 0, Number.MAX_SAFE_INTEGER); integer(r.count, 0, MAX_EXECUTION_STEPS); integer(r.cursor, 0, r.count); integer(r.bytes, 0, MAX_TRACE_BYTES); integer(r.blocks, 0, r.count); integer(r.written, 0, r.count); integer(r.lease, 0, Number.MAX_SAFE_INTEGER);
  requireTrace(r.status === 'writing' || r.status === 'ready', 'status do catálogo inválido');
  requireTrace(r.status !== 'ready' || r.written === r.count, 'execução publicada incompleta');
  return r as unknown as CatalogRow;
}
function summary(r: CatalogRow): SavedExecution { const { status: _status, lease: _lease, written: _written, ...entry } = r; return entry; }
/** Only ready metadata is listed. Hashing/encoding occurs outside short transactions. */
export class ExecutionLibrary {
  private database: Promise<IDBDatabase> | null = null;
  private readonly factory: IDBFactory;
  private readonly name: string;
  private readonly diskLimit: number;
  private readonly countLimit: number;
  constructor(options: { factory?: IDBFactory; name?: string; maxDiskBytes?: number; maxExecutions?: number } = {}) {
    const factory = options.factory ?? globalThis.indexedDB;
    if (!factory) throw new Error('IndexedDB indisponível neste navegador. Seus scripts e a exportação por arquivo continuam disponíveis.');
    this.factory = factory; this.name = options.name ?? EXECUTION_DB;
    this.diskLimit = options.maxDiskBytes ?? MAX_DISK_BYTES; this.countLimit = options.maxExecutions ?? MAX_SAVED_EXECUTIONS;
    integer(this.diskLimit, 1, MAX_DISK_BYTES); integer(this.countLimit, 1, MAX_SAVED_EXECUTIONS);
  }
  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      const req = this.factory.open(this.name, EXECUTION_DB_VERSION); let failed = false;
      const fail = (cause: unknown) => { failed = true; this.database = null; reject(message(cause)); };
      req.onupgradeneeded = event => {
        if (failed) { req.transaction?.abort(); return; }
        if (event.oldVersion !== 0) { req.transaction?.abort(); return; }
        const db = req.result; db.createObjectStore('catalog', { keyPath: 'id' }); db.createObjectStore('manifests', { keyPath: 'id' });
        db.createObjectStore('blocks', { keyPath: ['runId', 'index'] }).createIndex('runId', 'runId');
      };
      req.onerror = () => fail(new Error(`Não foi possível abrir a biblioteca: ${req.error?.name ?? 'erro'}. Os dados foram preservados.`));
      req.onblocked = () => fail(new Error('A biblioteca está aberta em outra versão. Feche as outras abas e tente novamente; os dados foram preservados.'));
      req.onsuccess = () => {
        const db = req.result;
        if (failed) { db.close(); return; }
        if (!['catalog', 'manifests', 'blocks'].every(store => db.objectStoreNames.contains(store))) { db.close(); fail(new Error('Estrutura de biblioteca incompatível. Os dados foram preservados.')); return; }
        db.onversionchange = () => { db.close(); this.database = null; }; resolve(db);
      };
    });
    return this.database;
  }
  async close(): Promise<void> { const pending = this.database; this.database = null; if (pending) (await pending).close(); }
  private async transaction<T>(stores: string[], mode: IDBTransactionMode, operation: (tx: IDBTransaction) => Promise<T>, signal?: AbortSignal): Promise<T> {
    aborted(signal); const db = await this.open(); aborted(signal);
    const tx = db.transaction(stores, mode);
    const cancel = () => { try { tx.abort(); } catch { /* Already committed. */ } };
    const completion = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? signal?.reason ?? new Error('Transação de biblioteca interrompida')); tx.onerror = () => { /* onabort owns failure. */ }; });
    // Attach immediately, even if operation itself rejects before awaiting completion.
    void completion.catch(() => {}); signal?.addEventListener('abort', cancel, { once: true });
    try { const result = await operation(tx); await completion; return result; }
    catch (cause) { cancel(); await completion.catch(() => {}); throw message(cause); }
    finally { signal?.removeEventListener('abort', cancel); }
  }
  private async catalog(tx: IDBTransaction): Promise<CatalogRow[]> { return (await request<unknown[]>(tx.objectStore('catalog').getAll())).map(row); }
  private enforce(rows: CatalogRow[], extra: number, isNew: boolean): void {
    if (rows.length + Number(isNew) > this.countLimit) throw new Error(`Biblioteca limitada a ${this.countLimit} execuções. Exclua uma execução salva antes de salvar outra.`);
    if (rows.reduce((sum, item) => sum + item.bytes, extra) > this.diskLimit) throw new Error('Biblioteca excede o orçamento de armazenamento local. Exporte ou exclua uma execução salva; nenhum passo foi descartado.');
  }
  private async remove(tx: IDBTransaction, id: string): Promise<void> {
    await request(tx.objectStore('catalog').delete(id)); await request(tx.objectStore('manifests').delete(id));
    const keys = await request(tx.objectStore('blocks').index('runId').getAllKeys(id));
    await Promise.all(keys.map(key => request(tx.objectStore('blocks').delete(key))));
  }
  /** Only expired incomplete writes are cleaned. Never delete another tab's live save. */
  async recover(now = Date.now()): Promise<number> {
    return this.transaction(['catalog', 'manifests', 'blocks'], 'readwrite', async tx => {
      const expired = (await this.catalog(tx)).filter(item => item.status === 'writing' && item.lease <= now);
      for (const item of expired) await this.remove(tx, item.id);
      return expired.length;
    });
  }
  async list(): Promise<SavedExecution[]> { return this.transaction(['catalog'], 'readonly', async tx => (await this.catalog(tx)).filter(item => item.status === 'ready').sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).map(summary)); }
  async stats(): Promise<LibraryStats> { return this.transaction(['catalog'], 'readonly', async tx => { const rows = await this.catalog(tx); return { count: rows.filter(r => r.status === 'ready').length, bytes: rows.reduce((sum, r) => sum + r.bytes, 0), pending: rows.filter(r => r.status === 'writing').length }; }); }
  async delete(id: string): Promise<void> { await this.transaction(['catalog', 'manifests', 'blocks'], 'readwrite', tx => this.remove(tx, id)); }
  async save(session: DebugSession, details: TraceMetadata, job: RecordingJob = {}): Promise<SavedExecution> {
    aborted(job.signal);
    const id = crypto.randomUUID(), createdAt = Date.now();
    const snapshot = await captureRecording(session, details, id, createdAt); aborted(job.signal);
    await this.recover();
    const headerBytes = utf8Bytes(JSON.stringify(snapshot.header)); requireTrace(headerBytes <= MAX_TRACE_BYTES, 'código/manifesto excede 32 MiB');
    let staged = false;
    try {
      await this.transaction(['catalog'], 'readwrite', async tx => {
        const rows = await this.catalog(tx); this.enforce(rows, headerBytes, true);
        await request(tx.objectStore('catalog').add({ id, createdAt, ...snapshot.header.metadata, ...snapshot.header.runtime, cursor: snapshot.header.cursor, count: snapshot.header.count, bytes: headerBytes, blocks: 0, written: 0, status: 'writing', lease: Date.now() + STAGING_LEASE_MS } satisfies CatalogRow));
      }, job.signal); staged = true;
      const descriptors: BlockDescriptor[] = [];
      for await (const block of encodeBlocks(snapshot, job)) {
        await this.transaction(['catalog', 'blocks'], 'readwrite', async tx => {
          const rows = await this.catalog(tx), r = rows.find(item => item.id === id);
          requireTrace(r?.status === 'writing' && r.blocks === block.index && r.written === block.first, 'gravação interrompida ou substituída');
          requireTrace(r.bytes + block.bytes <= MAX_TRACE_BYTES, 'execução excede 32 MiB; nenhum passo foi descartado'); this.enforce(rows, block.bytes, false);
          await request(tx.objectStore('blocks').add(block));
          await request(tx.objectStore('catalog').put({ ...r, bytes: r.bytes + block.bytes, blocks: r.blocks + 1, written: r.written + block.count, lease: Date.now() + STAGING_LEASE_MS }));
        }, job.signal);
        const { runId: _id, content: _content, ...descriptor } = block; descriptors.push(descriptor);
        job.onProgress?.(block.first + block.count, snapshot.header.count); await recordingYield(job);
      }
      const content = JSON.stringify({ header: snapshot.header, blocks: descriptors }), checksum = await digest(content), manifestBytes = utf8Bytes(content);
      const entry = await this.transaction(['catalog', 'manifests'], 'readwrite', async tx => {
        const rows = await this.catalog(tx), r = rows.find(item => item.id === id);
        requireTrace(r?.status === 'writing' && r.written === r.count, 'gravação incompleta');
        const extra = manifestBytes - headerBytes; requireTrace(r.bytes + extra <= MAX_TRACE_BYTES, 'execução excede 32 MiB'); this.enforce(rows, extra, false);
        const ready: CatalogRow = { ...r, bytes: r.bytes + extra, status: 'ready', lease: 0 };
        await request(tx.objectStore('manifests').add({ id, content, checksum } satisfies ManifestRow)); await request(tx.objectStore('catalog').put(ready)); return summary(ready);
      }, job.signal);
      staged = false; return entry;
    } catch (cause) {
      // This writer owns only its uncommitted reservation. A committed save is immutable.
      if (staged) await this.delete(id).catch(() => {});
      throw message(cause);
    }
  }
  async openRecording(id: string, signal?: AbortSignal): Promise<StoredRecording> {
    const saved = await this.transaction(['catalog', 'manifests'], 'readonly', async tx => {
      const raw = await request(tx.objectStore('catalog').get(id)); requireTrace(raw !== undefined, 'execução excluída ou indisponível');
      const entry = row(raw); requireTrace(entry.status === 'ready', 'execução ainda não concluída');
      const m = fields(await request(tx.objectStore('manifests').get(id)), ['id', 'content', 'checksum']); requireTrace(m.id === id, 'manifesto pertence a outra execução'); text(m.content, MAX_TRACE_BYTES); text(m.checksum, 64);
      return { entry, content: m.content, checksum: m.checksum };
    }, signal);
    const manifest = await validateManifest(saved.content, saved.checksum, id); aborted(signal);
    const h = manifest.header, r = saved.entry;
    requireTrace(r.cursor === h.cursor && r.count === h.count && r.blocks === manifest.blocks.length && r.createdAt === h.createdAt && r.name === h.metadata.name && r.filename === h.metadata.filename && r.language === h.runtime.language && r.version === h.runtime.version && r.bytes === utf8Bytes(saved.content) + manifest.blocks.reduce((sum, b) => sum + b.bytes, 0), 'catálogo e manifesto não conferem');
    return { entry: summary(r), manifest, checksum: saved.checksum };
  }
  async readBlock(recording: StoredRecording, descriptor: BlockDescriptor, signal?: AbortSignal): Promise<unknown[]> {
    const raw = await this.transaction(['blocks'], 'readonly', tx => request(tx.objectStore('blocks').get([recording.entry.id, descriptor.index])), signal);
    const records = await decodeBlock(raw, descriptor, recording.entry.id); aborted(signal); return records;
  }
  async load(id: string, job: LibraryReadJob = {}): Promise<ImportedHistory> {
    const saved = await this.openRecording(id, job.signal), { manifest } = saved, h = manifest.header, r = saved.entry;
    const builder = DebugSession.recordingBuilder(h.source, { ...h.runtime, ...h.limits, vm: h.vm, maxHistoryBytes: job.maxHistoryBytes }, h.count, h.cursor);
    job.onHeader?.(h, r.bytes, saved.checksum);
    for (const descriptor of manifest.blocks) {
      const records = await this.readBlock(saved, descriptor, job.signal);
      for (let offset = 0; offset < records.length; offset += 16) {
        const chunk = records.slice(offset, offset + 16); builder.append(chunk);
        // Each chunk has already passed VM-chain validation. UI uses its own private builder.
        await job.onChunk?.(chunk as DeepReadonly<Step>[]);
        job.onProgress?.(builder.count, h.count); await recordingYield(job);
      }
    }
    const session = await builder.finish(job); aborted(job.signal);
    return { ...h.metadata, session, bytes: r.bytes, checksum: saved.checksum };
  }
}
