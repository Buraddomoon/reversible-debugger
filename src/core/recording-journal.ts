import { LEGACY_MAX_STEPS, MAX_EXECUTION_STEPS, extendedLimits, validateExecutionLimits } from './execution-limits';
import { compile, type Program } from './compiler';
import { initialState, type MachineState } from './machine';
import { decode, digest, encode, metadata, MAX_TRACE_BYTES, TRACE_VM, type TraceMetadata } from './portable-history';
import { getRuntime, type RuntimeSelection } from './runtime';
import { utf8Bytes } from './history-blocks';
import { MAX_SOURCE_CHARS } from './language';
import { fields, integer, requireTrace, text, same, validateMachineState } from './trace-validation';
import type { SavedExecution } from './execution-library';
import { JournalCheckpoints } from './journal-checkpoints';
import { JournalValidationCache } from './journal-validation-cache';

export const JOURNAL_DB = 'rewind.recording-journal';
export const JOURNAL_DISK_BYTES = 64 * 1024 * 1024;
export const JOURNAL_ENTRIES = 8;
export const WRITER_LEASE_MS = 5000;
export const LIVE_BLOCK_STEPS = 128;
export const LIVE_BLOCK_BYTES = 256 * 1024;
export interface JournalSource extends TraceMetadata { id: string; format: 'rewind-live'; version: 1 | 2; vm: string; createdAt: number; source: string; runtime: RuntimeSelection; programHash: string; maxSteps: number; maxFrames: number; initial: unknown }
export interface JournalBlock { index: number; first: number; count: number; bytes: number; checksum: string; previousSeal: string; seal: string }
export interface JournalHead { version: 1; sourceHash: string; revision: number; frontier: number; cursor: number; lastSeal: string; blocks: JournalBlock[]; state: string; stateHash: string }
export interface JournalEntry extends SavedExecution { revision: number; sourceHash: string; headHash: string; owner: string | null; lease: number }
export interface JournalSnapshot { entry: JournalEntry; source: JournalSource; head: JournalHead; program: Program }
export interface JournalCommit { head: JournalHead; content: string; checksum: string; block?: JournalBlock & { runId: string; content: string } }
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
function hash(value: unknown): asserts value is string { text(value, 64); requireTrace(/^[a-f0-9]{64}$/.test(value), 'checksum de sessão inválido'); }
function entry(raw: unknown): JournalEntry {
  const e = fields(raw, ['id', 'name', 'filename', 'language', 'version', 'createdAt', 'cursor', 'count', 'bytes', 'blocks', 'revision', 'sourceHash', 'headHash', 'owner', 'lease']);
  text(e.id, 100); text(e.name, 160); text(e.filename, 240); text(e.language, 20); text(e.version, 20); integer(e.createdAt, 0, Number.MAX_SAFE_INTEGER); integer(e.count, 0, MAX_EXECUTION_STEPS); integer(e.cursor, 0, e.count); integer(e.bytes, 0, MAX_TRACE_BYTES); integer(e.blocks, 0, e.count); integer(e.revision, 0, Number.MAX_SAFE_INTEGER); hash(e.sourceHash); hash(e.headHash); integer(e.lease, 0, Number.MAX_SAFE_INTEGER); if (e.owner !== null) text(e.owner, 100); return e as unknown as JournalEntry;
}
export class WriterConflictError extends Error { constructor() { super('Esta sessão está sendo gravada em outra aba ou foi atualizada. As pendências desta aba foram preservadas.'); this.name = 'WriterConflictError'; } }
/** Durable head and its last checkpoint are replaced atomically with each block.
 * Published prefixes never expire or get automatically deleted. */
