import { compile, type Program } from './compiler';
import { CheckpointCache, INDEX_BYTES_PER_RUN, type CachedIndex, type CheckpointDescriptor } from './checkpoint-cache';
import { ExecutionLibrary, type StoredRecording } from './execution-library';
import { recordingYield, SeekSupersededError, type RecordingJob } from './debugger';
import { freezePayload, HistoryBudgetError, validateHistoryBudget } from './history';
import { historyEvent, type HistoryEvent } from './history-events';
import { applyChange, applyStep, initialState, type Change, type DeepReadonly, type MachineState, type Step } from './machine';
import { getRuntime } from './runtime';
import { decode, digest, encode } from './portable-history';
import { utf8Bytes } from './history-blocks';
import { accountStep, encodedBytes, measureMachine } from './storage-accounting';
import { fields, integer, requireTrace, same, text, restoreValidatedStep, validateMachineState } from './trace-validation';

export const DEFAULT_BLOCK_CACHE_BYTES = 2 * 1024 * 1024;
export interface ReplayIndex { version: 1; runId: string; sourceChecksum: string; count: number; maxMachineBytes: number; maxStepBytes: number; events: HistoryEvent[]; checkpoints: CheckpointDescriptor[] }
export interface PagedCacheStats { bytes: number; limitBytes: number; blocks: number; hits: number; reads: number; evictions: number; largeBlocks: number; indexBytes: number; reservedMachineBytes: number; estimatedBytes: number; limitTotalBytes: number; checkpoints: number; indexBuilt: boolean }
export interface PagedSeekProgress { from: number; to: number; cursor: number; completed: number; total: number }
export interface PagedPreparedState { state: DeepReadonly<MachineState>; cursor: number; lastStep: DeepReadonly<Step> | null }
export interface PagedSeekJob extends RecordingJob { onSeekProgress?: (progress: PagedSeekProgress) => void; beforePublish?: (prepared: PagedPreparedState) => Promise<void> }
export interface PagedOptions { maxHistoryBytes?: number; cacheBytes?: number }
interface BlockCacheEntry { records: readonly DeepReadonly<Step>[]; bytes: number }

async function validateIndex(cached: CachedIndex, recording: StoredRecording): Promise<ReplayIndex> {
  requireTrace(utf8Bytes(cached.content) <= INDEX_BYTES_PER_RUN && await digest(cached.content) === cached.checksum, 'índice de checkpoints corrompido');
  const raw = fields(JSON.parse(cached.content), ['version', 'runId', 'sourceChecksum', 'count', 'maxMachineBytes', 'maxStepBytes', 'events', 'checkpoints']);
  requireTrace(raw.version === 1 && raw.runId === recording.entry.id && raw.sourceChecksum === recording.checksum && raw.count === recording.entry.count, 'identidade do índice auxiliar não confere'); integer(raw.maxMachineBytes, 1, 256 * 1024 * 1024);
  integer(raw.maxStepBytes, 0, 32 * 1024 * 1024);
  requireTrace(Array.isArray(raw.events) && raw.events.length <= recording.entry.count && Array.isArray(raw.checkpoints) && raw.checkpoints.length <= 128, 'índice excede os limites');
  let prior = 0;
  for (const event of raw.events) { const e = fields(event, ['cursor', 'kind', 'line', 'description']); integer(e.cursor, prior + 1, recording.entry.count); prior = e.cursor; integer(e.line, 1, 1_000_001); text(e.description, 240); requireTrace(['call', 'return', 'mutation', 'decision', 'output', 'error', 'end'].includes(String(e.kind)), 'evento desconhecido'); }
  prior = 0;
  for (const point of raw.checkpoints) { const p = fields(point, ['cursor', 'bytes', 'checksum']); integer(p.cursor, prior + 1, recording.entry.count); prior = p.cursor; integer(p.bytes, 1, 8 * 1024 * 1024); text(p.checksum, 64); requireTrace(/^[a-f0-9]{64}$/.test(p.checksum), 'hash de checkpoint inválido'); }
  return raw as unknown as ReplayIndex;
}

/** Async store with one published VM, private atomic seek, and LRU deltas.
 * It deliberately exposes no full Step[]; UI uses a persisted event index. */
