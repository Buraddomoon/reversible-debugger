import { decode, digest } from './portable-history';
import { utf8Bytes } from './history-blocks';
import { JOURNAL_VALIDATOR } from './journal-validation-cache';
import type { JournalSnapshot } from './recording-journal';
import { fields, integer, requireTrace, text, validateMachineState } from './trace-validation';

export interface JournalPoint { runId: string; cursor: number; sourceHash: string; seal: string; validator: string; bytes: number; checksum: string }
interface Run { id: string; sourceHash: string; bytes: number; stride: number; touched: number }
export interface JournalCheckpointOptions { maxDiskBytes?: number; maxRunBytes?: number; maxPoints?: number; interval?: number }
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

/** Recomputable seek accelerators. Only metadata is scanned; each lookup loads
 * one checkpoint. Quotas/thinning never remove deltas from the source journal. */
export class JournalCheckpoints {
  private database: Promise<IDBDatabase> | null = null;
  readonly diskLimit: number;
  readonly runLimit: number;
  readonly maxPoints: number;
  readonly interval: number;
  constructor(private readonly factory: IDBFactory, private readonly name: string, options: JournalCheckpointOptions = {}) {
    this.diskLimit = options.maxDiskBytes ?? 64 * 1024 * 1024; this.runLimit = options.maxRunBytes ?? 8 * 1024 * 1024;
    this.maxPoints = options.maxPoints ?? 128; this.interval = options.interval ?? 128;
    integer(this.diskLimit, 1, 64 * 1024 * 1024); integer(this.runLimit, 1, Math.min(this.diskLimit, 8 * 1024 * 1024)); integer(this.maxPoints, 1, 128); integer(this.interval, 1, 20_000);
  }
  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      const r = this.factory.open(this.name, 1); let abandoned = false;
      const fail = () => { abandoned = true; this.database = null; reject(new Error('Checkpoints de navegação indisponíveis; os deltas originais foram preservados.')); };
      r.onerror = fail; r.onblocked = fail;
      r.onupgradeneeded = () => { if (abandoned) { r.transaction?.abort(); return; } const db = r.result; db.createObjectStore('runs', { keyPath: 'id' }); db.createObjectStore('points', { keyPath: ['runId', 'cursor'] }).createIndex('runId', 'runId'); db.createObjectStore('states', { keyPath: ['runId', 'cursor'] }); };
      r.onsuccess = () => { const db = r.result; if (abandoned) { db.close(); return; } db.onversionchange = () => { db.close(); this.database = null; }; resolve(db); };
    }); return this.database;
  }
  private async tx<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await this.open(), tx = db.transaction(['runs', 'points', 'states'], mode);
    const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Checkpoint interrompido')); }); void done.catch(() => {});
    try { const result = await work(tx); await done; return result; } catch (cause) { try { tx.abort(); } catch { /* Already committed. */ } await done.catch(() => {}); throw cause; }
  }
  private async removePoint(tx: IDBTransaction, runId: string, cursor: number): Promise<void> { await request(tx.objectStore('points').delete([runId, cursor])); await request(tx.objectStore('states').delete([runId, cursor])); }
  private async removeRun(tx: IDBTransaction, id: string): Promise<void> {
    const points = await request<JournalPoint[]>(tx.objectStore('points').index('runId').getAll(id));
    for (const point of points) await this.removePoint(tx, id, point.cursor);
    await request(tx.objectStore('runs').delete(id));
  }
  async list(recording: JournalSnapshot): Promise<JournalPoint[]> {
    const points = await this.tx('readonly', tx => request<unknown[]>(tx.objectStore('points').index('runId').getAll(recording.entry.id)));
    requireTrace(points.length <= this.maxPoints, 'índice de checkpoints excede o limite');
    return points.map(raw => {
      const p = fields(raw, ['runId', 'cursor', 'sourceHash', 'seal', 'validator', 'bytes', 'checksum']);
      integer(p.cursor, 1, 20_000); integer(p.bytes, 1, this.runLimit); text(p.checksum, 64);
      requireTrace(p.runId === recording.entry.id && p.sourceHash === recording.entry.sourceHash && p.validator === JOURNAL_VALIDATOR && /^[a-f0-9]{64}$/.test(p.checksum), 'identidade de checkpoint incompatível');
      return p as unknown as JournalPoint;
    }).filter(p => p.cursor <= recording.head.frontier && recording.head.blocks.some(b => b.first + b.count === p.cursor && b.seal === p.seal)).sort((a, b) => a.cursor - b.cursor);
  }
  async read(recording: JournalSnapshot, point: JournalPoint) {
    const raw = await this.tx('readonly', tx => request(tx.objectStore('states').get([point.runId, point.cursor])));
    if (raw === undefined) return null;
    const row = fields(raw, ['runId', 'cursor', 'content']); text(row.content, this.runLimit);
    requireTrace(row.runId === recording.entry.id && row.cursor === point.cursor && point.sourceHash === recording.entry.sourceHash && point.validator === JOURNAL_VALIDATOR && recording.head.blocks.some(b => b.first + b.count === point.cursor && b.seal === point.seal), 'checkpoint fora da cadeia atual');
    requireTrace(utf8Bytes(row.content) === point.bytes && await digest(row.content) === point.checksum, 'checkpoint de navegação corrompido');
    const state = decode(JSON.parse(row.content)); validateMachineState(state, recording.program, recording.source.maxFrames); return state;
  }
  async put(recording: JournalSnapshot, cursor: number, content: string): Promise<void> {
    const block = recording.head.blocks.find(b => b.first + b.count === cursor);
    if (!block || cursor < this.interval) return;
    const bytes = utf8Bytes(content); if (bytes > this.runLimit) throw new Error('Estado excede a quota de checkpoints; a navegação continua pelos deltas.');
    const checksum = await digest(content), point: JournalPoint = { runId: recording.entry.id, cursor, sourceHash: recording.entry.sourceHash, seal: block.seal, validator: JOURNAL_VALIDATOR, bytes, checksum };
    await this.tx('readwrite', async tx => {
      const runs = await request<Run[]>(tx.objectStore('runs').getAll()), previous = runs.find(r => r.id === point.runId);
      if (previous && previous.sourceHash !== point.sourceHash) await this.removeRun(tx, point.runId);
      let points = await request<JournalPoint[]>(tx.objectStore('points').index('runId').getAll(point.runId)); points.sort((a, b) => a.cursor - b.cursor);
      let stride = previous?.sourceHash === point.sourceHash ? previous.stride : this.interval;
      if (cursor - (points.at(-1)?.cursor ?? 0) < stride) return;
      points.push(point); let runBytes = points.reduce((sum, p) => sum + p.bytes, 0);
      while (points.length > this.maxPoints || runBytes > this.runLimit) {
        stride *= 2;
        // Keep the newest point and spread the others. The origin is implicit.
        const keep = points.filter((_, i) => (points.length - 1 - i) % 2 === 0);
        for (const p of points) if (!keep.includes(p)) await this.removePoint(tx, p.runId, p.cursor);
        points = keep; runBytes = points.reduce((sum, p) => sum + p.bytes, 0);
      }
      let total = runs.reduce((sum, r) => sum + (r.id === point.runId ? 0 : r.bytes), runBytes), count = runs.filter(r => r.id !== point.runId).length + 1;
      for (const old of runs.filter(r => r.id !== point.runId).sort((a, b) => a.touched - b.touched || a.id.localeCompare(b.id))) {
        if (total <= this.diskLimit && count <= 16) break;
        await this.removeRun(tx, old.id); total -= old.bytes; count--;
      }
      await request(tx.objectStore('points').put(point)); await request(tx.objectStore('states').put({ runId: point.runId, cursor, content }));
      await request(tx.objectStore('runs').put({ id: point.runId, sourceHash: point.sourceHash, bytes: runBytes, stride, touched: Date.now() } satisfies Run));
    });
  }
  async delete(id: string): Promise<void> { await this.tx('readwrite', tx => this.removeRun(tx, id)); }
  async close(): Promise<void> { const pending = this.database; this.database = null; if (pending) (await pending).close(); }
}