export class RecordingJournal {
  readonly validation: JournalValidationCache;
  readonly checkpoints: JournalCheckpoints;
  private database: Promise<IDBDatabase> | null = null;
  private readonly limit: number;
  private readonly maxEntries: number;
  constructor(private readonly factory: IDBFactory = globalThis.indexedDB, private readonly name = JOURNAL_DB, options: { maxDiskBytes?: number; maxEntries?: number } = {}) { this.validation = new JournalValidationCache(factory, `${name}.validation-cache`); this.checkpoints = new JournalCheckpoints(factory, `${name}.seek-checkpoints`); this.limit = options.maxDiskBytes ?? JOURNAL_DISK_BYTES; this.maxEntries = options.maxEntries ?? JOURNAL_ENTRIES; integer(this.limit, 1, JOURNAL_DISK_BYTES); integer(this.maxEntries, 1, JOURNAL_ENTRIES); }
  private openDB(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      const r = this.factory.open(this.name, 1); let abandoned = false;
      const fail = (cause: unknown) => { abandoned = true; this.database = null; reject(cause); };
      r.onerror = () => fail(new Error(`Biblioteca de sessões indisponível (${r.error?.name}). Os dados foram preservados.`)); r.onblocked = () => fail(new Error('Feche as abas de outra versão para abrir as sessões.'));
      r.onupgradeneeded = () => { if (abandoned) { r.transaction?.abort(); return; } const db = r.result; db.createObjectStore('catalog', { keyPath: 'id' }); db.createObjectStore('sources', { keyPath: 'id' }); db.createObjectStore('heads', { keyPath: 'id' }); db.createObjectStore('blocks', { keyPath: ['runId', 'index'] }).createIndex('runId', 'runId'); };
      r.onsuccess = () => { const db = r.result; if (abandoned) { db.close(); return; } db.onversionchange = () => { db.close(); this.database = null; }; resolve(db); };
    }); return this.database;
  }
  private async tx<T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted(); const db = await this.openDB(); signal?.throwIfAborted(); const tx = db.transaction(stores, mode);
    const cancel = () => { try { tx.abort(); } catch { /* Already committed. */ } }, done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? signal?.reason ?? new Error('Escrita interrompida')); }); void done.catch(() => {}); signal?.addEventListener('abort', cancel, { once: true });
    try { const result = await work(tx); await done; return result; } catch (cause) { cancel(); await done.catch(() => {}); if (cause instanceof DOMException && cause.name === 'QuotaExceededError') throw new Error('O navegador ficou sem espaço. A gravação pausou; os passos pendentes continuam nesta aba.'); throw cause; } finally { signal?.removeEventListener('abort', cancel); }
  }
  private rows(tx: IDBTransaction): Promise<JournalEntry[]> { return request<unknown[]>(tx.objectStore('catalog').getAll()).then(rows => rows.map(entry)); }
  async list(): Promise<JournalEntry[]> { return this.tx(['catalog'], 'readonly', async tx => (await this.rows(tx)).sort((a, b) => b.createdAt - a.createdAt)); }
  async create(source: string, runtime: RuntimeSelection, details: TraceMetadata, owner: string, limits = { maxSteps: 20_000, maxFrames: 256 }, signal?: AbortSignal): Promise<JournalSnapshot> {
    signal?.throwIfAborted(); metadata(details); validateExecutionLimits(limits); text(source, MAX_SOURCE_CHARS); const program = compile(source, runtime), id = crypto.randomUUID(), createdAt = Date.now();
    const header: JournalSource = { ...details, id, createdAt, format: 'rewind-live', version: extendedLimits(limits) ? 2 : 1, vm: TRACE_VM, source, runtime, programHash: await digest(JSON.stringify(encode(program))), ...limits, initial: encode(initialState()) };
    const content = JSON.stringify(header), sourceHash = await digest(content), state = JSON.stringify(encode(initialState())), head: JournalHead = { version: 1, sourceHash, revision: 0, frontier: 0, cursor: 0, lastSeal: sourceHash, blocks: [], state, stateHash: await digest(state) }, headContent = JSON.stringify(head), headHash = await digest(headContent);
    const bytes = utf8Bytes(content) + utf8Bytes(headContent); requireTrace(bytes <= MAX_TRACE_BYTES, 'sessão excede 32 MiB');
    const row: JournalEntry = { id, createdAt, name: header.name, filename: header.filename, language: runtime.language, version: runtime.version, cursor: 0, count: 0, blocks: 0, bytes, revision: 0, sourceHash, headHash, owner, lease: Date.now() + WRITER_LEASE_MS };
    await this.tx(['catalog', 'sources', 'heads'], 'readwrite', async tx => { const rows = await this.rows(tx); if (rows.length >= this.maxEntries || rows.reduce((n, e) => n + e.bytes, bytes) > this.limit) throw new Error('Biblioteca de sessões cheia. Exclua uma sessão antes de iniciar outra.'); await request(tx.objectStore('sources').add({ id, content, checksum: sourceHash })); await request(tx.objectStore('heads').add({ id, content: headContent, checksum: headHash })); await request(tx.objectStore('catalog').add(row)); }, signal);
    return { entry: row, source: header, head, program };
  }
  async open(id: string, signal?: AbortSignal): Promise<JournalSnapshot> {
    const raw = await this.tx(['catalog', 'sources', 'heads'], 'readonly', async tx => { const e = entry(await request(tx.objectStore('catalog').get(id))), s = fields(await request(tx.objectStore('sources').get(id)), ['id', 'content', 'checksum']), h = fields(await request(tx.objectStore('heads').get(id)), ['id', 'content', 'checksum']); return { e, s, h }; }, signal);
    text(raw.s.content, MAX_TRACE_BYTES); text(raw.h.content, MAX_TRACE_BYTES); requireTrace(raw.s.id === id && raw.h.id === id && raw.s.checksum === raw.e.sourceHash && raw.h.checksum === raw.e.headHash && await digest(raw.s.content) === raw.e.sourceHash && await digest(raw.h.content) === raw.e.headHash, 'sessão ou checkpoint corrompido');
    const s = fields(JSON.parse(raw.s.content), ['id', 'createdAt', 'format', 'version', 'vm', 'name', 'filename', 'source', 'runtime', 'programHash', 'maxSteps', 'maxFrames', 'initial']);
    requireTrace(s.id === id && s.format === 'rewind-live' && (s.version === 1 || s.version === 2) && s.vm === TRACE_VM && s.createdAt === raw.e.createdAt, 'versão/identidade de sessão incompatível'); const details = metadata({ name: s.name, filename: s.filename }); text(s.source, MAX_SOURCE_CHARS); integer(s.maxSteps, 1, s.version === 2 ? MAX_EXECUTION_STEPS : LEGACY_MAX_STEPS); integer(s.maxFrames, 2, 256); const rt = fields(s.runtime, ['language', 'version']); text(rt.language, 20); text(rt.version, 20); const runtime = getRuntime(rt.language, rt.version), program = compile(s.source, runtime); requireTrace(same(decode(s.initial), initialState()) && s.programHash === await digest(JSON.stringify(encode(program))) && details.name === raw.e.name && details.filename === raw.e.filename && runtime.language === raw.e.language && runtime.version === raw.e.version, 'fonte/runtime/estado inicial não conferem');
    const h = fields(JSON.parse(raw.h.content), ['version', 'sourceHash', 'revision', 'frontier', 'cursor', 'lastSeal', 'blocks', 'state', 'stateHash']); requireTrace(h.version === 1 && h.sourceHash === raw.e.sourceHash && h.revision === raw.e.revision && h.frontier === raw.e.count && h.cursor === raw.e.cursor, 'fronteira durável não confere'); integer(h.frontier, 0, s.maxSteps); integer(h.cursor, 0, h.frontier); text(h.state, MAX_TRACE_BYTES); hash(h.stateHash); hash(h.lastSeal); requireTrace(await digest(h.state) === h.stateHash, 'checkpoint de fronteira corrompido'); validateMachineState(decode(JSON.parse(h.state)), program, s.maxFrames);
    requireTrace(Array.isArray(h.blocks) && h.blocks.length === raw.e.blocks, 'índice de blocos incompleto'); let first = 0, seal = raw.e.sourceHash, total = utf8Bytes(raw.s.content) + utf8Bytes(raw.h.content);
    for (const [index, block] of h.blocks.entries()) { const b = fields(block, ['index', 'first', 'count', 'bytes', 'checksum', 'previousSeal', 'seal']); integer(b.index, index, index); integer(b.first, first, first); integer(b.count, 1, LIVE_BLOCK_STEPS); integer(b.bytes, 2, MAX_TRACE_BYTES); hash(b.checksum); hash(b.seal); requireTrace((b.bytes <= LIVE_BLOCK_BYTES || b.count === 1) && b.previousSeal === seal && b.seal === await digest(JSON.stringify({ runId: id, index: b.index, first: b.first, count: b.count, bytes: b.bytes, checksum: b.checksum, previousSeal: b.previousSeal })), 'cadeia de selos interrompida'); first += b.count; seal = b.seal; total += b.bytes; }
    requireTrace(first === h.frontier && seal === h.lastSeal && total === raw.e.bytes && total <= MAX_TRACE_BYTES, 'tamanho/fronteira da sessão não confere'); signal?.throwIfAborted();
    return { entry: raw.e, source: { ...(s as unknown as JournalSource), runtime }, head: h as unknown as JournalHead, program };
  }
  async claim(snapshot: JournalSnapshot, owner: string): Promise<void> { await this.tx(['catalog'], 'readwrite', async tx => { const r = entry(await request(tx.objectStore('catalog').get(snapshot.entry.id))); if (r.revision !== snapshot.head.revision || r.owner !== owner && r.owner !== null && r.lease > Date.now()) throw new WriterConflictError(); await request(tx.objectStore('catalog').put({ ...r, owner, lease: Date.now() + WRITER_LEASE_MS })); }); }
  async renew(id: string, owner: string): Promise<void> { await this.tx(['catalog'], 'readwrite', async tx => { const r = entry(await request(tx.objectStore('catalog').get(id))); if (r.owner !== owner) throw new WriterConflictError(); await request(tx.objectStore('catalog').put({ ...r, lease: Date.now() + WRITER_LEASE_MS })); }); }
  async release(id: string, owner: string): Promise<void> { await this.tx(['catalog'], 'readwrite', async tx => { const r = entry(await request(tx.objectStore('catalog').get(id))); if (r.owner === owner) await request(tx.objectStore('catalog').put({ ...r, owner: null, lease: 0 })); }); }
  async readBlock(snapshot: JournalSnapshot, expected: JournalBlock, signal?: AbortSignal): Promise<unknown[]> {
    const b = fields(await this.tx(['blocks'], 'readonly', tx => request(tx.objectStore('blocks').get([snapshot.entry.id, expected.index])), signal), ['runId', 'index', 'first', 'count', 'bytes', 'checksum', 'previousSeal', 'seal', 'content']);
    text(b.content, MAX_TRACE_BYTES); requireTrace(b.runId === snapshot.entry.id && Object.entries(expected).every(([k, v]) => b[k] === v) && utf8Bytes(b.content) === expected.bytes && await digest(b.content) === expected.checksum, 'bloco de sessão corrompido'); const records: unknown = JSON.parse(b.content); requireTrace(Array.isArray(records) && records.length === expected.count, 'quantidade do bloco não confere'); signal?.throwIfAborted(); return records.map(r => decode(r, 2));
  }
  async prepare(snapshot: JournalSnapshot, records: readonly string[], state: MachineState, cursor: number): Promise<JournalCommit> {
    const content = `[${records.join(',')}]`; let block: JournalCommit['block']; const head = { ...snapshot.head, revision: snapshot.head.revision + 1, cursor, blocks: [...snapshot.head.blocks] };
    if (records.length) { const bytes = utf8Bytes(content), descriptor = { runId: snapshot.entry.id, index: head.blocks.length, first: head.frontier, count: records.length, bytes, checksum: await digest(content), previousSeal: head.lastSeal }; requireTrace(records.length <= LIVE_BLOCK_STEPS && (bytes <= LIVE_BLOCK_BYTES || records.length === 1), 'lote de gravação excede o limite'); block = { ...descriptor, seal: await digest(JSON.stringify(descriptor)), content }; const { runId: _id, content: _content, ...index } = block; head.blocks.push(index); head.frontier += records.length; head.lastSeal = block.seal; }
    head.state = JSON.stringify(encode(state)); head.stateHash = await digest(head.state); integer(cursor, 0, head.frontier); const headContent = JSON.stringify(head); return { head, block, content: headContent, checksum: await digest(headContent) };
  }
  async commit(snapshot: JournalSnapshot, owner: string, candidate: JournalCommit, signal?: AbortSignal): Promise<JournalEntry> {
    return this.tx(['catalog', 'heads', 'blocks', 'sources'], 'readwrite', async tx => {
      const rows = await this.rows(tx), r = rows.find(e => e.id === snapshot.entry.id); requireTrace(r, 'sessão excluída');
      if (r.revision === candidate.head.revision && r.headHash === candidate.checksum) return r; // Idempotent retry after an uncertain response.
      if (r.owner !== owner || r.lease <= Date.now() || r.revision !== snapshot.head.revision) throw new WriterConflictError();
      const source = fields(await request(tx.objectStore('sources').get(r.id)), ['id', 'content', 'checksum']); text(source.content, MAX_TRACE_BYTES);
      const bytes = utf8Bytes(source.content) + utf8Bytes(candidate.content) + candidate.head.blocks.reduce((n, b) => n + b.bytes, 0);
      if (bytes > MAX_TRACE_BYTES || rows.reduce((n, e) => n + (e.id === r.id ? bytes : e.bytes), 0) > this.limit) throw new Error('Orçamento de disco da sessão atingido. Os passos pendentes continuam nesta aba; exclua outra sessão ou abra o debugger completo para exportar.');
      const next: JournalEntry = { ...r, cursor: candidate.head.cursor, count: candidate.head.frontier, blocks: candidate.head.blocks.length, bytes, revision: candidate.head.revision, headHash: candidate.checksum, lease: Date.now() + WRITER_LEASE_MS };
      if (candidate.block) await request(tx.objectStore('blocks').add(candidate.block)); await request(tx.objectStore('heads').put({ id: r.id, content: candidate.content, checksum: candidate.checksum })); await request(tx.objectStore('catalog').put(next)); return next;
    }, signal);
  }
  async delete(id: string): Promise<void> { await this.tx(['catalog', 'sources', 'heads', 'blocks'], 'readwrite', async tx => { const raw = await request(tx.objectStore('catalog').get(id)); if (!raw) return; const r = entry(raw); if (r.owner !== null && r.lease > Date.now()) throw new Error('Feche a sessão em gravação antes de excluí-la.'); for (const store of ['catalog', 'sources', 'heads']) await request(tx.objectStore(store).delete(id)); const keys = await request(tx.objectStore('blocks').index('runId').getAllKeys(id)); await Promise.all(keys.map(k => request(tx.objectStore('blocks').delete(k)))); }); await this.validation.delete(id).catch(() => {}); await this.checkpoints.delete(id).catch(() => {}); }
  async close(): Promise<void> { const pending = this.database; this.database = null; if (pending) (await pending).close(); await this.validation.close(); await this.checkpoints.close(); }
}