export class PagedHistoryStore {
  readonly program: Program;
  readonly recording: StoredRecording;
  readonly index: ReplayIndex;
  private machine = initialState();
  private position = 0;
  private cache = new Map<number, BlockCacheEntry>();
  private cacheSize = 0;
  private hits = 0;
  private reads = 0;
  private evictions = 0;
  private largeBlocks = 0;
  private epoch = 0;
  private cacheLimit: number;
  private readonly limit: number;
  private readonly indexSize: number;
  private currentStep: DeepReadonly<Step> | null = null;
  private constructor(private readonly library: ExecutionLibrary, private readonly checkpoints: CheckpointCache, recording: StoredRecording, index: ReplayIndex, private readonly cached: CachedIndex, private readonly built: boolean, options: PagedOptions) {
    this.recording = recording; this.index = index; this.program = compile(recording.manifest.header.source, getRuntime(recording.entry.language, recording.entry.version));
    this.limit = options.maxHistoryBytes ?? 64 * 1024 * 1024; validateHistoryBudget(this.limit); this.indexSize = utf8Bytes(cached.content);
    const available = this.limit - index.maxMachineBytes * 2 - index.maxStepBytes - this.indexSize;
    if (available < 1) throw new HistoryBudgetError(this.limit, index.maxMachineBytes * 2 + index.maxStepBytes + this.indexSize + 1);
    this.cacheLimit = Math.min(options.cacheBytes ?? DEFAULT_BLOCK_CACHE_BYTES, available); this.validateCacheLimit(this.cacheLimit);
  }
  static async open(library: ExecutionLibrary, checkpoints: CheckpointCache, id: string, options: PagedOptions = {}, job: PagedSeekJob = {}): Promise<PagedHistoryStore> {
    job.signal?.throwIfAborted();
    const recording = await library.openRecording(id, job.signal), key = `${id}:${recording.checksum}`;
    let cached = await checkpoints.find(key), built = false;
    if (!cached) { cached = await PagedHistoryStore.buildIndex(library, checkpoints, recording, key, options, job); built = true; }
    const index = await validateIndex(cached, recording); job.signal?.throwIfAborted();
    const store = new PagedHistoryStore(library, checkpoints, recording, index, cached, built, options);
    await store.seek(recording.entry.cursor, job); return store;
  }
  private static async buildIndex(library: ExecutionLibrary, cache: CheckpointCache, recording: StoredRecording, key: string, options: PagedOptions, job: RecordingJob): Promise<CachedIndex> {
    const program = compile(recording.manifest.header.source, getRuntime(recording.entry.language, recording.entry.version)), state = initialState();
    const index: ReplayIndex = { version: 1, runId: recording.entry.id, sourceChecksum: recording.checksum, count: recording.entry.count, maxMachineBytes: measureMachine(state).totalBytes, maxStepBytes: 0, events: [], checkpoints: [] };
    const limit = options.maxHistoryBytes ?? 64 * 1024 * 1024; validateHistoryBudget(limit);
    const token = await cache.begin(key); let committed = false, cursor = 0, eventBytes = 0, payload = measureMachine(state);
    const stride = Math.max(1, Math.ceil(recording.manifest.blocks.length / 127));
    try {
      for (const block of recording.manifest.blocks) {
        job.signal?.throwIfAborted();
        if (block.first > 0 && block.index % stride === 0) { const point = await cache.checkpoint(token, block.first, JSON.stringify(encode(state))); if (point) index.checkpoints.push(point); }
        const records = await library.readBlock(recording, block, job.signal);
        let started = performance.now();
        for (const raw of records) {
          const step = restoreValidatedStep(state, program, raw, recording.manifest.header.limits.maxFrames); cursor++;
          // During first validation, keep no previously decoded block or deltas.
          payload = accountStep(payload, step, 'forward');
          index.maxMachineBytes = Math.max(index.maxMachineBytes, payload.totalBytes);
          index.maxStepBytes = Math.max(index.maxStepBytes, encodedBytes(step));
          const event = historyEvent(step, cursor);
          if (event) { const compact = { ...event, description: event.description.slice(0, 240) }; eventBytes += encodedBytes(compact) + 1; requireTrace(eventBytes <= INDEX_BYTES_PER_RUN / 2, 'eventos excedem o orçamento do índice'); index.events.push(compact); }
          if (index.maxMachineBytes * 2 + block.bytes + eventBytes > limit) throw new HistoryBudgetError(limit, index.maxMachineBytes * 2 + block.bytes + eventBytes);
          if (cursor % 16 === 0 || performance.now() - started >= 6) { job.onProgress?.(cursor, index.count); await recordingYield(job); started = performance.now(); }
        }
      }
      if (cursor > 0) { const point = await cache.checkpoint(token, cursor, JSON.stringify(encode(state))); if (point) index.checkpoints.push(point); }
      requireTrace(cursor === recording.entry.count, 'indexação incompleta'); job.signal?.throwIfAborted();
      const result = await cache.publish(token, JSON.stringify(index)); committed = true; return result;
    } finally { if (!committed) await cache.discard(token).catch(() => {}); }
  }
  get state(): DeepReadonly<MachineState> { return this.machine; }
  get cursor(): number { return this.position; }
  get count(): number { return this.recording.entry.count; }
  get lastStep(): DeepReadonly<Step> | null { return this.currentStep; }
  get stats(): PagedCacheStats { return { bytes: this.cacheSize, limitBytes: this.cacheLimit, blocks: this.cache.size, hits: this.hits, reads: this.reads, evictions: this.evictions, largeBlocks: this.largeBlocks, indexBytes: this.indexSize, reservedMachineBytes: this.index.maxMachineBytes * 2 + this.index.maxStepBytes, estimatedBytes: this.cacheSize + this.indexSize + this.index.maxMachineBytes * 2 + this.index.maxStepBytes, limitTotalBytes: this.limit, checkpoints: this.index.checkpoints.length, indexBuilt: this.built }; }
  private validateCacheLimit(bytes: number): void { if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 8 * 1024 * 1024) throw new Error('Cache de deltas deve ter de 1 byte a 8 MiB'); }
  setCacheBudget(bytes: number): void {
    this.validateCacheLimit(bytes); const available = this.limit - this.index.maxMachineBytes * 2 - this.indexSize - this.index.maxStepBytes;
    if (bytes > available) throw new HistoryBudgetError(this.limit, bytes + this.index.maxMachineBytes * 2 + this.indexSize);
    this.cancel(); this.cacheLimit = bytes; this.evictUntil(0);
  }
  cancel(): void { this.epoch++; }
  private evictUntil(extra: number): void { while (this.cache.size && this.cacheSize + extra > this.cacheLimit) { const first = this.cache.keys().next().value!; this.cacheSize -= this.cache.get(first)!.bytes; this.cache.delete(first); this.evictions++; } }
  private check(epoch: number, job: RecordingJob): void { job.signal?.throwIfAborted(); if (epoch !== this.epoch) throw new SeekSupersededError(); }
  private blockAt(index: number): number {
    const blocks = this.recording.manifest.blocks; let low = 0, high = blocks.length;
    while (low < high) { const mid = (low + high) >>> 1; if (blocks[mid]!.first <= index) low = mid + 1; else high = mid; } return low - 1;
  }
  private async block(index: number, epoch: number, job: RecordingJob): Promise<readonly DeepReadonly<Step>[]> {
    this.check(epoch, job); const stored = this.cache.get(index);
    if (stored) { this.hits++; this.cache.delete(index); this.cache.set(index, stored); return stored.records; }
    const descriptor = this.recording.manifest.blocks[index]!;
    if (descriptor.bytes + this.indexSize + this.index.maxMachineBytes * 2 + this.index.maxStepBytes > this.limit) throw new HistoryBudgetError(this.limit, descriptor.bytes + this.indexSize + this.index.maxMachineBytes * 2 + this.index.maxStepBytes);
    this.evictUntil(descriptor.bytes); const raw = await this.library.readBlock(this.recording, descriptor, job.signal); this.check(epoch, job); this.reads++;
    const records = freezePayload(raw as Step[]);
    if (descriptor.bytes <= this.cacheLimit) { this.cache.set(index, { records, bytes: descriptor.bytes }); this.cacheSize += descriptor.bytes; } else this.largeBlocks++;
    return records;
  }
  async seek(target: number, job: PagedSeekJob = {}): Promise<void> {
    integer(target, 0, this.count); job.signal?.throwIfAborted(); const epoch = ++this.epoch, from = this.position;
    let state = structuredClone(this.machine), cursor = from;
    const nearest = this.index.checkpoints.reduce<CheckpointDescriptor | null>((best, p) => Math.abs(p.cursor - target) < Math.abs((best?.cursor ?? 0) - target) ? p : best, null);
    const checkpointCursor = nearest?.cursor ?? 0;
    if (Math.abs(target - checkpointCursor) < Math.abs(target - cursor)) {
      const content = nearest ? await this.checkpoints.readCheckpoint(this.cached.token, nearest) : null; this.check(epoch, job);
      if (content !== null) { const decoded = decode(JSON.parse(content)); validateMachineState(decoded, this.program, this.recording.manifest.header.limits.maxFrames); requireTrace(measureMachine(decoded).totalBytes <= this.index.maxMachineBytes, 'checkpoint excede a reserva do estado'); state = decoded; cursor = checkpointCursor; }
      else { state = initialState(); cursor = 0; }
    }
    const total = Math.abs(target - cursor); let completed = 0, last: DeepReadonly<Step> | null = null;
    job.onSeekProgress?.({ from, to: target, cursor, completed, total });
    while (cursor !== target) {
      this.check(epoch, job); const forward = cursor < target, index = forward ? cursor : cursor - 1, blockId = this.blockAt(index);
      const records = await this.block(blockId, epoch, job), first = this.recording.manifest.blocks[blockId]!.first;
      let started = performance.now(), processed = 0;
      while (cursor !== target && (forward ? cursor : cursor - 1) >= first && (forward ? cursor : cursor - 1) < first + records.length) {
        this.check(epoch, job); const step = records[(forward ? cursor : cursor - 1) - first]!;
        if (forward) restoreValidatedStep(state, this.program, step, this.recording.manifest.header.limits.maxFrames);
        else {
          // Check the reverse splice against the current state, without copying the VM per instruction.
          for (const c of [...step.changes].reverse()) {
            if (c.kind === 'control') requireTrace(same(state.control, c.after), 'controle posterior inconsistente');
            else if (c.kind === 'binding') { const f = state.frames.find(f => f.id === c.frameId); requireTrace(f && same(Object.hasOwn(f.locals, c.name) ? { exists: true, value: f.locals[c.name] } : { exists: false }, c.after), 'binding posterior inconsistente'); }
            else if (c.kind === 'heap-allocation') requireTrace(same(state.heap[c.id], c.object), 'alocação posterior inconsistente');
            else if (c.kind === 'heap-splice') requireTrace(state.heap[c.id] && same(state.heap[c.id]!.items.slice(c.index, c.index + c.added.length), c.added), 'heap posterior inconsistente');
            else { const list = c.kind === 'frames' ? state.frames : c.kind === 'output' ? state.output : state.operands; requireTrace(same(list.slice(c.index, c.index + c.added.length), c.added), 'splice posterior inconsistente'); }
            applyChange(state, c as Change, 'backward');
          }
          restoreValidatedStep(state, this.program, step, this.recording.manifest.header.limits.maxFrames); applyStep(state, step, 'backward');
        }
        cursor += forward ? 1 : -1; completed++; processed++;
        if (processed === 16 || performance.now() - started >= 6) { job.onSeekProgress?.({ from, to: target, cursor, completed, total }); await recordingYield(job); this.check(epoch, job); processed = 0; started = performance.now(); }
      }
    }
    if (target > 0) { const id = this.blockAt(target - 1), records = await this.block(id, epoch, job); last = records[target - 1 - this.recording.manifest.blocks[id]!.first]!; }
    this.check(epoch, job);
    const extra = last ? encodedBytes(last) : 0; if (this.index.maxMachineBytes * 2 + this.indexSize + extra > this.limit) throw new HistoryBudgetError(this.limit, this.index.maxMachineBytes * 2 + this.indexSize + extra);
    while (this.cache.size && this.cacheSize + this.index.maxMachineBytes * 2 + this.indexSize + extra > this.limit) { const oldest = this.cache.keys().next().value!; this.cacheSize -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest); this.evictions++; }
    // Worker clients confirm the prepared state before commit. Cancellation can
    // still win while the UI is receiving/inspecting the response.
    await job.beforePublish?.({ state, cursor: target, lastStep: last }); this.check(epoch, job);
    this.machine = state; this.position = target; this.currentStep = last;
    job.onSeekProgress?.({ from, to: target, cursor, completed, total });
  }
  dispose(): void { this.cancel(); this.cache.clear(); this.cacheSize = 0; this.currentStep = null; }
}
